/**
 * SSE fan-out across Deno Deploy isolates.
 *
 * Deno Deploy runs many isolates. The operator's POST and the display's open SSE
 * stream routinely land on different ones, so a purely in-process subscriber
 * registry delivers to the wrong isolate and drops the event silently.
 * BroadcastChannel is the bus between them.
 * @module
 */
import { toSvg } from "./qr.js";
import { formatOre } from "../public/shared/money.js";

/**
 * @param {ReturnType<import("./store.js").createStore>} store
 * @param {{channelName?: string}} [options]
 */
export function createHub(store, { channelName = "room-events" } = {}) {
  /** @type {Map<string, Set<(name: string, data: object) => void>>} */
  const local = new Map();
  const channel = new BroadcastChannel(channelName);

  /**
   * Attach the rendered QR and amount text. KV stores only the payload/total
   * because rendering is deterministic, so any isolate reproduces identical
   * output. The display page (Task 11) draws `svg` and `amountText` and runs
   * no payment logic of its own.
   * @param {object} roomState
   */
  function render(roomState) {
    if (roomState.state !== "charge") return { ...roomState };
    return {
      ...roomState,
      svg: toSvg(roomState.payload),
      amountText: formatOre(roomState.totalOre),
    };
  }

  /**
   * @param {string} roomId
   * @param {string} name
   * @param {object} data
   */
  function deliverLocally(roomId, name, data) {
    const subscribers = local.get(roomId);
    if (!subscribers) return;
    for (const send of subscribers) {
      // One dead client must not block the others: a browser that vanished
      // mid-write throws here, and the next subscriber still deserves the event.
      try {
        send(name, data);
      } catch {
        // The stream's own cancel handler removes it from the set.
      }
    }
  }

  channel.onmessage = (event) => {
    const { roomId, name, data } = event.data;
    deliverLocally(roomId, name, data);
  };

  return {
    render,

    /**
     * Sends the current state immediately, then every subsequent one.
     * @param {string} roomId
     * @param {(name: string, data: object) => void} onEvent
     * @returns {Promise<() => void>} unsubscribe
     */
    async subscribe(roomId, onEvent) {
      let subscribers = local.get(roomId);
      if (!subscribers) {
        subscribers = new Set();
        local.set(roomId, subscribers);
      }

      // Added before the replay read below (not after), so a publish that
      // lands while that read is in flight is never missed. That ordering
      // creates its own race, tracked here: if a live "state" event is
      // delivered to this subscriber while the read is still pending, it is
      // already at least as new as whatever the read eventually returns (the
      // read started after that publish had already persisted its state), so
      // the stale replay must be skipped rather than delivered after it and
      // walking the display back to an older screen.
      let liveStateDelivered = false;
      const deliver = (name, data) => {
        if (name === "state") liveStateDelivered = true;
        onEvent(name, data);
      };
      subscribers.add(deliver);

      // Replay on connect. SSE reconnects automatically, but a push-only server
      // would deliver nothing on reconnect and leave a blank screen in front of a
      // customer who is mid-scan.
      const current = await store.getCurrent(roomId);
      if (!liveStateDelivered) {
        try {
          onEvent("state", render(current));
        } catch {
          // Ignore: the caller's stream is already gone.
        }
      }

      return () => {
        const set = local.get(roomId);
        if (!set) return;
        set.delete(deliver);
        if (set.size === 0) local.delete(roomId);
      };
    },

    /**
     * @param {string} roomId
     * @param {object} roomState
     * @param {{live?: object}} [options] `live` fields go to open streams only and
     *   are never stored, so a later replay-on-connect cannot resend them.
     */
    async publish(roomId, roomState, { live = {} } = {}) {
      await store.setCurrent(roomId, roomState);
      const data = { ...render(roomState), ...live };
      // Post AND deliver locally: a BroadcastChannel never delivers a message
      // back to the object that posted it. Verified, not assumed.
      channel.postMessage({ roomId, name: "state", data });
      deliverLocally(roomId, "state", data);
    },

    close() {
      channel.close();
      local.clear();
    },
  };
}

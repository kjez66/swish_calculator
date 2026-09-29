import { assertEquals } from "@std/assert";
import { createStore } from "../src/store.js";
import { createHub } from "../src/hub.js";
import { formatOre } from "../public/shared/money.js";

async function withHub(fn) {
  const kv = await Deno.openKv(":memory:");
  const store = createStore(kv);
  const hub = createHub(store, { channelName: `test-${crypto.randomUUID()}` });
  try {
    await fn(hub, store);
  } finally {
    hub.close();
    kv.close();
  }
}

const CHARGE = {
  state: "charge",
  orderNo: 7,
  totalOre: 24900,
  message: "Kaffebaren #7",
  payload: "C0701234567;249.00;Kaffebaren #7;0",
  updatedAt: 1000,
};

Deno.test("subscribing immediately replays the current state", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push({ name, data }));

    // This replay is what makes an SSE reconnect invisible instead of fatal:
    // without it a reconnecting display shows a blank welcome screen mid-scan.
    assertEquals(events.length, 1);
    assertEquals(events[0].name, "state");
    assertEquals(events[0].data.state, "idle");
    off();
  });
});

Deno.test("a subscriber joining after a charge sees the charge, not idle", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    await hub.publish(roomId, CHARGE);

    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push({ name, data }));
    assertEquals(events[0].data.state, "charge");
    assertEquals(events[0].data.orderNo, 7);
    off();
  });
});

Deno.test("publish fans out locally, because a channel never echoes to its poster", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push({ name, data }));
    events.length = 0; // drop the replay

    await hub.publish(roomId, CHARGE);
    assertEquals(events.length, 1);
    assertEquals(events[0].data.orderNo, 7);
    off();
  });
});

Deno.test("published events carry a rendered SVG and amount text", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (_name, data) => events.push(data));
    events.length = 0;

    await hub.publish(roomId, CHARGE);
    assertEquals(events[0].svg.startsWith("<svg"), true);
    // A screen reader hears what the code is for, not just "image".
    assertEquals(
      events[0].svg.includes(
        `aria-label="Swish QR-kod för ${formatOre(CHARGE.totalOre)} kr"`,
      ),
      true,
    );
    assertEquals(events[0].amountText, formatOre(CHARGE.totalOre));
    off();
  });
});

Deno.test("idle state carries no svg or amountText", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (_name, data) => events.push(data));

    assertEquals(events[0].state, "idle");
    assertEquals("svg" in events[0], false);
    assertEquals("amountText" in events[0], false);
    off();
  });
});

Deno.test("publish persists state so a later isolate can replay it", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    await hub.publish(roomId, CHARGE);
    assertEquals((await store.getCurrent(roomId)).orderNo, 7);
  });
});

Deno.test("events reach every subscriber of a room and no others", async () => {
  await withHub(async (hub, store) => {
    const a = await store.createRoom();
    const b = await store.createRoom();
    const aEvents = [];
    const bEvents = [];
    const offA1 = await hub.subscribe(a.roomId, (_n, d) => aEvents.push(d));
    const offA2 = await hub.subscribe(a.roomId, (_n, d) => aEvents.push(d));
    const offB = await hub.subscribe(b.roomId, (_n, d) => bEvents.push(d));
    aEvents.length = 0;
    bEvents.length = 0;

    await hub.publish(a.roomId, CHARGE);
    assertEquals(aEvents.length, 2);
    assertEquals(bEvents.length, 0);
    offA1();
    offA2();
    offB();
  });
});

Deno.test("unsubscribing stops delivery", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (_n, d) => events.push(d));
    off();
    events.length = 0;
    await hub.publish(roomId, CHARGE);
    assertEquals(events.length, 0);
  });
});

Deno.test("a publish landing during the replay read is not overwritten by the stale replay", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();

    // Gate store.getCurrent so the test controls exactly when subscribe's
    // replay read resolves, and can force a publish to land while it is
    // still in flight.
    let releaseGate;
    const gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    const originalGetCurrent = store.getCurrent.bind(store);
    store.getCurrent = async (id) => {
      await gate;
      return originalGetCurrent(id);
    };

    const events = [];
    const subscribePromise = hub.subscribe(
      roomId,
      (name, data) => events.push({ name, data }),
    );

    // subscribe() has already registered the subscriber synchronously above
    // (before its first await), so this publish is delivered live while the
    // gated read is still pending.
    await hub.publish(roomId, CHARGE);
    releaseGate();
    const off = await subscribePromise;

    // Only the live charge event should be observed: the now-stale idle
    // replay must be skipped rather than delivered after it and walking the
    // subscriber back to an older screen.
    assertEquals(events.length, 1);
    assertEquals(events[0].data.state, "charge");
    assertEquals(events[0].data.orderNo, 7);
    off();
  });
});

Deno.test("a throwing subscriber does not stop the others", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const good = [];
    const offBad = await hub.subscribe(roomId, () => {
      throw new Error("client went away mid-write");
    });
    const offGood = await hub.subscribe(roomId, (_n, d) => good.push(d));
    good.length = 0;

    await hub.publish(roomId, CHARGE);
    assertEquals(good.length, 1);
    offBad();
    offGood();
  });
});

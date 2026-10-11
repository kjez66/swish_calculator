/**
 * Every Deno KV read and write.
 *
 * Nothing here may be cached in a module-level variable: Deno Deploy runs many
 * isolates and any such cache would be per-isolate and wrong.
 * @module
 */
import { hashToken, randomPairCode, randomToken, safeEqual } from "./tokens.js";
import { stockholmDate } from "./dates.js";
import { defaultProducts } from "./defaults.js";

export { stockholmDate };

const PAIR_CODE_TTL_MS = 5 * 60_000;
const CHARGE_RECORD_TTL_MS = 120_000;
const PRESENCE_TTL_MS = 30_000;
const RATE_WINDOW_TTL_MS = 120_000;
const TICKET_TTL_MS = 30_000;
/** The sales log keeps a sale 31 days, then KV deletes it. */
const SALE_TTL_MS = 31 * 24 * 60 * 60_000;

/**
 * @param {Deno.Kv} kv
 * @param {{randomPairCode?: () => string}} [deps] Test-only seam: lets a test
 *   inject a deterministic code generator to exercise createPairCode's
 *   collision retry without seeding the full 10^6-value space. Callers other
 *   than tests should call `createStore(kv)` and get the real generator.
 */
export function createStore(kv, { randomPairCode: drawPairCode = randomPairCode } = {}) {
  /**
   * @param {string} roomId
   * @returns {Promise<{createdAt:number, operatorTokenHash:string, displayTokenHashes:string[]}|null>}
   */
  async function getRoom(roomId) {
    return (await kv.get(["room", roomId])).value;
  }

  /**
   * Versionstamp-checked read-modify-write: get the entry, add 1, commit under a
   * check on the read versionstamp, retry on conflict. Used for the order
   * counter and the rate limiter so concurrent callers never observe the same
   * post-increment value (which `atomic().sum()` followed by a separate `get()`
   * cannot guarantee: several callers can read the same post-sum value).
   * @param {Deno.KvKey} key
   * @param {{expireIn?: number}} [options]
   * @returns {Promise<number>}
   */
  async function increment(key, options) {
    while (true) {
      const entry = await kv.get(key);
      const next = (entry.value ?? 0) + 1;
      const res = await kv.atomic()
        .check(entry)
        .set(key, next, options)
        .commit();
      if (res.ok) return next;
    }
  }

  return {
    async createRoom() {
      const roomId = crypto.randomUUID();
      const operatorToken = randomToken();
      const products = defaultProducts();
      await kv.atomic()
        .set(["room", roomId], {
          createdAt: Date.now(),
          operatorTokenHash: await hashToken(operatorToken),
          displayTokenHashes: [],
        })
        .set(["room", roomId, "products"], products)
        .commit();
      return { roomId, operatorToken };
    },

    /**
     * @returns {Promise<"operator"|"display"|null>}
     */
    async authenticate(roomId, token) {
      if (!roomId || !token) return null;
      const room = await getRoom(roomId);
      if (!room) return null;
      const hash = await hashToken(token);
      if (safeEqual(hash, room.operatorTokenHash)) return "operator";
      for (const h of room.displayTokenHashes) {
        if (safeEqual(hash, h)) return "display";
      }
      return null;
    },

    async getSettings(roomId) {
      return (await kv.get(["room", roomId, "settings"])).value;
    },

    async setSettings(roomId, settings) {
      await kv.set(["room", roomId, "settings"], settings);
    },

    async getProducts(roomId) {
      return (await kv.get(["room", roomId, "products"])).value ?? [];
    },

    async setProducts(roomId, products) {
      await kv.set(["room", roomId, "products"], products);
    },

    async getCurrent(roomId) {
      return (await kv.get(["room", roomId, "current"])).value ?? { state: "idle" };
    },

    async setCurrent(roomId, state) {
      await kv.set(["room", roomId, "current"], state);
    },

    /**
     * @param {string} roomId
     * @param {Date} date
     * @returns {Promise<number>}
     */
    async nextOrderNo(roomId, date) {
      const key = ["room", roomId, "counter", stockholmDate(date)];
      return await increment(key);
    },

    /**
     * Remember what the charge on screen is for, until Klar or Avbryt. Kept out
     * of `current`, which goes to the customer display. A newer charge simply
     * replaces an abandoned one.
     * @param {string} roomId
     * @param {{orderNo: number, date: string, totalOre: number, lines: object[],
     *   chargedAt: number}} sale
     */
    async openSale(roomId, sale) {
      await kv.set(["room", roomId, "open-sale"], sale);
    },

    /**
     * End the open sale for the charge with `orderNo`. Paid, it is saved under
     * its charge date; either way it is gone afterwards. The check on the open
     * sale's versionstamp makes a repeated Klar save it at most once.
     * @param {string} roomId
     * @param {number} orderNo the order number of the charge on screen
     * @param {{paid: boolean, paidAt: number}} outcome
     * @returns {Promise<boolean>} whether a sale was saved
     */
    async closeSale(roomId, orderNo, { paid, paidAt }) {
      const key = ["room", roomId, "open-sale"];
      const entry = await kv.get(key);
      const sale = entry.value;
      if (!sale || sale.orderNo !== orderNo) return false;
      const op = kv.atomic().check(entry).delete(key);
      if (paid) {
        op.set(["room", roomId, "sale", sale.date, sale.orderNo], { ...sale, paidAt }, {
          expireIn: SALE_TTL_MS,
        });
      }
      return (await op.commit()).ok && paid;
    },

    /**
     * Undo a Klar pressed by mistake.
     * @param {string} roomId
     * @param {string} date YYYY-MM-DD, Stockholm time
     * @param {number} orderNo
     * @returns {Promise<boolean>} whether there was such a sale
     */
    async deleteSale(roomId, date, orderNo) {
      const key = ["room", roomId, "sale", date, orderNo];
      const entry = await kv.get(key);
      if (!entry.value) return false;
      // Checked, so two taps on two phones report one removal, not two.
      return (await kv.atomic().check(entry).delete(key).commit()).ok;
    },

    /**
     * @param {string} roomId
     * @param {string} date YYYY-MM-DD, Stockholm time
     * @param {number} [now] epoch ms
     * @returns {Promise<object[]>} in order-number order
     */
    async listSales(roomId, date, now = Date.now()) {
      const sales = [];
      for await (const entry of kv.list({ prefix: ["room", roomId, "sale", date] })) {
        // KV removes an expired entry only eventually; it must not show meanwhile.
        if (entry.value.paidAt > now - SALE_TTL_MS) sales.push(entry.value);
      }
      return sales;
    },

    /**
     * Run `produce` at most once for a given chargeId and return the stored
     * response on every retry. Storing the response rather than a bare marker is
     * what makes a double-tap safe: a marker would either error or mint a second
     * order number, which is the outcome the dedupe exists to prevent.
     *
     * A stored `{ pending: true }` record means another request is in flight:
     * the initial read only short-circuits for a completed (non-pending)
     * record, and a pending record falls through to the wait loop below so a
     * pending marker is never handed back as the response. If `produce` throws,
     * the pending claim is deleted so the chargeId is not wedged for 120s.
     * @param {string} roomId
     * @param {string} chargeId
     * @param {() => Promise<object>} produce
     */
    async claimCharge(roomId, chargeId, produce) {
      const key = ["charge", roomId, chargeId];
      const existing = await kv.get(key);
      if (existing.value && !existing.value.pending) return existing.value;

      let claimed = false;
      if (!existing.value) {
        // Only attempt the claim when nothing is there yet. A pending record
        // found above must go straight to the wait loop below rather than be
        // raced for: a check on its versionstamp would succeed too (nothing
        // else has written since we read it) and let us stomp the in-flight
        // claim and call produce() a second time concurrently.
        const claim = await kv.atomic()
          .check({ key, versionstamp: null })
          .set(key, { pending: true }, { expireIn: CHARGE_RECORD_TTL_MS })
          .commit();
        claimed = claim.ok;
      }

      if (!claimed) {
        // Another request holds the claim (or won the race above). Wait
        // briefly for it to store its response.
        for (let i = 0; i < 20; i++) {
          const again = await kv.get(key);
          if (again.value && !again.value.pending) return again.value;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw Object.assign(new Error("charge_in_progress"), {
          code: "charge_in_progress",
        });
      }

      let response;
      try {
        response = await produce();
      } catch (err) {
        // Do not leave a pending claim behind: a retry must be able to proceed
        // immediately rather than wait out the full 120s TTL for a claim that
        // will never resolve.
        await kv.delete(key);
        throw err;
      }
      await kv.set(key, response, { expireIn: CHARGE_RECORD_TTL_MS });
      return response;
    },

    /**
     * Draws a fresh code and claims it under a versionstamp check so a
     * still-live code from another room is never overwritten. With 10^6
     * possible codes a collision is rare but not negligible, and overwriting
     * a live code would let that code's eventual claimant end up paired to
     * the wrong room's payment stream. Retries with a new draw on conflict.
     */
    async createPairCode(roomId) {
      while (true) {
        const code = drawPairCode();
        const key = ["pair", code];
        const claim = await kv.atomic()
          .check({ key, versionstamp: null })
          .set(key, { roomId }, { expireIn: PAIR_CODE_TTL_MS })
          .commit();
        if (claim.ok) return code;
      }
    },

    /**
     * @returns {Promise<{roomId:string, displayToken:string}|null>}
     */
    async claimPairCode(code) {
      const key = ["pair", code];
      const entry = await kv.get(key);
      if (!entry.value) return null;

      // Delete under a versionstamp check so a code can only be claimed once even
      // if two devices submit it simultaneously.
      const consumed = await kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .delete(key)
        .commit();
      if (!consumed.ok) return null;

      const { roomId } = entry.value;
      const displayToken = randomToken();
      const hash = await hashToken(displayToken);
      const roomKey = ["room", roomId];

      // Retry the read-check-set until it commits, so a concurrent write to the
      // room never silently drops the display-token hash we mean to append.
      while (true) {
        const room = await kv.get(roomKey);
        if (!room.value) return null;
        const updated = await kv.atomic()
          .check({ key: roomKey, versionstamp: room.versionstamp })
          .set(roomKey, {
            ...room.value,
            displayTokenHashes: [...room.value.displayTokenHashes, hash],
          })
          .commit();
        if (updated.ok) break;
      }
      return { roomId, displayToken };
    },

    /**
     * EventSource cannot set headers, so a token would otherwise end up in a URL
     * where proxy and server logs capture it. A 30-second single-use ticket is
     * exchanged over a normal POST instead.
     */
    async createTicket(roomId, role) {
      const ticket = randomToken();
      await kv.set(["ticket", ticket], { roomId, role }, { expireIn: TICKET_TTL_MS });
      return ticket;
    },

    async claimTicket(ticket) {
      if (!ticket) return null;
      const key = ["ticket", ticket];
      const entry = await kv.get(key);
      if (!entry.value) return null;
      const consumed = await kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .delete(key)
        .commit();
      return consumed.ok ? entry.value : null;
    },

    async touchPresence(roomId, displayId) {
      await kv.set(["presence", roomId, displayId], 1, { expireIn: PRESENCE_TTL_MS });
    },

    async countPresence(roomId) {
      let n = 0;
      for await (const _ of kv.list({ prefix: ["presence", roomId] })) n++;
      return n;
    },

    /**
     * An in-memory counter would reset on every isolate cycle and differ per
     * region, which is to say it would not limit anything.
     * @returns {Promise<boolean>} true if the request is allowed
     */
    async underRateLimit(scope, ipHash, limit, now = new Date()) {
      const minute = Math.floor(now.getTime() / 60_000);
      const key = ["ratelimit", scope, ipHash, minute];
      const count = await increment(key, { expireIn: RATE_WINDOW_TTL_MS });
      return count <= limit;
    },
  };
}

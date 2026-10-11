import { DurableObject } from "cloudflare:workers";
import { randomPairCode } from "./tokens.js";

const PAIR_CODE_TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const PURGE_DELAY_MS = 10 * 60_000;
/** storage.delete() takes at most 128 keys per call. */
const DELETE_BATCH = 128;

/**
 * Shared by every kassa, as the single instance "global": pair codes (a display
 * claims one before it knows its kassa) and per-client rate limits.
 *
 * Each method's reads and writes touch only storage, so they run without
 * another request interleaving (Durable Object input gates): read-then-write
 * needs no extra locking here.
 */
export class Directory extends DurableObject {
  /** Test seam: a test injects a fixed sequence to force a collision. */
  drawPairCode = randomPairCode;

  /**
   * @returns {Promise<boolean>} true if this request is within the limit
   */
  async allow(scope, ipHash, limit, now = Date.now()) {
    const key = `rate:${scope}:${ipHash}:${Math.floor(now / RATE_WINDOW_MS)}`;
    const count = ((await this.ctx.storage.get(key))?.count ?? 0) + 1;
    await this.ctx.storage.put(key, { count, expiresAt: now + 2 * RATE_WINDOW_MS });
    await this.#schedulePurge();
    return count <= limit;
  }

  /**
   * A collision with another kassa's still-live code is redrawn, never
   * overwritten: that code's claimant would end up paired to the wrong kassa.
   */
  async createPairCode(roomId, now = Date.now()) {
    while (true) {
      const code = this.drawPairCode();
      const key = `pair:${code}`;
      const live = await this.ctx.storage.get(key);
      if (live && live.expiresAt > now) continue;
      await this.ctx.storage.put(key, { roomId, expiresAt: now + PAIR_CODE_TTL_MS });
      await this.#schedulePurge();
      return code;
    }
  }

  /** Single use: deleted on the first claim, valid or expired. */
  async claimPairCode(code, now = Date.now()) {
    if (!/^\d{6}$/.test(code)) return null;
    const key = `pair:${code}`;
    const entry = await this.ctx.storage.get(key);
    if (!entry) return null;
    await this.ctx.storage.delete(key);
    return entry.expiresAt > now ? entry.roomId : null;
  }

  async alarm() {
    const now = Date.now();
    const expired = [];
    for (const [key, value] of await this.ctx.storage.list()) {
      if (value.expiresAt <= now) expired.push(key);
    }
    for (let i = 0; i < expired.length; i += DELETE_BATCH) {
      await this.ctx.storage.delete(expired.slice(i, i + DELETE_BATCH));
    }
    // Anything still stored expires later: come back for it.
    if ((await this.ctx.storage.list({ limit: 1 })).size > 0) {
      await this.ctx.storage.setAlarm(now + PURGE_DELAY_MS);
    }
  }

  /** From the real clock, not the caller's `now`: a past time would fire at once. */
  async #schedulePurge() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_DELAY_MS);
    }
  }
}

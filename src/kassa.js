import { DurableObject } from "cloudflare:workers";
import { normalizePayee } from "../public/shared/swish.js";
import { defaultProducts } from "./defaults.js";
import { bearer, fail, json } from "./http.js";
import { hashToken, randomToken, safeEqual } from "./tokens.js";

/**
 * One kassa: its token hashes, settings, products, current state, sales log
 * and live connections, in this object's own SQLite-backed storage.
 *
 * Storage keys: "room", "settings", "products", "current", "open-sale",
 * "counter:<date>", "charge:<chargeId>", "ticket:<ticket>",
 * "sale:<date>:<orderNo, 6 digits>".
 */
export class Kassa extends DurableObject {
  /** Test seam: the clock. */
  now = () => new Date();
  #queue = Promise.resolve();

  /** RPC from the Worker: set up a new kassa. */
  async create(roomId) {
    const operatorToken = randomToken();
    await this.ctx.storage.put({
      room: {
        roomId,
        createdAt: this.now().getTime(),
        operatorTokenHash: await hashToken(operatorToken),
        displayTokenHashes: [],
      },
      products: defaultProducts(),
    });
    return { roomId, operatorToken };
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    return await this.#serial(() => this.#api(request, url));
  }

  /**
   * One request at a time. A kassa sees a handful a minute, and handling them
   * in turn makes every read-then-write (order numbers, Klar, a repeated
   * chargeId) safe without per-case locking, even across awaits that are not
   * storage calls (hashing), which input gates alone would not cover.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  #serial(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * @param {Request} request
   * @param {"operator"|"display"|"any"} required
   */
  async #authorize(request, required) {
    const token = bearer(request);
    const room = await this.ctx.storage.get("room");
    if (!token || !room) return null;
    const hash = await hashToken(token);
    const role = safeEqual(hash, room.operatorTokenHash)
      ? "operator"
      : room.displayTokenHashes.some((h) => safeEqual(hash, h))
      ? "display"
      : null;
    if (!role || (required !== "any" && role !== required)) return null;
    return { role, room };
  }

  /** @param {Request} request @param {URL} url */
  async #api(request, url) {
    const path = url.pathname;
    const method = request.method;
    const storage = this.ctx.storage;

    if (path === "/api/state" && method === "GET") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      return json({
        settings: (await storage.get("settings")) ?? null,
        products: (await storage.get("products")) ?? [],
      });
    }

    if (path === "/api/settings" && method === "PUT") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const body = await request.json().catch(() => null);
      const storeName = String(body?.storeName ?? "").trim();
      if (!storeName) return fail("invalid_store_name", 400);
      let payeeNumber;
      try {
        payeeNumber = normalizePayee(String(body?.payeeNumber ?? ""));
      } catch {
        return fail("invalid_payee", 400);
      }
      // Store the normalized form so nothing downstream has to re-parse it.
      await storage.put("settings", { storeName, payeeNumber });
      return json({ storeName, payeeNumber });
    }

    if (path === "/api/products" && method === "PUT") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body)) return fail("invalid_products", 400);
      const seen = new Set();
      for (const p of body) {
        if (typeof p?.id !== "string" || !p.id) return fail("invalid_products", 400);
        if (seen.has(p.id)) return fail("duplicate_product_id", 400);
        seen.add(p.id);
        if (typeof p.name !== "string" || !p.name.trim()) {
          return fail("invalid_products", 400);
        }
        if (!Number.isInteger(p.priceOre) || p.priceOre < 0) {
          return fail("invalid_products", 400);
        }
        if (!Number.isInteger(p.sortOrder)) return fail("invalid_products", 400);
        // Optional: products saved before the flag existed have none, and are on.
        if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
          return fail("invalid_products", 400);
        }
      }
      await storage.put("products", body);
      return json({ ok: true });
    }

    return fail("not_found", 404);
  }
}

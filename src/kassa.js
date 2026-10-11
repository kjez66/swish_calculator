import { DurableObject } from "cloudflare:workers";
import { basketTotalOre } from "../public/shared/money.js";
import {
  buildPayload,
  MESSAGE_MAX_CHARS,
  normalizePayee,
  sanitizeMessage,
} from "../public/shared/swish.js";
import { stockholmDate } from "./dates.js";
import { defaultProducts } from "./defaults.js";
import { bearer, fail, json } from "./http.js";
import { toSvg } from "./qr.js";
import { render } from "./render.js";
import { hashToken, randomToken, safeEqual } from "./tokens.js";

/** Below 1 kr is not a real sale; above 20 000 kr is a fat-finger. Neither is a
 * Swish limit — actual ceilings are set per user by their bank. */
const MIN_CHARGE_ORE = 100;
const MAX_CHARGE_ORE = 2_000_000;
const CHARGE_RECORD_TTL_MS = 120_000;
const TICKET_TTL_MS = 30_000;
const SALE_TTL_MS = 31 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** storage.delete() takes at most 128 keys per call. */
const DELETE_BATCH = 128;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A display that has not pinged (or connected) this recently is gone. */
const PRESENCE_TIMEOUT_MS = 45_000;

/** Zero-padded, so storage's key order is order-number order. */
const saleKey = (date, orderNo) => `sale:${date}:${String(orderNo).padStart(6, "0")}`;

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

  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime itself without waking the object, so displays
    // left connected all day cost no duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

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
    await this.ctx.storage.setAlarm(this.now().getTime() + DAY_MS);
    return { roomId, operatorToken };
  }

  /** RPC from the Worker, after a valid pair claim: a new display token. */
  async addDisplay() {
    return await this.#serial(async () => {
      const room = await this.ctx.storage.get("room");
      if (!room) return null;
      const displayToken = randomToken();
      room.displayTokenHashes = [
        ...room.displayTokenHashes,
        await hashToken(displayToken),
      ];
      await this.ctx.storage.put("room", room);
      return displayToken;
    });
  }

  /**
   * Daily: delete sales paid more than 31 days ago, expired tickets and charge
   * records, and order counters older than two days. Reads skip expired
   * entries too, so nothing outlives its limit while waiting for this.
   */
  async alarm() {
    const now = this.now().getTime();
    const storage = this.ctx.storage;
    const doomed = [];
    for (const [key, sale] of await storage.list({ prefix: "sale:" })) {
      if (sale.paidAt <= now - SALE_TTL_MS) doomed.push(key);
    }
    for (const prefix of ["ticket:", "charge:"]) {
      for (const [key, value] of await storage.list({ prefix })) {
        if (value.expiresAt <= now) doomed.push(key);
      }
    }
    const oldestCounter = `counter:${stockholmDate(new Date(now - 2 * DAY_MS))}`;
    for (const key of (await storage.list({ prefix: "counter:" })).keys()) {
      if (key < oldestCounter) doomed.push(key);
    }
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      await storage.delete(doomed.slice(i, i + DELETE_BATCH));
    }
    await storage.setAlarm(now + DAY_MS);
  }

  /**
   * Store the new state and push it, rendered, to every open socket.
   * @param {object} state
   * @param {object} [live] fields for open sockets only, never stored, so a
   *   later replay cannot repeat them (the display's "Tack!")
   */
  async #publish(state, live = {}) {
    await this.ctx.storage.put("current", state);
    this.#send(this.ctx.getWebSockets(), "state", { ...render(state), ...live });
  }

  /** @param {Request} request @param {URL} url */
  async #openSocket(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return fail("expected_websocket", 426);
    }
    const key = `ticket:${url.searchParams.get("ticket") ?? ""}`;
    const ticket = await this.ctx.storage.get(key);
    if (!ticket) return fail("unauthorized", 401);
    await this.ctx.storage.delete(key);
    const now = this.now().getTime();
    if (ticket.expiresAt <= now) return fail("unauthorized", 401);

    const [client, server] = Object.values(new WebSocketPair());
    // Hibernatable: the object can sleep while sockets stay open.
    this.ctx.acceptWebSocket(server, [ticket.role]);
    server.serializeAttachment({ role: ticket.role, connectedAt: now });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * "hello" replays everything a fresh page needs: this is what makes a
   * dropped connection invisible, since every reconnect says hello again.
   * @param {WebSocket} ws @param {string|ArrayBuffer} message
   */
  async webSocketMessage(ws, message) {
    const { role } = ws.deserializeAttachment();
    if (message === "hello") {
      if (role === "display") {
        const settings = await this.ctx.storage.get("settings");
        this.#send([ws], "room", { storeName: settings?.storeName ?? null });
      }
      const current = (await this.ctx.storage.get("current")) ?? { state: "idle" };
      this.#send([ws], "state", render(current));
      this.#sendPresence(role === "operator" ? [ws] : this.ctx.getWebSockets("operator"));
    } else if (message === "presence" && role === "operator") {
      this.#sendPresence([ws]);
    }
    // Anything else is ignored.
  }

  /** @param {WebSocket} ws @param {number} code @param {string} reason */
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // 1005/1006 cannot be echoed; the socket is gone either way.
    }
    if (ws.deserializeAttachment().role === "display") {
      this.#sendPresence(this.ctx.getWebSockets("operator"));
    }
  }

  /** @param {WebSocket[]} sockets @param {string} event @param {object} data */
  #send(sockets, event, data) {
    const message = JSON.stringify({ event, data });
    for (const ws of sockets) {
      // One dead socket must not stop the others.
      try {
        ws.send(message);
      } catch {
        // Its close handler cleans up.
      }
    }
  }

  /**
   * Open displays whose last ping (or connect) is recent: a vanished phone
   * drops out. getWebSockets() can still list a socket that is closing (the
   * one webSocketClose just closed), so only OPEN ones count.
   */
  #sendPresence(operators) {
    const cutoff = this.now().getTime() - PRESENCE_TIMEOUT_MS;
    const displays = this.ctx.getWebSockets("display").filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      return Math.max(pinged, ws.deserializeAttachment().connectedAt) > cutoff;
    }).length;
    this.#send(operators, "presence", { displays });
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/events") return await this.#openSocket(request, url);
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
      // Open displays show the store name; let them update without a reconnect.
      this.#send(this.ctx.getWebSockets("display"), "room", { storeName });
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

    if (path === "/api/pair" && method === "POST") {
      const auth = await this.#authorize(request, "operator");
      if (!auth) return fail("unauthorized", 401);
      const code = await this.env.DIRECTORY.getByName("global")
        .createPairCode(auth.room.roomId);
      // Scanning this with the display phone's camera opens the display page
      // and pairs it, with no typing. It is not payment data: it only grants the
      // same single-use, 5-minute, read-only pairing the typed code does.
      const pairUrl = `${url.origin}/display.html?code=${code}`;
      return json({
        code,
        pairUrl,
        pairQrSvg: toSvg(pairUrl, "QR-kod för att koppla displayen"),
      });
    }

    if (path === "/api/charge" && method === "POST") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const body = await request.json().catch(() => null);
      const chargeId = String(body?.chargeId ?? "");
      const items = body?.items;
      if (!chargeId || !Array.isArray(items)) return fail("bad_request", 400);
      // A non-object line would otherwise surface as a TypeError (500).
      if (items.some((i) => i === null || typeof i !== "object")) {
        return fail("bad_request", 400);
      }

      const settings = await storage.get("settings");
      if (!settings?.storeName || !settings?.payeeNumber) {
        return fail("not_configured", 409);
      }
      if (items.length === 0) return fail("empty_basket", 400);

      // A disabled product is not for sale: treated as unknown, so a stale
      // basket is refused rather than charged for something taken off the menu.
      const products = ((await storage.get("products")) ?? [])
        .filter((p) => p.enabled !== false);
      let totalOre;
      try {
        totalOre = basketTotalOre(items, products);
      } catch (err) {
        // An unknown id is rejected, never skipped: a dropped line undercharges.
        return fail(err.message, 400, { id: err.productId });
      }
      if (totalOre < MIN_CHARGE_ORE) return fail("amount_too_low", 400);
      if (totalOre > MAX_CHARGE_ORE) return fail("amount_too_high", 400);
      if (totalOre !== body?.expectedTotalOre) {
        return fail("stale_total", 409, { totalOre });
      }

      // A retry (double tap, flaky network) gets the stored response, never a
      // second order number. Requests are serial, so no claim marker is needed.
      const chargedAt = this.now();
      const recordKey = `charge:${chargeId}`;
      const record = await storage.get(recordKey);
      if (record && record.expiresAt > chargedAt.getTime()) return json(record.response);

      const date = stockholmDate(chargedAt);
      const orderNo = ((await storage.get(`counter:${date}`)) ?? 0) + 1;
      await storage.put(`counter:${date}`, orderNo);
      // The order number must survive truncation: build the suffix first,
      // then leave the store name only as much room as remains.
      const suffix = ` #${orderNo}`;
      const name = Array.from(sanitizeMessage(settings.storeName))
        .slice(0, MESSAGE_MAX_CHARS - Array.from(suffix).length)
        .join("")
        .trim();
      const message = name + suffix;
      const payload = buildPayload({ payee: settings.payeeNumber, totalOre, message });
      const roomState = {
        state: "charge",
        orderNo,
        totalOre,
        message,
        payload,
        updatedAt: chargedAt.getTime(),
      };
      // What was sold, as named and priced right now: Klar saves this, so a
      // later rename or price change cannot rewrite the sales log. Kept out of
      // `current`, which goes to the customer display.
      const byId = new Map(products.map((p) => [p.id, p]));
      await storage.put("open-sale", {
        orderNo,
        date,
        totalOre,
        lines: items.map(({ id, qty }) => ({
          productId: id,
          name: byId.get(id).name,
          priceOre: byId.get(id).priceOre,
          qty,
        })),
        chargedAt: chargedAt.getTime(),
      });
      await this.#publish(roomState);
      const response = {
        orderNo,
        totalOre,
        message,
        payload,
        svg: render(roomState).svg,
      };
      await storage.put(recordKey, {
        response,
        expiresAt: chargedAt.getTime() + CHARGE_RECORD_TTL_MS,
      });
      return json(response);
    }

    if (path === "/api/idle" && method === "POST") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      // `paid: true` (the operator's Klar) makes the display thank the customer
      // and saves the sale; Avbryt sends no body and drops it. A repeat finds
      // the screen idle and saves nothing.
      const body = await request.json().catch(() => null);
      const paid = body?.paid === true;
      const current = (await storage.get("current")) ?? { state: "idle" };
      if (current.state === "charge") {
        const sale = await storage.get("open-sale");
        if (sale && sale.orderNo === current.orderNo) {
          await storage.delete("open-sale");
          if (paid) {
            await storage.put(saleKey(sale.date, sale.orderNo), {
              ...sale,
              paidAt: this.now().getTime(),
            });
          }
        }
      }
      await this.#publish({ state: "idle" }, paid ? { thanks: true } : {});
      return json({ ok: true });
    }

    if (path === "/api/sales" && method === "GET") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const date = url.searchParams.get("date") ?? stockholmDate(this.now());
      if (!DATE.test(date)) return fail("invalid_date", 400);
      const oldest = this.now().getTime() - SALE_TTL_MS;
      const sales = [...(await storage.list({ prefix: `sale:${date}:` })).values()]
        .filter((sale) => sale.paidAt > oldest);
      return json({ date, sales });
    }

    if (path === "/api/sales" && method === "DELETE") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const date = url.searchParams.get("date") ?? "";
      const orderNo = Number(url.searchParams.get("orderNo"));
      if (!DATE.test(date) || !Number.isInteger(orderNo) || orderNo < 1) {
        return fail("invalid_sale", 400);
      }
      const key = saleKey(date, orderNo);
      if (!await storage.get(key)) return fail("sale_not_found", 404);
      await storage.delete(key);
      return json({ ok: true });
    }

    if (path === "/api/stream-ticket" && method === "POST") {
      const auth = await this.#authorize(request, "any");
      if (!auth) return fail("unauthorized", 401);
      // A browser WebSocket cannot send an Authorization header, and a token
      // in the URL would land in logs: trade it for a single-use ticket.
      const ticket = randomToken();
      await storage.put(`ticket:${ticket}`, {
        role: auth.role,
        expiresAt: this.now().getTime() + TICKET_TTL_MS,
      });
      return json({ ticket });
    }

    return fail("not_found", 404);
  }
}

/**
 * HTTP routes. `createHandler` returns a plain (req, info) => Response so
 * tests can exercise it without binding a port. `info` is the
 * `Deno.ServeHandlerInfo` that `Deno.serve` passes automatically; tests
 * construct a lookalike (see tests/helpers.js) to exercise the rate limiter's
 * trust boundary.
 * @module
 */
import { serveDir } from "@std/http/file-server";
import { basketTotalOre } from "../public/shared/money.js";
import {
  buildPayload,
  MESSAGE_MAX_CHARS,
  normalizePayee,
  sanitizeMessage,
} from "../public/shared/swish.js";
import { hashToken } from "./tokens.js";
import { toSvg } from "./qr.js";

const ROOMS_PER_MINUTE = 10;
const PAIR_CLAIMS_PER_MINUTE = 20;
const HEARTBEAT_MS = 15_000;
/** Below 1 kr is not a real sale; above 20 000 kr is a fat-finger. Neither is a
 * Swish limit — actual ceilings are set per user by their bank. */
const MIN_CHARGE_ORE = 100;
const MAX_CHARGE_ORE = 2_000_000;

/** @param {object} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {string} error @param {number} status @param {object} [extra] */
function fail(error, status, extra = {}) {
  return json({ error, ...extra }, status);
}

/** @param {Request} req */
function bearer(req) {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/**
 * Trust boundary: `x-forwarded-for` is client-controllable (a caller can send
 * any value, and rotate it per request) and must never be used for the
 * rate-limit key. `info.remoteAddr` comes from the TCP connection itself — on
 * Deno Deploy that is the real client address — so it is the only source we
 * trust here. Falls back to "unknown" only when no connection info was
 * supplied at all (which should not happen outside of a misconfigured test).
 * @param {Deno.ServeHandlerInfo|undefined} info
 */
function clientIp(info) {
  return info?.remoteAddr?.hostname ?? "unknown";
}

/**
 * @param {{store: ReturnType<import("./store.js").createStore>,
 *          hub: ReturnType<import("./hub.js").createHub>,
 *          now?: () => Date}} deps
 */
export function createHandler({ store, hub, now = () => new Date() }) {
  /**
   * @param {Request} req
   * @param {URL} url
   * @param {"operator"|"display"|"any"} required
   */
  async function authorize(req, url, required) {
    const roomId = url.searchParams.get("roomId");
    const token = bearer(req);
    if (!roomId || !token) return null;
    const role = await store.authenticate(roomId, token);
    if (!role) return null;
    if (required !== "any" && role !== required) return null;
    return { roomId, role };
  }

  return async function handler(req, info) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return serveDir(req, { fsRoot: "public", quiet: true });
    }

    // --- room creation -----------------------------------------------------
    if (path === "/api/rooms" && req.method === "POST") {
      const ipHash = await hashToken(clientIp(info));
      if (!await store.underRateLimit("rooms", ipHash, ROOMS_PER_MINUTE, now())) {
        return fail("rate_limited", 429);
      }
      return json(await store.createRoom());
    }

    // --- operator state ----------------------------------------------------
    if (path === "/api/state" && req.method === "GET") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      return json({
        settings: await store.getSettings(auth.roomId),
        products: await store.getProducts(auth.roomId),
      });
    }

    if (path === "/api/settings" && req.method === "PUT") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      const body = await req.json().catch(() => null);
      const storeName = String(body?.storeName ?? "").trim();
      if (!storeName) return fail("invalid_store_name", 400);
      let payeeNumber;
      try {
        payeeNumber = normalizePayee(String(body?.payeeNumber ?? ""));
      } catch {
        return fail("invalid_payee", 400);
      }
      // Store the normalized form so nothing downstream has to re-parse it.
      await store.setSettings(auth.roomId, { storeName, payeeNumber });
      return json({ storeName, payeeNumber });
    }

    if (path === "/api/products" && req.method === "PUT") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      const body = await req.json().catch(() => null);
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
      }
      await store.setProducts(auth.roomId, body);
      return json({ ok: true });
    }

    // --- pairing -----------------------------------------------------------
    if (path === "/api/pair" && req.method === "POST") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      const code = await store.createPairCode(auth.roomId);
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

    if (path === "/api/pair/claim" && req.method === "POST") {
      const ipHash = await hashToken(clientIp(info));
      // Rate limiting here is what keeps a 6-digit code from being brute-forced.
      if (!await store.underRateLimit("pair", ipHash, PAIR_CLAIMS_PER_MINUTE, now())) {
        return fail("rate_limited", 429);
      }
      const body = await req.json().catch(() => null);
      const claimed = await store.claimPairCode(String(body?.code ?? ""));
      if (!claimed) return fail("invalid_code", 404);
      return json(claimed);
    }

    // --- streaming ---------------------------------------------------------
    if (path === "/api/stream-ticket" && req.method === "POST") {
      const auth = await authorize(req, url, "any");
      if (!auth) return fail("unauthorized", 401);
      return json({ ticket: await store.createTicket(auth.roomId, auth.role) });
    }

    if (path === "/api/events" && req.method === "GET") {
      const claimed = await store.claimTicket(url.searchParams.get("ticket"));
      if (!claimed) return fail("unauthorized", 401);
      const { roomId, role } = claimed;
      const displayId = crypto.randomUUID();

      let unsubscribe = () => {};
      let heartbeat = 0;
      // Guards two distinct races, both surfaced by tests that don't let
      // `start()` run to completion before acting:
      // - the consumer can cancel before `start()`'s first await settles
      //   (see "a ticket works exactly once"), which must not leak the
      //   heartbeat interval or enqueue onto an already-closed controller;
      // - a KV call inside `start()` or the heartbeat can reject (see "an
      //   error during start()..."), which must not leave the hub
      //   subscriber registered forever with no live consumer.
      // `cleanup()` is the single place that unwinds both: it is idempotent,
      // so calling it more than once (e.g. cancel() racing an in-flight
      // error) is harmless. `send` is a no-op once closed.
      let closed = false;
      const encoder = new TextEncoder();

      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };

      const body = new ReadableStream({
        async start(controller) {
          const send = (name, data) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };

          try {
            unsubscribe = await hub.subscribe(roomId, send);
            if (closed) return cleanup();

            if (role === "display") {
              await store.touchPresence(roomId, displayId);
              if (closed) return cleanup();
            }

            heartbeat = setInterval(async () => {
              try {
                // A comment frame keeps intermediate proxies from closing the stream.
                controller.enqueue(encoder.encode(": ping\n\n"));
                if (role === "display") {
                  await store.touchPresence(roomId, displayId);
                } else {
                  send("presence", { displays: await store.countPresence(roomId) });
                }
              } catch (err) {
                // A dead heartbeat must not leave the stream open-but-silent:
                // the client would sit on a connection whose presence has
                // stopped updating and that a proxy may eventually drop
                // without either side noticing. Erroring it makes the
                // client's EventSource reconnect and get a fresh replay.
                const wasOpen = !closed;
                cleanup();
                if (wasOpen) controller.error(err);
              }
            }, HEARTBEAT_MS);

            if (role === "operator") {
              send("presence", { displays: await store.countPresence(roomId) });
            }
          } catch (err) {
            // Same reasoning as the heartbeat's catch above: an error here
            // (e.g. touchPresence/countPresence rejecting) must not leave a
            // zombie stream subscribed in the hub with no cancel() coming to
            // unsubscribe it.
            const wasOpen = !closed;
            cleanup();
            if (wasOpen) controller.error(err);
          }
        },
        cancel() {
          cleanup();
        },
      });

      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // --- charging ----------------------------------------------------------
    if (path === "/api/charge" && req.method === "POST") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);

      const body = await req.json().catch(() => null);
      const chargeId = String(body?.chargeId ?? "");
      const items = body?.items;
      if (!chargeId || !Array.isArray(items)) return fail("bad_request", 400);
      // A non-object line would otherwise surface as a TypeError (500).
      if (items.some((i) => i === null || typeof i !== "object")) {
        return fail("bad_request", 400);
      }

      const settings = await store.getSettings(auth.roomId);
      if (!settings?.storeName || !settings?.payeeNumber) {
        return fail("not_configured", 409);
      }
      if (items.length === 0) return fail("empty_basket", 400);

      const products = await store.getProducts(auth.roomId);
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

      try {
        const response = await store.claimCharge(auth.roomId, chargeId, async () => {
          const orderNo = await store.nextOrderNo(auth.roomId, now());
          // The order number must survive truncation: build the suffix first,
          // then leave the store name only as much room as remains, so the
          // displayed note, the stored state and the payload all carry the
          // identical string.
          const suffix = ` #${orderNo}`;
          const name = Array.from(sanitizeMessage(settings.storeName))
            .slice(0, MESSAGE_MAX_CHARS - Array.from(suffix).length)
            .join("")
            .trim();
          const message = name + suffix;
          const payload = buildPayload({
            payee: settings.payeeNumber,
            totalOre,
            message,
          });
          const roomState = {
            state: "charge",
            orderNo,
            totalOre,
            message,
            payload,
            updatedAt: Date.now(),
          };
          await hub.publish(auth.roomId, roomState);
          return { orderNo, totalOre, message, payload, svg: hub.render(roomState).svg };
        });
        return json(response);
      } catch (err) {
        if (err.code === "charge_in_progress") return fail("charge_in_progress", 409);
        throw err;
      }
    }

    if (path === "/api/idle" && req.method === "POST") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      // `paid: true` (the operator's Klar) makes the display thank the customer
      // before its welcome screen; Avbryt sends no body. The body is optional.
      const body = await req.json().catch(() => null);
      const paid = body?.paid === true;
      await hub.publish(auth.roomId, { state: "idle" }, {
        live: paid ? { thanks: true } : {},
      });
      return json({ ok: true });
    }

    return fail("not_found", 404);
  };
}

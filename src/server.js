/**
 * HTTP routes. `createHandler` returns a plain (req, info) => Response so
 * tests can exercise it without binding a port. `info` is the
 * `Deno.ServeHandlerInfo` that `Deno.serve` passes automatically; tests
 * construct a lookalike (see tests/helpers.js) to exercise the rate limiter's
 * trust boundary.
 * @module
 */
import { serveDir } from "@std/http/file-server";
import { normalizePayee } from "../public/shared/swish.js";
import { hashToken } from "./tokens.js";

const ROOMS_PER_MINUTE = 10;
const PAIR_CLAIMS_PER_MINUTE = 20;
const HEARTBEAT_MS = 15_000;

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
      return json({ code: await store.createPairCode(auth.roomId) });
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
      // The "a ticket works exactly once" test cancels the stream before
      // `start()` finishes its first await, which would otherwise leak the
      // heartbeat interval and try to enqueue onto an already-closed
      // controller. Every await below re-checks this flag before doing
      // anything that assumes the stream is still open, and `send` is a
      // no-op once it is set.
      let closed = false;
      const encoder = new TextEncoder();

      const body = new ReadableStream({
        async start(controller) {
          const send = (name, data) => {
            if (closed) return;
            controller.enqueue(
              encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };

          unsubscribe = await hub.subscribe(roomId, send);
          if (closed) {
            unsubscribe();
            return;
          }

          if (role === "display") {
            await store.touchPresence(roomId, displayId);
            if (closed) {
              unsubscribe();
              return;
            }
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
            } catch {
              clearInterval(heartbeat);
            }
          }, HEARTBEAT_MS);

          if (role === "operator") {
            send("presence", { displays: await store.countPresence(roomId) });
          }
        },
        cancel() {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
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

    return fail("not_found", 404);
  };
}

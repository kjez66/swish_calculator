/**
 * The Worker: routes /api/* to the Durable Objects. It does no real work of
 * its own, because the Free plan allows it only 10 ms of CPU per request;
 * QR rendering and everything else runs in the kassa's object (30 s).
 * Static files in public/ never reach it: Workers Static Assets serves them.
 * @module
 */
import { fail, json } from "./http.js";
import { hashToken } from "./tokens.js";

export { Directory } from "./directory.js";
export { Kassa } from "./kassa.js";

const ROOMS_PER_MINUTE = 10;
/** Only ids this Worker issued: a guessed name would wake an empty object. */
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The routes a kassa answers; anything else under /api/ is a 404. */
const KASSA_ROUTES = new Set([
  "/api/state",
  "/api/settings",
  "/api/products",
  "/api/pair",
  "/api/stream-ticket",
  "/api/events",
  "/api/charge",
  "/api/idle",
  "/api/sales",
]);

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Set by Cloudflare from the connection, overwriting any value a client
    // sends, so unlike x-forwarded-for it cannot be spoofed to dodge a limit.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const directory = env.DIRECTORY.getByName("global");

    if (path === "/api/rooms" && request.method === "POST") {
      if (!await directory.allow("rooms", await hashToken(ip), ROOMS_PER_MINUTE)) {
        return fail("rate_limited", 429);
      }
      const roomId = crypto.randomUUID();
      return json(await env.KASSA.getByName(roomId).create(roomId));
    }

    if (!KASSA_ROUTES.has(path)) return fail("not_found", 404);
    const roomId = url.searchParams.get("roomId") ?? "";
    if (!ROOM_ID.test(roomId)) return fail("unauthorized", 401);
    return env.KASSA.getByName(roomId).fetch(request);
  },
};

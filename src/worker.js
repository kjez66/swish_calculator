/**
 * The Worker: routes /api/* to the Durable Objects. It does no real work of
 * its own, because the Free plan allows it only 10 ms of CPU per request;
 * QR rendering and everything else runs in the kassa's object (30 s).
 * Static files in public/ never reach it: Workers Static Assets serves them.
 * @module
 */
import { fail } from "./http.js";

export { Directory } from "./directory.js";
export { Kassa } from "./kassa.js";

export default {
  fetch() {
    return fail("not_found", 404);
  },
};

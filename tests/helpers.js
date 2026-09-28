/**
 * Shared test harness for exercising `createHandler` without binding a port.
 *
 * This lives outside any `*_test.js` file on purpose: importing a `*_test.js`
 * module re-registers all of its `Deno.test` cases inside every importer, so a
 * harness that other test files need to reuse (Tasks 8 and 9) must not live in
 * one.
 * @module
 */
import { createStore } from "../src/store.js";
import { createHub } from "../src/hub.js";
import { createHandler } from "../src/server.js";

/**
 * Default connection info handed to the handler, standing in for what
 * `Deno.serve` passes as its second argument in production. `x-forwarded-for`
 * is untrusted (see src/server.js's clientIp), so `call` also sends a default
 * XFF header — callers can rotate it to prove spoofing it has no effect, and
 * override `remoteAddr` to prove a genuinely different client is unaffected.
 * @param {string} hostname
 * @returns {Deno.ServeHandlerInfo}
 */
function connInfo(hostname) {
  return { remoteAddr: { transport: "tcp", hostname, port: 1234 } };
}

/**
 * @param {(ctx: {call: Function, store: object, hub: object, handler: Function}) => Promise<void>} fn
 */
export async function withServer(fn) {
  const kv = await Deno.openKv(":memory:");
  const store = createStore(kv);
  const hub = createHub(store, { channelName: `test-${crypto.randomUUID()}` });
  const handler = createHandler({ store, hub });
  const call = (
    method,
    path,
    { token, body, xff = "203.0.113.5", remoteAddr = "203.0.113.5" } = {},
  ) =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          "x-forwarded-for": xff,
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      connInfo(remoteAddr),
    );
  try {
    await fn({ call, store, hub, handler });
  } finally {
    hub.close();
    kv.close();
  }
}

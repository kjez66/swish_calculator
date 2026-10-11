import { exports } from "cloudflare:workers";

let ipSeq = 0;
/** A fresh client address, so one test never trips another's rate limit. */
export const newIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

/**
 * Call the Worker the way a browser on the internet would.
 * @param {string} method
 * @param {string} path
 * @param {{token?: string, body?: unknown, ip?: string, headers?: object}} [options]
 */
export function call(method, path, { token, body, ip = newIp(), headers = {} } = {}) {
  return exports.default.fetch(`https://kassa.test${path}`, {
    method,
    headers: {
      "CF-Connecting-IP": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** A new kassa, with `api` calling its routes as the operator. */
export async function newRoom() {
  const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
  const api = (method, path, options = {}) =>
    call(method, `${path}${path.includes("?") ? "&" : "?"}roomId=${roomId}`, {
      token: operatorToken,
      ...options,
    });
  return { roomId, operatorToken, api };
}

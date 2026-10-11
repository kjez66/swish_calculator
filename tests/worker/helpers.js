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

/** A kassa with a store name, Swish number and three known products. */
export async function configuredRoom() {
  const room = await newRoom();
  await room.api("PUT", "/api/settings", {
    body: { storeName: "Kiosken", payeeNumber: "0701234567" },
  });
  const products = [
    { id: "kaffe", name: "Kaffe", priceOre: 2000, sortOrder: 0 },
    { id: "korv", name: "Korv med bröd", priceOre: 2000, sortOrder: 1 },
    { id: "loka", name: "Loka", priceOre: 1500, sortOrder: 2 },
  ];
  await room.api("PUT", "/api/products", { body: products });
  const charge = async (items, expectedTotalOre, chargeId = crypto.randomUUID()) =>
    await (await room.api("POST", "/api/charge", {
      body: { chargeId, items, expectedTotalOre },
    })).json();
  const idle = (paid) => room.api("POST", "/api/idle", paid ? { body: { paid } } : {});
  const sales = async (date) =>
    await (await room.api("GET", `/api/sales${date ? `?date=${date}` : ""}`)).json();
  return { ...room, products, charge, idle, sales };
}

/** Pair a display to the kassa the way the display page does. */
export async function pairDisplay(api) {
  const { code } = await (await api("POST", "/api/pair")).json();
  const res = await call("POST", "/api/pair/claim", { body: { code } });
  return (await res.json()).displayToken;
}

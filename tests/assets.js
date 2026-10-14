import { env } from "cloudflare:workers";

/**
 * A file from public/, fetched the way a phone gets it. `path` is the URL path,
 * e.g. "/display.js". The pages redirect to their short URLs (/index.html to /),
 * and fetch follows that. A missing file fails the test instead of reading as "".
 * @param {string} path
 */
export async function asset(path) {
  const res = await env.ASSETS.fetch(`https://kassa.test${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}

/** @param {string} path */
export const assetText = async (path) => (await asset(path)).text();

/** @param {string} path */
export const assetBytes = async (path) =>
  new Uint8Array(await (await asset(path)).arrayBuffer());

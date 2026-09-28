/**
 * Token generation, hashing and comparison.
 *
 * Tokens are stored hashed so that a leaked KV dump does not confer the ability
 * to push a QR to someone's display — the threat that matters here is payment
 * redirection, not data theft.
 * @module
 */

/**
 * @returns {string} 32 random bytes, base64url, no padding
 */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @returns {string} a uniformly distributed 6-digit code, leading zeros kept
 */
export function randomPairCode() {
  const buf = new Uint32Array(1);
  // Reject values in the final partial bucket so the modulo stays uniform.
  const limit = Math.floor(0xFFFFFFFF / 1_000_000) * 1_000_000;
  let n;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % 1_000_000).padStart(6, "0");
}

/**
 * @param {string} token
 * @returns {Promise<string>} SHA-256 hex
 */
export async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison over the shared prefix. Length is compared up front,
 * which is not secret for fixed-width hashes.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

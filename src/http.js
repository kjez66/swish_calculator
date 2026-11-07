/**
 * JSON response helpers shared by the Worker and the Durable Objects.
 * @module
 */

/**
 * The API's share of public/_headers. A JSON reply is never a page, so its
 * policy allows nothing at all.
 */
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

/** @param {unknown} body @param {number} [status] */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...SECURITY_HEADERS },
  });
}

/**
 * A kassa's logo. Its URL carries its version, so a new logo gets a new URL
 * and this one can be cached for good.
 * @param {ArrayBuffer} bytes
 */
export function png(bytes) {
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      ...SECURITY_HEADERS,
    },
  });
}

/** @param {string} error @param {number} status @param {object} [extra] */
export function fail(error, status, extra = {}) {
  return json({ error, ...extra }, status);
}

/** @param {Request} request @returns {string|null} */
export function bearer(request) {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

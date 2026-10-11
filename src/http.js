/**
 * JSON response helpers shared by the Worker and the Durable Objects.
 * @module
 */

/** @param {unknown} body @param {number} [status] */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

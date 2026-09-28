/**
 * Money handling. All amounts are integer öre; floating point never touches a
 * price or a total. Shared verbatim between the browser and the server so the
 * running total on screen and the authoritative total on the server cannot drift.
 * @module
 */

/**
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 * @returns {Error}
 */
function fail(code, extra = {}) {
  return Object.assign(new Error(code), { code, ...extra });
}

/**
 * Parse a human-typed kronor amount into integer öre.
 * Accepts comma or dot decimals, surrounding whitespace, and a trailing "kr".
 * @param {string} input
 * @returns {number} öre
 */
export function parseKronorToOre(input) {
  if (typeof input !== "string") throw fail("invalid_amount");
  const cleaned = input.trim().replace(/\s+/g, "").replace(/kr$/i, "");
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!m) throw fail("invalid_amount");
  const kronor = Number(m[1]);
  const decimals = (m[2] ?? "").padEnd(2, "0");
  return kronor * 100 + Number(decimals);
}

/**
 * Swedish display form: comma decimals, non-breaking-space thousands.
 * @param {number} ore
 * @returns {string} e.g. "1 500,00"
 */
export function formatOre(ore) {
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(ore));
  const kronor = String(Math.floor(abs / 100));
  const decimals = String(abs % 100).padStart(2, "0");
  const grouped = kronor.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped},${decimals}`;
}

/**
 * Swish payload form: dot decimals, always exactly two, no grouping.
 * @param {number} ore
 * @returns {string} e.g. "1500.00"
 */
export function formatOreForSwish(ore) {
  const abs = Math.abs(Math.trunc(ore));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * @param {{id: string, qty: number}[]} items
 * @param {{id: string, priceOre: number}[]} products
 * @returns {number} total in öre
 */
export function basketTotalOre(items, products) {
  const priceById = new Map(products.map((p) => [p.id, p.priceOre]));
  let total = 0;
  for (const item of items) {
    const price = priceById.get(item.id);
    // An unknown id is rejected, never skipped: a dropped line undercharges silently.
    if (price === undefined) throw fail("unknown_product", { productId: item.id });
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw fail("bad_quantity", { productId: item.id });
    }
    total += price * item.qty;
  }
  return total;
}

/**
 * The day's sales, summed per product. Shared between the browser's sales view
 * and the tests; amounts are integer öre, as everywhere.
 * @module
 */

/**
 * @typedef {{productId: string, name: string, priceOre: number, qty: number}} SaleLine
 * @typedef {{orderNo: number, totalOre: number, lines: SaleLine[]}} Sale
 */

/**
 * Lines are grouped by product id, not name, so a product renamed during the
 * day stays one row; it shows the name from its latest sale. Most sold first.
 * @param {Sale[]} sales
 * @returns {{count: number, totalOre: number,
 *   products: {productId: string, name: string, qty: number, totalOre: number}[]}}
 */
export function summarizeSales(sales) {
  const byProduct = new Map();
  let totalOre = 0;
  for (const sale of sales) {
    totalOre += sale.totalOre;
    for (const line of sale.lines) {
      const row = byProduct.get(line.productId) ?? {
        productId: line.productId,
        name: line.name,
        qty: 0,
        totalOre: 0,
      };
      row.name = line.name;
      row.qty += line.qty;
      row.totalOre += line.priceOre * line.qty;
      byProduct.set(line.productId, row);
    }
  }
  const products = [...byProduct.values()].sort(
    (a, b) => b.qty - a.qty || a.name.localeCompare(b.name, "sv"),
  );
  return { count: sales.length, totalOre, products };
}

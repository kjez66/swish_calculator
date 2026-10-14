/**
 * HK Halmstad P13's kiosk menu, in menu order: a new kassa starts with it, so
 * the kiosk can sell right away. Prices in whole kronor; categories as in
 * public/shared/categories.js.
 */
export const DEFAULT_PRODUCTS = [
  ["Loka", 15, "dryck"],
  ["Capri Sun", 15, "dryck"],
  ["Läsk Cola/Fanta", 20, "dryck"],
  ["Kaffe", 20, "dryck"],
  ["Hembakat", 15, "fika"],
  ["Delicatoboll", 15, "fika"],
  ["Korv med bröd", 20, "mat"],
  ["Wasa Knäcke", 15, "mat"],
  ["Corny", 15, "godis"],
  ["Chips", 15, "godis"],
  ["Kexchoklad", 15, "godis"],
];

/** Fresh ids per kassa: a product id is never reused (see the spec). */
export function defaultProducts() {
  return DEFAULT_PRODUCTS.map(([name, kronor, category], i) => ({
    id: crypto.randomUUID(),
    name,
    priceOre: kronor * 100,
    sortOrder: i,
    enabled: true,
    category,
  }));
}

/**
 * HK Halmstad P13's kiosk menu, in menu order: a new kassa starts with it, so
 * the kiosk can sell right away. Prices in whole kronor.
 */
export const DEFAULT_PRODUCTS = [
  ["Loka", 15],
  ["Capri Sun", 15],
  ["Läsk Cola/Fanta", 20],
  ["Kaffe", 20],
  ["Hembakat", 15],
  ["Delicatoboll", 15],
  ["Korv med bröd", 20],
  ["Wasa Knäcke", 15],
  ["Corny", 15],
  ["Chips", 15],
  ["Kexchoklad", 15],
];

/** Fresh ids per kassa: a product id is never reused (see the spec). */
export function defaultProducts() {
  return DEFAULT_PRODUCTS.map(([name, kronor], i) => ({
    id: crypto.randomUUID(),
    name,
    priceOre: kronor * 100,
    sortOrder: i,
    enabled: true,
  }));
}

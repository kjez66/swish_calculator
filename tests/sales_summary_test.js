import { assertEquals } from "@std/assert";
import { summarizeSales } from "../public/shared/sales.js";

Deno.test("summarizeSales totals the day per product", () => {
  const line = (productId, name, priceOre, qty) => ({ productId, name, priceOre, qty });
  const summary = summarizeSales([
    {
      orderNo: 1,
      totalOre: 5500,
      lines: [line("k", "Kaffe", 2000, 2), line("l", "Loka", 1500, 1)],
    },
    { orderNo: 2, totalOre: 2000, lines: [line("k", "Kaffe", 2000, 1)] },
    // A price change during the day: still one product, summed at each price.
    { orderNo: 3, totalOre: 2500, lines: [line("k", "Bryggkaffe", 2500, 1)] },
  ]);
  assertEquals(summary, {
    count: 3,
    totalOre: 10000,
    products: [
      { productId: "k", name: "Bryggkaffe", qty: 4, totalOre: 8500 },
      { productId: "l", name: "Loka", qty: 1, totalOre: 1500 },
    ],
  });
  assertEquals(summarizeSales([]), { count: 0, totalOre: 0, products: [] });
});

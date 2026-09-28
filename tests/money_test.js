import { assertEquals, assertThrows } from "@std/assert";
import {
  basketTotalOre,
  formatOre,
  formatOreForSwish,
  parseKronorToOre,
} from "../public/shared/money.js";

Deno.test("parseKronorToOre accepts comma and dot decimals", () => {
  assertEquals(parseKronorToOre("19,90"), 1990);
  assertEquals(parseKronorToOre("19.90"), 1990);
  assertEquals(parseKronorToOre("19"), 1900);
  assertEquals(parseKronorToOre("0,05"), 5);
  assertEquals(parseKronorToOre("  25 kr "), 2500);
  assertEquals(parseKronorToOre("1,5"), 150);
});

Deno.test("parseKronorToOre rejects nonsense", () => {
  for (const bad of ["", "abc", "-5", "19,905", "1,2,3", "19,", "."]) {
    assertThrows(() => parseKronorToOre(bad), Error, "invalid_amount");
  }
});

Deno.test("formatOre renders Swedish display form", () => {
  assertEquals(formatOre(1990), "19,90");
  assertEquals(formatOre(5), "0,05");
  assertEquals(formatOre(0), "0,00");
  assertEquals(formatOre(150000), "1\u00A0500,00");
  assertEquals(formatOre(123456789), "1\u00A0234\u00A0567,89");
});

Deno.test("formatOreForSwish always has two decimals and a dot", () => {
  assertEquals(formatOreForSwish(1990), "19.90");
  assertEquals(formatOreForSwish(24900), "249.00");
  assertEquals(formatOreForSwish(5), "0.05");
  assertEquals(formatOreForSwish(150000), "1500.00");
});

Deno.test("basketTotalOre sums quantities", () => {
  const products = [
    { id: "a", priceOre: 1990 },
    { id: "b", priceOre: 2450 },
  ];
  assertEquals(basketTotalOre([{ id: "a", qty: 2 }, { id: "b", qty: 1 }], products), 6430);
  assertEquals(basketTotalOre([], products), 0);
});

Deno.test("basketTotalOre stays exact where floats would drift", () => {
  // 0.1 + 0.2 !== 0.3 in floating point. In öre this must be exact.
  const products = [{ id: "a", priceOre: 10 }, { id: "b", priceOre: 20 }];
  assertEquals(basketTotalOre([{ id: "a", qty: 1 }, { id: "b", qty: 1 }], products), 30);

  const many = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, priceOre: 1990 }));
  const items = many.map((p) => ({ id: p.id, qty: 3 }));
  assertEquals(basketTotalOre(items, many), 1990 * 3 * 1000);
});

Deno.test("basketTotalOre rejects unknown products rather than skipping them", () => {
  const err = assertThrows(
    () => basketTotalOre([{ id: "ghost", qty: 1 }], [{ id: "a", priceOre: 100 }]),
    Error,
    "unknown_product",
  );
  assertEquals(err.productId, "ghost");
});

Deno.test("basketTotalOre rejects bad quantities", () => {
  const products = [{ id: "a", priceOre: 100 }];
  for (const qty of [0, -1, 1.5, NaN, "2"]) {
    assertThrows(() => basketTotalOre([{ id: "a", qty }], products), Error, "bad_quantity");
  }
});

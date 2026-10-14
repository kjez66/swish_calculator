import { expect, test } from "vitest";
import {
  basketTotalOre,
  formatOre,
  formatOreForSwish,
  parseKronorToOre,
} from "../public/shared/money.js";

test("parseKronorToOre accepts comma and dot decimals", () => {
  expect(parseKronorToOre("19,90")).toBe(1990);
  expect(parseKronorToOre("19.90")).toBe(1990);
  expect(parseKronorToOre("19")).toBe(1900);
  expect(parseKronorToOre("0,05")).toBe(5);
  expect(parseKronorToOre("  25 kr ")).toBe(2500);
  expect(parseKronorToOre("1,5")).toBe(150);
});

test("parseKronorToOre rejects nonsense", () => {
  for (const bad of ["", "abc", "-5", "19,905", "1,2,3", "19,", "."]) {
    expect(() => parseKronorToOre(bad), bad).toThrow("invalid_amount");
  }
});

test("formatOre renders Swedish display form", () => {
  expect(formatOre(1990)).toBe("19,90");
  expect(formatOre(5)).toBe("0,05");
  expect(formatOre(0)).toBe("0,00");
  expect(formatOre(150000)).toBe("1\u00A0500,00");
  expect(formatOre(123456789)).toBe("1\u00A0234\u00A0567,89");
});

test("formatOreForSwish always has two decimals and a dot", () => {
  expect(formatOreForSwish(1990)).toBe("19.90");
  expect(formatOreForSwish(24900)).toBe("249.00");
  expect(formatOreForSwish(5)).toBe("0.05");
  expect(formatOreForSwish(150000)).toBe("1500.00");
});

test("basketTotalOre sums quantities", () => {
  const products = [
    { id: "a", priceOre: 1990 },
    { id: "b", priceOre: 2450 },
  ];
  expect(
    basketTotalOre(
      [
        { id: "a", qty: 2 },
        { id: "b", qty: 1 },
      ],
      products,
    ),
  ).toBe(6430);
  expect(basketTotalOre([], products)).toBe(0);
});

test("basketTotalOre stays exact where floats would drift", () => {
  // 0.1 + 0.2 !== 0.3 in floating point. In öre this must be exact.
  const products = [
    { id: "a", priceOre: 10 },
    { id: "b", priceOre: 20 },
  ];
  expect(
    basketTotalOre(
      [
        { id: "a", qty: 1 },
        { id: "b", qty: 1 },
      ],
      products,
    ),
  ).toBe(30);

  const many = Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}`, priceOre: 1990 }));
  const items = many.map((p) => ({ id: p.id, qty: 3 }));
  expect(basketTotalOre(items, many)).toBe(1990 * 3 * 1000);
});

test("basketTotalOre rejects unknown products rather than skipping them", () => {
  let err = null;
  try {
    basketTotalOre([{ id: "ghost", qty: 1 }], [{ id: "a", priceOre: 100 }]);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toContain("unknown_product");
  expect(err.productId).toBe("ghost");
});

test("basketTotalOre rejects bad quantities", () => {
  const products = [{ id: "a", priceOre: 100 }];
  for (const qty of [0, -1, 1.5, NaN, "2"]) {
    expect(() => basketTotalOre([{ id: "a", qty }], products), String(qty)).toThrow(
      "bad_quantity",
    );
  }
});

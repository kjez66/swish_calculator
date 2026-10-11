import { expect, test } from "vitest";
import { stockholmDate } from "../../src/dates.js";
import { render } from "../../src/render.js";
import { defaultProducts } from "../../src/defaults.js";

test("the Workers runtime has Stockholm time zone data", () => {
  expect(stockholmDate(new Date("2026-09-12T22:30:00Z"))).toBe("2026-09-13");
  expect(stockholmDate(new Date("2026-01-12T23:30:00Z"))).toBe("2026-01-13");
});

test("render adds the QR and amount text to a charge only", () => {
  const charge = render({
    state: "charge",
    totalOre: 4500,
    payload: "C0701234567;45.00;K #1;0",
  });
  expect(charge.svg.startsWith("<svg")).toBe(true);
  expect(charge.amountText).toBe("45,00");
  expect(render({ state: "idle" })).toEqual({ state: "idle" });
});

test("defaultProducts is the kiosk menu with fresh ids", () => {
  const a = defaultProducts();
  expect(a.map((p) => [p.name, p.priceOre / 100])).toEqual([
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
  ]);
  expect(a.every((p, i) => p.sortOrder === i && p.enabled === true)).toBe(true);
  const ids = new Set([...a, ...defaultProducts()].map((p) => p.id));
  expect(ids.size).toBe(22);
});

import { expect, test } from "vitest";
import { CATEGORIES, categoryName, isCategory } from "../public/shared/categories.js";

test("the five categories, in order, with their Swedish names", () => {
  expect(CATEGORIES).toEqual([
    { id: "dryck", name: "Dryck" },
    { id: "mat", name: "Mat" },
    { id: "fika", name: "Fika" },
    { id: "godis", name: "Godis" },
    { id: "ovrigt", name: "Övrigt" },
  ]);
});

test("categoryName and isCategory know only the five ids", () => {
  expect(categoryName("ovrigt")).toBe("Övrigt");
  expect(categoryName(undefined)).toBe(undefined);
  expect(categoryName("Dryck")).toBe(undefined);
  for (const id of ["dryck", "mat", "fika", "godis", "ovrigt"]) {
    expect(isCategory(id), id).toBe(true);
  }
  for (const bad of ["", "Dryck", "drinks", null, undefined, 1, {}]) {
    expect(isCategory(bad), String(bad)).toBe(false);
  }
});

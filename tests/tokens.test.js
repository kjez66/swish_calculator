import { expect, test } from "vitest";
import { hashToken, randomPairCode, randomToken, safeEqual } from "../src/tokens.js";

test("randomToken is long, URL-safe and unique", () => {
  const a = randomToken();
  expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(a).not.toBe(randomToken());
});

test("randomPairCode is always six digits", () => {
  for (let i = 0; i < 500; i++) expect(randomPairCode()).toMatch(/^\d{6}$/);
});

test("randomPairCode covers the whole range including leading zeros", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(randomPairCode());
  // With 5000 draws from 10^6 the odds of no leading-zero code are negligible.
  expect([...seen].some((c) => c.startsWith("0"))).toBe(true);
});

test("hashToken is stable SHA-256 hex", async () => {
  const h = await hashToken("hello");
  expect(h).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  expect(await hashToken("hello")).toBe(h);
  expect(await hashToken("hellp")).not.toBe(h);
});

test("safeEqual compares correctly", () => {
  expect(safeEqual("abc", "abc")).toBe(true);
  expect(safeEqual("abc", "abd")).toBe(false);
  expect(safeEqual("abc", "abcd")).toBe(false);
  expect(safeEqual("", "")).toBe(true);
});

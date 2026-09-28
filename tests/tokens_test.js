import { assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { hashToken, randomPairCode, randomToken, safeEqual } from "../src/tokens.js";

Deno.test("randomToken is long, URL-safe and unique", () => {
  const a = randomToken();
  assertMatch(a, /^[A-Za-z0-9_-]{43}$/);
  assertNotEquals(a, randomToken());
});

Deno.test("randomPairCode is always six digits", () => {
  for (let i = 0; i < 500; i++) assertMatch(randomPairCode(), /^\d{6}$/);
});

Deno.test("randomPairCode covers the whole range including leading zeros", () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(randomPairCode());
  // With 5000 draws from 10^6 the odds of no leading-zero code are negligible.
  assertEquals([...seen].some((c) => c.startsWith("0")), true);
});

Deno.test("hashToken is stable SHA-256 hex", async () => {
  const h = await hashToken("hello");
  assertEquals(h, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  assertEquals(await hashToken("hello"), h);
  assertNotEquals(await hashToken("hellp"), h);
});

Deno.test("safeEqual compares correctly", () => {
  assertEquals(safeEqual("abc", "abc"), true);
  assertEquals(safeEqual("abc", "abd"), false);
  assertEquals(safeEqual("abc", "abcd"), false);
  assertEquals(safeEqual("", ""), true);
});

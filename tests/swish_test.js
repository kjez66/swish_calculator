import { assertEquals, assertThrows } from "@std/assert";
import {
  buildPayload,
  MESSAGE_MAX_CHARS,
  normalizePayee,
  sanitizeMessage,
} from "../public/shared/swish.js";

Deno.test("normalizePayee accepts the shapes people actually type", () => {
  assertEquals(normalizePayee("0701234567"), "0701234567");
  assertEquals(normalizePayee("070-123 45 67"), "0701234567");
  assertEquals(normalizePayee("+46 70 123 45 67"), "0701234567");
  assertEquals(normalizePayee("46701234567"), "0701234567");
  assertEquals(normalizePayee("0046701234567"), "0701234567");
});

Deno.test("normalizePayee accepts merchant numbers unchanged", () => {
  assertEquals(normalizePayee("1231181189"), "1231181189");
  assertEquals(normalizePayee("123 118 11 89"), "1231181189");
});

Deno.test("normalizePayee rejects anything that is not a Swish number", () => {
  // 08 is a landline; 12 digits is not a Swish number; letters never are.
  for (
    const bad of ["", "12345", "0801234567", "070123456789", "07012345ab", "9991234567"]
  ) {
    assertThrows(() => normalizePayee(bad), Error, "invalid_payee");
  }
});

Deno.test("sanitizeMessage removes the field separator", () => {
  // An unescaped ';' would shift every following field and corrupt the amount.
  assertEquals(sanitizeMessage("Kalle; Bagare"), "Kalle Bagare");
  assertEquals(sanitizeMessage(";;;"), "");
});

Deno.test("sanitizeMessage strips control characters and collapses whitespace", () => {
  assertEquals(sanitizeMessage("Kaffe\nBaren\t #7"), "Kaffe Baren #7");
  assertEquals(sanitizeMessage("  spaced   out  "), "spaced out");
  // U+0007 (bell) is a non-whitespace control character: deleted, not turned into a space.
  assertEquals(sanitizeMessage("bell\x07here"), "bellhere");
});

Deno.test("sanitizeMessage deletes C1 controls and bidi overrides/isolates", () => {
  // C1 controls U+0080-U+009F (incl. U+0085 NEL, which \s does not match): deleted.
  assertEquals(sanitizeMessage("a\u0080b\u0085c\u009Fd"), "abcd");
  // Bidi marks, embeddings/overrides and isolates would let a store name
  // visually reorder the note (e.g. move the order number): deleted.
  assertEquals(
    sanitizeMessage(
      "\u200EK\u200Fa\u202Af\u202Bf\u202Ce\u202D \u202E#\u20667\u2067\u2068\u2069",
    ),
    "Kaffe #7",
  );
});

Deno.test("sanitizeMessage truncates by code point, not UTF-16 unit or byte", () => {
  assertEquals(MESSAGE_MAX_CHARS, 50);

  // 'å' is one code point but two UTF-8 bytes: byte-counting would truncate early.
  const swedish = "å".repeat(60);
  assertEquals(Array.from(sanitizeMessage(swedish)).length, 50);

  // An emoji is one code point but two UTF-16 units: unit-counting would split it
  // in half and emit a lone surrogate.
  const emoji = "🎪".repeat(60);
  const out = sanitizeMessage(emoji);
  assertEquals(Array.from(out).length, 50);
  assertEquals(out.includes("�"), false);
  // A broken (UTF-16-unit) truncation would cut a surrogate pair in half and
  // leave an orphaned HIGH surrogate as the very last unit. A correct,
  // code-point-based truncation that ends on a full character never does this
  // -- when it ends on a supplementary-plane character, the last unit is that
  // character's LOW surrogate (\uDC00-\uDFFF), which this must not flag.
  assertEquals(/[\uD800-\uDBFF]/.test(out.slice(-1)), false);
});

Deno.test("buildPayload emits the exact expected string", () => {
  assertEquals(
    buildPayload({ payee: "0701234567", totalOre: 24900, message: "Kaffebaren #47" }),
    "C0701234567;249.00;Kaffebaren #47;0",
  );
});

Deno.test("buildPayload locks all three fields with flag 0", () => {
  const payload = buildPayload({ payee: "0701234567", totalOre: 100, message: "x" });
  assertEquals(payload.endsWith(";0"), true);
  assertEquals(payload.split(";").length, 4);
});

Deno.test("buildPayload normalizes and sanitizes its inputs", () => {
  assertEquals(
    buildPayload({ payee: "+46 70 123 45 67", totalOre: 1990, message: "A; B" }),
    "C0701234567;19.90;A B;0",
  );
});

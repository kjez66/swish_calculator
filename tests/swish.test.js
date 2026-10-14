import { expect, test } from "vitest";
import {
  buildPayload,
  MESSAGE_MAX_CHARS,
  normalizePayee,
  sanitizeMessage,
} from "../public/shared/swish.js";

test("normalizePayee accepts the shapes people actually type", () => {
  expect(normalizePayee("0701234567")).toBe("0701234567");
  expect(normalizePayee("070-123 45 67")).toBe("0701234567");
  expect(normalizePayee("+46 70 123 45 67")).toBe("0701234567");
  expect(normalizePayee("46701234567")).toBe("0701234567");
  expect(normalizePayee("0046701234567")).toBe("0701234567");
});

test("normalizePayee accepts merchant numbers unchanged", () => {
  expect(normalizePayee("1231181189")).toBe("1231181189");
  expect(normalizePayee("123 118 11 89")).toBe("1231181189");
});

test("normalizePayee rejects anything that is not a Swish number", () => {
  // 08 is a landline; 12 digits is not a Swish number; letters never are.
  for (
    const bad of ["", "12345", "0801234567", "070123456789", "07012345ab", "9991234567"]
  ) {
    expect(() => normalizePayee(bad), bad).toThrow("invalid_payee");
  }
});

test("sanitizeMessage removes the field separator", () => {
  // An unescaped ';' would shift every following field and corrupt the amount.
  expect(sanitizeMessage("Kalle; Bagare")).toBe("Kalle Bagare");
  expect(sanitizeMessage(";;;")).toBe("");
});

test("sanitizeMessage strips control characters and collapses whitespace", () => {
  expect(sanitizeMessage("Kaffe\nBaren\t #7")).toBe("Kaffe Baren #7");
  expect(sanitizeMessage("  spaced   out  ")).toBe("spaced out");
  // U+0007 (bell) is a non-whitespace control character: deleted, not turned into a space.
  expect(sanitizeMessage("bell\x07here")).toBe("bellhere");
});

test("sanitizeMessage deletes C1 controls and bidi overrides/isolates", () => {
  // C1 controls U+0080-U+009F (incl. U+0085 NEL, which \s does not match): deleted.
  expect(sanitizeMessage("a\u0080b\u0085c\u009Fd")).toBe("abcd");
  // Bidi marks, embeddings/overrides and isolates would let a store name
  // visually reorder the note (e.g. move the order number): deleted.
  expect(
    sanitizeMessage(
      "\u200EK\u200Fa\u202Af\u202Bf\u202Ce\u202D \u202E#\u20667\u2067\u2068\u2069",
    ),
  ).toBe("Kaffe #7");
});

test("sanitizeMessage truncates by code point, not UTF-16 unit or byte", () => {
  expect(MESSAGE_MAX_CHARS).toBe(50);

  // 'å' is one code point but two UTF-8 bytes: byte-counting would truncate early.
  const swedish = "å".repeat(60);
  expect(Array.from(sanitizeMessage(swedish)).length).toBe(50);

  // An emoji is one code point but two UTF-16 units: unit-counting would split it
  // in half and emit a lone surrogate.
  const emoji = "🎪".repeat(60);
  const out = sanitizeMessage(emoji);
  expect(Array.from(out).length).toBe(50);
  expect(out.includes("�")).toBe(false);
  // A broken (UTF-16-unit) truncation would cut a surrogate pair in half and
  // leave an orphaned HIGH surrogate as the very last unit. A correct,
  // code-point-based truncation that ends on a full character never does this
  // -- when it ends on a supplementary-plane character, the last unit is that
  // character's LOW surrogate (\uDC00-\uDFFF), which this must not flag.
  expect(/[\uD800-\uDBFF]/.test(out.slice(-1))).toBe(false);
});

test("buildPayload emits the exact expected string", () => {
  expect(
    buildPayload({ payee: "0701234567", totalOre: 24900, message: "Kaffebaren #47" }),
  ).toBe("C0701234567;249.00;Kaffebaren #47;0");
});

test("buildPayload locks all three fields with flag 0", () => {
  const payload = buildPayload({ payee: "0701234567", totalOre: 100, message: "x" });
  expect(payload.endsWith(";0")).toBe(true);
  expect(payload.split(";").length).toBe(4);
});

test("buildPayload normalizes and sanitizes its inputs", () => {
  expect(
    buildPayload({ payee: "+46 70 123 45 67", totalOre: 1990, message: "A; B" }),
  ).toBe("C0701234567;19.90;A B;0");
});

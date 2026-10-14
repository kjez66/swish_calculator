/**
 * Swish QR payload assembly.
 *
 * Format: C<payee>;<amount>;<message>;<flags>
 * Example: C0701234567;249.00;Kaffebaren #47;0
 *
 * This format is community-documented, not published by Getswish. See spec §4:
 * three details remain unverified until a real Swish app has scanned a generated
 * code. Do not take real payments before that check.
 * @module
 */
import { formatOreForSwish } from "./money.js";

/**
 * Editable-field bitmask: 1 payee, 2 amount, 4 message. We lock all three.
 */
export const FLAGS_ALL_LOCKED = 0;

/**
 * UNVERIFIED (spec §4). Carried over from the Swish merchant API, which is a
 * different surface; the QR format's own limit is undocumented. A shorter note is
 * always safe, so this is a conservative default. Kept as one constant so that
 * changing it after verification is a one-line edit.
 */
export const MESSAGE_MAX_CHARS = 50;

/**
 * @param {string} code
 * @returns {Error}
 */
function fail(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * Normalize a Swish number to its 10-digit form.
 * Accepts 07x, +46 7x, 46 7x, 0046 7x, and 123-prefixed merchant numbers, with
 * any spacing or dashes.
 * @param {string} input
 * @returns {string} 10 digits
 */
export function normalizePayee(input) {
  if (typeof input !== "string") throw fail("invalid_payee");
  let digits = input.replace(/[\s\-()]/g, "").replace(/^\+/, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (/^46\d{9}$/.test(digits)) digits = "0" + digits.slice(2);
  if (!/^\d{10}$/.test(digits)) throw fail("invalid_payee");
  // 07x = Swish privat, 123x = Swish Handel/Foretag. Nothing else is payable.
  if (!/^(07|123)/.test(digits)) throw fail("invalid_payee");
  return digits;
}

/**
 * Clean a note for the message field.
 * Deletes the field separator, non-whitespace control characters (C0, DEL, C1)
 * and bidi formatting characters outright;
 * whitespace control characters (tab, CR, LF, ...) collapse into a single space
 * along with any other run of whitespace.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMessage(text) {
  const cleaned = String(text ?? "")
    // ';' is the field separator: an unescaped one silently corrupts the amount.
    .replace(/;/g, "")
    // C0 controls other than \t \n \v \f \r, plus DEL and the C1 controls
    // (U+0080-U+009F). These carry no meaning in a note and are deleted rather
    // than turned into whitespace.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: deleting control characters is what this regex is for
    .replace(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g, "")
    // Bidi marks (LRM, RLM), embeddings/overrides and isolates: invisible, and
    // able to visually reorder the note, e.g. to move or hide the order number.
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // Array.from splits by code point, so 'å' counts as one and an emoji is never
  // cut in half into a lone surrogate.
  return Array.from(cleaned).slice(0, MESSAGE_MAX_CHARS).join("");
}

/**
 * @param {{payee: string, totalOre: number, message: string}} args
 * @returns {string} the QR payload
 */
export function buildPayload({ payee, totalOre, message }) {
  const normalizedPayee = normalizePayee(payee);
  const amount = formatOreForSwish(totalOre);
  const note = sanitizeMessage(message);
  return `C${normalizedPayee};${amount};${note};${FLAGS_ALL_LOCKED}`;
}

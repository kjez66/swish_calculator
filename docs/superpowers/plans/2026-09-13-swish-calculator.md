# Swish Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A two-device point-of-sale where an operator taps ~20 products into a basket on their phone and an old spare phone facing the customer shows a Swish QR code for the exact total.

**Architecture:** One Deno application on Deno Deploy serving two static pages plus a JSON + SSE API. Because Deno Deploy runs many isolates, the operator's POST and the display's SSE stream routinely land on different instances: fan-out therefore goes over `BroadcastChannel` (with local fan-out alongside, since a channel never delivers to its own poster) and all cross-request state lives in Deno KV. Every SSE event carries the room's complete state and is replayed on connect, so a dropped stream is invisible rather than fatal.

**Tech Stack:** Deno 2.9, Deno KV, `npm:qrcode-generator@1.4.4` (encoder), `npm:jsqr@1.4.0` (test-only decoder), `jsr:@std/assert`, `jsr:@std/http/file-server`. No build step, no frontend framework.

**Spec:** `docs/superpowers/specs/2026-09-13-swish-calculator-design.md` — read it alongside this plan. Where this plan gives concrete signatures, the spec gives the reasoning.

## Global Constraints

- **Money is integer öre everywhere.** No float ever touches a price or total. `priceOre: 1990` is 19,90 kr.
- **No cross-request state in module-level variables.** Room state, idempotency records, presence and rate limits live in Deno KV. The only permitted in-memory state is an isolate's own set of live SSE subscribers.
- **`BroadcastChannel` does not deliver to the object that posted.** Verified. Publishing always means: post to the channel *and* fan out locally.
- **The server is the sole author of payment data.** Clients never build a Swish payload or render a QR.
- **Payload format:** `C<payee>;<amount>;<message>;<flags>`, flags always `0`. Example: `C0701234567;249.00;Kaffebaren #47;0`.
- **Edit flags bitmask:** `1` payee, `2` amount, `4` message.
- **`MESSAGE_MAX_CHARS = 50`**, counted by Unicode code point. This value is UNVERIFIED (see spec §4) and must be a single named constant.
- **Order counter date is `Europe/Stockholm`**, never UTC.
- **QR: ECC level `Q`, quiet zone 4 modules, opaque white background.** Never transparent.
- **UTF-8 override is mandatory on the encoder:** `qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"]` before use, or `å ä ö` in a store name encode as mojibake.
- **`kv.sum()` stores and returns `Deno.KvU64`,** not a number. Read it as `Number(entry.value.value)`.
- **`Deno.openKv` requires `"unstable": ["kv"]`** in `deno.json`.
- Prices display Swedish (`19,90`), payload uses a dot (`19.90`).

## File Structure

```
deno.json            # tasks, imports, unstable kv flag
main.js              # entry: opens KV, wires store+hub, Deno.serve
README.md            # verification checklist + phone setup
src/
  tokens.js          # random tokens, SHA-256 hashing, constant-time compare
  store.js           # every Deno KV read and write
  hub.js             # SSE subscriber registry + BroadcastChannel fan-out + replay
  qr.js              # payload -> module matrix -> SVG
  server.js          # createHandler({store, hub}) -> (Request) => Response
public/
  shared/money.js    # öre arithmetic + formatting      (browser AND server)
  shared/swish.js    # payee, message, payload assembly  (server only in v1)
  index.html app.js style.css      # operator
  display.html display.js          # customer display
tests/
  money_test.js swish_test.js qr_test.js store_test.js hub_test.js server_test.js
```

**Two deviations from spec §15, applied deliberately:**

1. The spec listed `src/vendor/qrcode.js` as a vendored file. We use the pinned npm specifier `npm:qrcode-generator@1.4.4` instead — Deno Deploy resolves npm specifiers at deploy time, so it is equally pinned without pasting 30 KB of third-party code into the repo.
2. The spec put pairing, tokens, presence and fan-out all in `rooms.js`. That is four responsibilities in one file. Split into `tokens.js`, `store.js` (pairing + presence, since both are pure KV) and `hub.js` (fan-out). Task 11 updates the spec to match.

Shared modules live under `public/` so the ordinary static handler serves them to the browser with no special route, exactly as spec §3 requires.

---

### Task 1: Project scaffold and the money module

Money arithmetic is the foundation every later task builds on, and the one place a float would quietly cost real kronor. Scaffolding is folded in here because this task is the first thing that needs it.

**Files:**
- Create: `deno.json`
- Create: `public/shared/money.js`
- Test: `tests/money_test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseKronorToOre(input: string) -> number` — throws `Error & {code:"invalid_amount"}`
  - `formatOre(ore: number) -> string` — Swedish display, e.g. `"1 500,00"` (U+00A0 thousands separator)
  - `formatOreForSwish(ore: number) -> string` — payload form, e.g. `"1500.00"`, always two decimals, dot separator
  - `basketTotalOre(items: {id:string,qty:number}[], products: {id:string,priceOre:number}[]) -> number` — throws `Error & {code:"unknown_product"|"bad_quantity", productId:string}`

- [ ] **Step 1: Create `deno.json`**

```json
{
  "unstable": ["kv"],
  "tasks": {
    "dev": "deno run -A --watch main.js",
    "start": "deno run -A main.js",
    "test": "deno test -A"
  },
  "imports": {
    "qrcode-generator": "npm:qrcode-generator@1.4.4",
    "jsqr": "npm:jsqr@1.4.0",
    "@std/assert": "jsr:@std/assert@1",
    "@std/http/file-server": "jsr:@std/http@1/file-server"
  },
  "fmt": { "indentWidth": 2, "lineWidth": 90 }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/money_test.js`:

```js
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
  assertEquals(formatOre(150000), "1 500,00");
  assertEquals(formatOre(123456789), "1 234 567,89");
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno task test tests/money_test.js`
Expected: FAIL — module `public/shared/money.js` not found.

- [ ] **Step 4: Write the implementation**

Create `public/shared/money.js`:

```js
/**
 * Money handling. All amounts are integer öre; floating point never touches a
 * price or a total. Shared verbatim between the browser and the server so the
 * running total on screen and the authoritative total on the server cannot drift.
 * @module
 */

/**
 * @param {string} code
 * @param {Record<string, unknown>} [extra]
 * @returns {Error}
 */
function fail(code, extra = {}) {
  return Object.assign(new Error(code), extra);
}

/**
 * Parse a human-typed kronor amount into integer öre.
 * Accepts comma or dot decimals, surrounding whitespace, and a trailing "kr".
 * @param {string} input
 * @returns {number} öre
 */
export function parseKronorToOre(input) {
  if (typeof input !== "string") throw fail("invalid_amount");
  const cleaned = input.trim().replace(/\s+/g, "").replace(/kr$/i, "");
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(cleaned);
  if (!m) throw fail("invalid_amount");
  const kronor = Number(m[1]);
  const decimals = (m[2] ?? "").padEnd(2, "0");
  return kronor * 100 + Number(decimals);
}

/**
 * Swedish display form: comma decimals, non-breaking-space thousands.
 * @param {number} ore
 * @returns {string} e.g. "1 500,00"
 */
export function formatOre(ore) {
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(ore));
  const kronor = String(Math.floor(abs / 100));
  const decimals = String(abs % 100).padStart(2, "0");
  const grouped = kronor.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${sign}${grouped},${decimals}`;
}

/**
 * Swish payload form: dot decimals, always exactly two, no grouping.
 * @param {number} ore
 * @returns {string} e.g. "1500.00"
 */
export function formatOreForSwish(ore) {
  const abs = Math.abs(Math.trunc(ore));
  return `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * @param {{id: string, qty: number}[]} items
 * @param {{id: string, priceOre: number}[]} products
 * @returns {number} total in öre
 */
export function basketTotalOre(items, products) {
  const priceById = new Map(products.map((p) => [p.id, p.priceOre]));
  let total = 0;
  for (const item of items) {
    const price = priceById.get(item.id);
    // An unknown id is rejected, never skipped: a dropped line undercharges silently.
    if (price === undefined) throw fail("unknown_product", { productId: item.id });
    if (!Number.isInteger(item.qty) || item.qty < 1) {
      throw fail("bad_quantity", { productId: item.id });
    }
    total += price * item.qty;
  }
  return total;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno task test tests/money_test.js`
Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
git add deno.json public/shared/money.js tests/money_test.js
git commit -m "feat: integer-öre money module with Swedish and Swish formatting"
```

---

### Task 2: Swish payload assembly

The module that decides what a customer is asked to pay. Every rule here exists because getting it wrong moves money to the wrong place or the wrong amount.

**Files:**
- Create: `public/shared/swish.js`
- Test: `tests/swish_test.js`

**Interfaces:**
- Consumes: `formatOreForSwish` from `public/shared/money.js`.
- Produces:
  - `MESSAGE_MAX_CHARS: number` (50)
  - `normalizePayee(input: string) -> string` — 10 digits; throws `Error & {code:"invalid_payee"}`
  - `sanitizeMessage(text: string) -> string`
  - `buildPayload({payee: string, totalOre: number, message: string}) -> string`

- [ ] **Step 1: Write the failing test**

Create `tests/swish_test.js`:

```js
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
  for (const bad of ["", "12345", "0801234567", "070123456789", "07012345ab", "9991234567"]) {
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
  assertEquals(sanitizeMessage("bellhere"), "bellhere");
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
  assertEquals(/[\uD800-\uDFFF]/.test(out.slice(-1)), false);
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test tests/swish_test.js`
Expected: FAIL — module `public/shared/swish.js` not found.

- [ ] **Step 3: Write the implementation**

Create `public/shared/swish.js`:

```js
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
  // 07x = Swish privat, 123x = Swish Handel/Företag. Nothing else is payable.
  if (!/^(07|123)/.test(digits)) throw fail("invalid_payee");
  return digits;
}

/**
 * Clean a note for the message field.
 * @param {string} text
 * @returns {string}
 */
export function sanitizeMessage(text) {
  const cleaned = String(text ?? "")
    // ';' is the field separator: an unescaped one silently corrupts the amount.
    .replace(/;/g, "")
    // deno-lint-ignore no-control-regex
    .replace(/[ -]/g, " ")
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test tests/swish_test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add public/shared/swish.js tests/swish_test.js
git commit -m "feat: Swish payload assembly with payee normalization and note sanitizing"
```

---

### Task 3: QR rendering with a decode round-trip test

The test here decodes rather than snapshots. A snapshot of SVG markup proves only that the renderer did not change; it says nothing about whether the code scans, and it breaks on cosmetic edits.

**Files:**
- Create: `src/qr.js`
- Test: `tests/qr_test.js`

**Interfaces:**
- Consumes: `npm:qrcode-generator@1.4.4`.
- Produces:
  - `QUIET_ZONE_MODULES: number` (4)
  - `toMatrix(payload: string) -> boolean[][]` — square, dark = `true`, no quiet zone included
  - `toSvg(payload: string) -> string` — complete `<svg>` with quiet zone and opaque white background

- [ ] **Step 1: Write the failing test**

Create `tests/qr_test.js`:

```js
import { assertEquals, assertStringIncludes } from "@std/assert";
import jsQR from "jsqr";
import { QUIET_ZONE_MODULES, toMatrix, toSvg } from "../src/qr.js";

const PAYLOAD = "C0701234567;249.00;Kaffebaren #47;0";

/**
 * Rasterize a module matrix straight to RGBA pixels. No SVG rasterization is
 * needed to prove the encoder is correct, and this keeps the test dependency-light.
 */
function rasterize(matrix, scale = 8, quiet = QUIET_ZONE_MODULES) {
  const n = matrix.length;
  const side = (n + quiet * 2) * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!matrix[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy;
          const x = (c + quiet) * scale + dx;
          const i = (y * side + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0;
        }
      }
    }
  }
  return { px, side };
}

Deno.test("a generated QR decodes back to the exact payload", () => {
  const { px, side } = rasterize(toMatrix(PAYLOAD));
  const decoded = jsQR(px, side, side);
  assertEquals(decoded?.data, PAYLOAD);
});

Deno.test("Swedish characters survive the round-trip", () => {
  // Without the UTF-8 stringToBytes override the encoder emits Latin-1 and these
  // come back as mojibake.
  const payload = "C0701234567;99.00;Åsas Bröd åäö #3;0";
  const { px, side } = rasterize(toMatrix(payload));
  assertEquals(jsQR(px, side, side)?.data, payload);
});

Deno.test("a long note at the message limit still decodes", () => {
  const payload = `C0701234567;19999.00;${"ä".repeat(50)};0`;
  const { px, side } = rasterize(toMatrix(payload));
  assertEquals(jsQR(px, side, side)?.data, payload);
});

Deno.test("toMatrix returns a square boolean matrix", () => {
  const m = toMatrix(PAYLOAD);
  assertEquals(Array.isArray(m), true);
  for (const row of m) assertEquals(row.length, m.length);
  assertEquals(typeof m[0][0], "boolean");
});

Deno.test("toSvg includes a four-module quiet zone in its viewBox", () => {
  const n = toMatrix(PAYLOAD).length;
  const svg = toSvg(PAYLOAD);
  assertEquals(QUIET_ZONE_MODULES, 4);
  assertStringIncludes(svg, `viewBox="0 0 ${n + 8} ${n + 8}"`);
});

Deno.test("toSvg paints an opaque white background", () => {
  // A transparent QR inheriting a dark page background is unscannable.
  const svg = toSvg(PAYLOAD);
  assertStringIncludes(svg, '<rect width="100%" height="100%" fill="#ffffff"');
  assertEquals(svg.includes('fill="none"'), false);
  assertEquals(svg.includes("transparent"), false);
});

Deno.test("toSvg draws crisp edges and scales without a fixed pixel size", () => {
  const svg = toSvg(PAYLOAD);
  assertStringIncludes(svg, 'shape-rendering="crispEdges"');
  assertEquals(/\swidth="\d+px"/.test(svg), false);
});

Deno.test("the SVG path covers exactly the dark modules of the matrix", () => {
  const matrix = toMatrix(PAYLOAD);
  const expectedDark = matrix.flat().filter(Boolean).length;
  const svg = toSvg(PAYLOAD);
  // One "M<x> <y>h1v1H<x>z" sub-path is emitted per dark module.
  const drawn = (svg.match(/M\d+ \d+h1v1H\d+z/g) ?? []).length;
  assertEquals(drawn, expectedDark);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test tests/qr_test.js`
Expected: FAIL — module `src/qr.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/qr.js`:

```js
/**
 * QR rendering. Payload string -> module matrix -> SVG.
 *
 * Deterministic: any isolate re-renders identical output from the same payload,
 * which is why KV stores the payload rather than the rendered SVG.
 * @module
 */
import qrcode from "qrcode-generator";

/** ECC level Q (25%). The payload is ~35-60 chars, so even at Q the symbol stays
 * a low version with large modules — the extra robustness is free here. */
const ECC_LEVEL = "Q";

/** QR codes drawn flush to a screen edge frequently fail to scan. */
export const QUIET_ZONE_MODULES = 4;

// Without this the encoder falls back to Latin-1 and Swedish characters in a
// store name encode as mojibake. Set once at module load.
qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

/**
 * @param {string} payload
 * @returns {boolean[][]} square matrix, true = dark, no quiet zone
 */
export function toMatrix(payload) {
  const qr = qrcode(0, ECC_LEVEL); // 0 = choose the smallest version that fits
  qr.addData(payload, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  const matrix = [];
  for (let r = 0; r < n; r++) {
    const row = [];
    for (let c = 0; c < n; c++) row.push(qr.isDark(r, c));
    matrix.push(row);
  }
  return matrix;
}

/**
 * @param {string} payload
 * @returns {string} a complete <svg> element
 */
export function toSvg(payload) {
  const matrix = toMatrix(payload);
  const n = matrix.length;
  const q = QUIET_ZONE_MODULES;
  const side = n + q * 2;

  let path = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r][c]) path += `M${c + q} ${r + q}h1v1H${c + q}z`;
    }
  }

  // viewBox is in module units so the code scales to any screen without
  // resampling artifacts. The background rect is opaque by design.
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"`,
    ` shape-rendering="crispEdges" role="img" aria-label="Swish QR-kod">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test tests/qr_test.js`
Expected: PASS, 8 tests. First run downloads the npm packages.

- [ ] **Step 5: Commit**

```bash
git add src/qr.js tests/qr_test.js
git commit -m "feat: QR rendering with jsQR decode round-trip test"
```

---

### Task 4: Tokens

Small, separate, and used by both the store and the server. Split out because token handling has exactly one responsibility and benefits from being read in one screen.

**Files:**
- Create: `src/tokens.js`
- Test: `tests/tokens_test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `randomToken() -> string` — 32 bytes, base64url
  - `randomPairCode() -> string` — 6 digits, uniformly distributed
  - `hashToken(token: string) -> Promise<string>` — SHA-256 hex
  - `safeEqual(a: string, b: string) -> boolean` — constant time over equal-length hex

- [ ] **Step 1: Write the failing test**

Create `tests/tokens_test.js`:

```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test tests/tokens_test.js`
Expected: FAIL — module `src/tokens.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/tokens.js`:

```js
/**
 * Token generation, hashing and comparison.
 *
 * Tokens are stored hashed so that a leaked KV dump does not confer the ability
 * to push a QR to someone's display — the threat that matters here is payment
 * redirection, not data theft.
 * @module
 */

/**
 * @returns {string} 32 random bytes, base64url, no padding
 */
export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @returns {string} a uniformly distributed 6-digit code, leading zeros kept
 */
export function randomPairCode() {
  const buf = new Uint32Array(1);
  // Reject values in the final partial bucket so the modulo stays uniform.
  const limit = Math.floor(0xFFFFFFFF / 1_000_000) * 1_000_000;
  let n;
  do {
    crypto.getRandomValues(buf);
    n = buf[0];
  } while (n >= limit);
  return String(n % 1_000_000).padStart(6, "0");
}

/**
 * @param {string} token
 * @returns {Promise<string>} SHA-256 hex
 */
export async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison over the shared prefix. Length is compared up front,
 * which is not secret for fixed-width hashes.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test tests/tokens_test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/tokens.js tests/tokens_test.js
git commit -m "feat: token generation, hashing and constant-time comparison"
```

---

### Task 5: The KV store

Every persistent fact in one module. Tests inject an in-memory KV, so they are fast and isolated.

**Files:**
- Create: `src/store.js`
- Test: `tests/store_test.js`

**Interfaces:**
- Consumes: `hashToken`, `randomToken`, `randomPairCode` from `src/tokens.js`.
- Produces `createStore(kv: Deno.Kv) -> Store` with:
  - `createRoom() -> Promise<{roomId, operatorToken}>`
  - `authenticate(roomId, token) -> Promise<"operator"|"display"|null>`
  - `getSettings(roomId) -> Promise<{storeName, payeeNumber}|null>`
  - `setSettings(roomId, settings) -> Promise<void>`
  - `getProducts(roomId) -> Promise<{id,name,priceOre,sortOrder}[]>`
  - `setProducts(roomId, products) -> Promise<void>`
  - `getCurrent(roomId) -> Promise<RoomState>` — defaults to `{state:"idle"}`
  - `setCurrent(roomId, state) -> Promise<void>`
  - `nextOrderNo(roomId, date: Date) -> Promise<number>`
  - `claimCharge(roomId, chargeId, produce: () => Promise<object>) -> Promise<object>`
  - `createPairCode(roomId) -> Promise<string>`
  - `claimPairCode(code) -> Promise<{roomId, displayToken}|null>`
  - `touchPresence(roomId, displayId) -> Promise<void>`
  - `countPresence(roomId) -> Promise<number>`
  - `underRateLimit(scope, ipHash, limit, now) -> Promise<boolean>`
  - `stockholmDate(date: Date) -> string` (exported standalone too)

- [ ] **Step 1: Write the failing test**

Create `tests/store_test.js`:

```js
import { assertEquals, assertNotEquals } from "@std/assert";
import { createStore, stockholmDate } from "../src/store.js";

async function withStore(fn) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(createStore(kv), kv);
  } finally {
    kv.close();
  }
}

Deno.test("createRoom issues a room and an operator token that authenticates", async () => {
  await withStore(async (store) => {
    const { roomId, operatorToken } = await store.createRoom();
    assertEquals(typeof roomId, "string");
    assertEquals(await store.authenticate(roomId, operatorToken), "operator");
    assertEquals(await store.authenticate(roomId, "wrong"), null);
    assertEquals(await store.authenticate("nosuchroom", operatorToken), null);
  });
});

Deno.test("settings and products round-trip", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    assertEquals(await store.getSettings(roomId), null);
    assertEquals(await store.getProducts(roomId), []);

    await store.setSettings(roomId, { storeName: "Kaffebaren", payeeNumber: "0701234567" });
    assertEquals(await store.getSettings(roomId), {
      storeName: "Kaffebaren",
      payeeNumber: "0701234567",
    });

    const products = [{ id: "a", name: "Kaffe", priceOre: 2500, sortOrder: 0 }];
    await store.setProducts(roomId, products);
    assertEquals(await store.getProducts(roomId), products);
  });
});

Deno.test("current state defaults to idle and round-trips", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    assertEquals(await store.getCurrent(roomId), { state: "idle" });

    const charge = {
      state: "charge",
      orderNo: 7,
      totalOre: 24900,
      message: "Kaffebaren #7",
      payload: "C0701234567;249.00;Kaffebaren #7;0",
      updatedAt: 1234,
    };
    await store.setCurrent(roomId, charge);
    assertEquals(await store.getCurrent(roomId), charge);
  });
});

Deno.test("stockholmDate uses Stockholm local time, not UTC", () => {
  // 22:30 UTC on 12 Sep is already 00:30 on 13 Sep in Stockholm (CEST, UTC+2).
  // Using UTC here would reset order numbers mid-evening during a late market.
  assertEquals(stockholmDate(new Date("2026-09-12T22:30:00Z")), "2026-09-13");
  assertEquals(stockholmDate(new Date("2026-09-12T21:30:00Z")), "2026-09-12");
  // Winter is UTC+1.
  assertEquals(stockholmDate(new Date("2026-01-12T23:30:00Z")), "2026-01-13");
});

Deno.test("nextOrderNo increments per day and resets on a new Stockholm date", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const day1 = new Date("2026-09-13T09:00:00Z");
    assertEquals(await store.nextOrderNo(roomId, day1), 1);
    assertEquals(await store.nextOrderNo(roomId, day1), 2);
    assertEquals(await store.nextOrderNo(roomId, day1), 3);

    const day2 = new Date("2026-09-14T09:00:00Z");
    assertEquals(await store.nextOrderNo(roomId, day2), 1);
  });
});

Deno.test("nextOrderNo never issues a duplicate under concurrency", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const day = new Date("2026-09-13T09:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.nextOrderNo(roomId, day)),
    );
    assertEquals(new Set(results).size, 50);
    assertEquals(Math.max(...results), 50);
  });
});

Deno.test("claimCharge runs the producer once and replays the stored response", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    let calls = 0;
    const produce = async () => {
      calls++;
      return { orderNo: await store.nextOrderNo(roomId, new Date()), totalOre: 100 };
    };

    const first = await store.claimCharge(roomId, "charge-1", produce);
    const second = await store.claimCharge(roomId, "charge-1", produce);

    // A retry must return the original response, not mint a second order number.
    assertEquals(calls, 1);
    assertEquals(second, first);
    assertEquals(first.orderNo, 1);

    const other = await store.claimCharge(roomId, "charge-2", produce);
    assertEquals(calls, 2);
    assertNotEquals(other.orderNo, first.orderNo);
  });
});

Deno.test("pair codes are single-use and yield a working display token", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const code = await store.createPairCode(roomId);
    assertEquals(/^\d{6}$/.test(code), true);

    const claimed = await store.claimPairCode(code);
    assertEquals(claimed?.roomId, roomId);
    assertEquals(await store.authenticate(roomId, claimed.displayToken), "display");

    // Single use: a shoulder-surfed code is worth nothing once claimed.
    assertEquals(await store.claimPairCode(code), null);
    assertEquals(await store.claimPairCode("000000"), null);
  });
});

Deno.test("presence counts distinct displays", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    assertEquals(await store.countPresence(roomId), 0);
    await store.touchPresence(roomId, "d1");
    await store.touchPresence(roomId, "d2");
    await store.touchPresence(roomId, "d1");
    assertEquals(await store.countPresence(roomId), 2);
  });
});

Deno.test("rate limiting counts per scope, per client, per minute", async () => {
  await withStore(async (store) => {
    const t = new Date("2026-09-13T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      assertEquals(await store.underRateLimit("rooms", "ip-a", 5, t), true);
    }
    assertEquals(await store.underRateLimit("rooms", "ip-a", 5, t), false);
    // A different client is unaffected.
    assertEquals(await store.underRateLimit("rooms", "ip-b", 5, t), true);
    // A different scope is unaffected.
    assertEquals(await store.underRateLimit("pair", "ip-a", 5, t), true);
    // The next minute starts a fresh window.
    assertEquals(
      await store.underRateLimit("rooms", "ip-a", 5, new Date("2026-09-13T10:01:00Z")),
      true,
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test tests/store_test.js`
Expected: FAIL — module `src/store.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/store.js`:

```js
/**
 * Every Deno KV read and write.
 *
 * Nothing here may be cached in a module-level variable: Deno Deploy runs many
 * isolates and any such cache would be per-isolate and wrong.
 * @module
 */
import { hashToken, randomPairCode, randomToken, safeEqual } from "./tokens.js";

const PAIR_CODE_TTL_MS = 5 * 60_000;
const CHARGE_RECORD_TTL_MS = 120_000;
const PRESENCE_TTL_MS = 30_000;
const RATE_WINDOW_TTL_MS = 120_000;

/**
 * The order counter must roll over at Stockholm midnight. UTC rolls over at 01:00
 * or 02:00 local, which would reset order numbers mid-evening during a late market.
 * sv-SE formats as YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
export function stockholmDate(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * @param {Deno.Kv} kv
 */
export function createStore(kv) {
  /**
   * @param {string} roomId
   * @returns {Promise<{createdAt:number, operatorTokenHash:string, displayTokenHashes:string[]}|null>}
   */
  async function getRoom(roomId) {
    return (await kv.get(["room", roomId])).value;
  }

  return {
    async createRoom() {
      const roomId = crypto.randomUUID();
      const operatorToken = randomToken();
      await kv.set(["room", roomId], {
        createdAt: Date.now(),
        operatorTokenHash: await hashToken(operatorToken),
        displayTokenHashes: [],
      });
      return { roomId, operatorToken };
    },

    /**
     * @returns {Promise<"operator"|"display"|null>}
     */
    async authenticate(roomId, token) {
      if (!roomId || !token) return null;
      const room = await getRoom(roomId);
      if (!room) return null;
      const hash = await hashToken(token);
      if (safeEqual(hash, room.operatorTokenHash)) return "operator";
      for (const h of room.displayTokenHashes) {
        if (safeEqual(hash, h)) return "display";
      }
      return null;
    },

    async getSettings(roomId) {
      return (await kv.get(["room", roomId, "settings"])).value;
    },

    async setSettings(roomId, settings) {
      await kv.set(["room", roomId, "settings"], settings);
    },

    async getProducts(roomId) {
      return (await kv.get(["room", roomId, "products"])).value ?? [];
    },

    async setProducts(roomId, products) {
      await kv.set(["room", roomId, "products"], products);
    },

    async getCurrent(roomId) {
      return (await kv.get(["room", roomId, "current"])).value ?? { state: "idle" };
    },

    async setCurrent(roomId, state) {
      await kv.set(["room", roomId, "current"], state);
    },

    /**
     * @param {string} roomId
     * @param {Date} date
     * @returns {Promise<number>}
     */
    async nextOrderNo(roomId, date) {
      const key = ["room", roomId, "counter", stockholmDate(date)];
      while (true) {
        const res = await kv.atomic().sum(key, 1n).commit();
        if (!res.ok) continue;
        const entry = await kv.get(key);
        // sum() stores a Deno.KvU64, not a plain number.
        return Number(entry.value.value);
      }
    },

    /**
     * Run `produce` at most once for a given chargeId and return the stored
     * response on every retry. Storing the response rather than a bare marker is
     * what makes a double-tap safe: a marker would either error or mint a second
     * order number, which is the outcome the dedupe exists to prevent.
     * @param {string} roomId
     * @param {string} chargeId
     * @param {() => Promise<object>} produce
     */
    async claimCharge(roomId, chargeId, produce) {
      const key = ["charge", roomId, chargeId];
      const existing = await kv.get(key);
      if (existing.value) return existing.value;

      const claim = await kv.atomic()
        .check({ key, versionstamp: null })
        .set(key, { pending: true }, { expireIn: CHARGE_RECORD_TTL_MS })
        .commit();

      if (!claim.ok) {
        // Another request won the race. Wait briefly for it to store its response.
        for (let i = 0; i < 20; i++) {
          const again = await kv.get(key);
          if (again.value && !again.value.pending) return again.value;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw Object.assign(new Error("charge_in_progress"), {
          code: "charge_in_progress",
        });
      }

      const response = await produce();
      await kv.set(key, response, { expireIn: CHARGE_RECORD_TTL_MS });
      return response;
    },

    async createPairCode(roomId) {
      const code = randomPairCode();
      await kv.set(["pair", code], { roomId }, { expireIn: PAIR_CODE_TTL_MS });
      return code;
    },

    /**
     * @returns {Promise<{roomId:string, displayToken:string}|null>}
     */
    async claimPairCode(code) {
      const key = ["pair", code];
      const entry = await kv.get(key);
      if (!entry.value) return null;

      // Delete under a versionstamp check so a code can only be claimed once even
      // if two devices submit it simultaneously.
      const consumed = await kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .delete(key)
        .commit();
      if (!consumed.ok) return null;

      const { roomId } = entry.value;
      const displayToken = randomToken();
      const hash = await hashToken(displayToken);
      const roomKey = ["room", roomId];
      const room = await kv.get(roomKey);
      if (!room.value) return null;
      await kv.atomic()
        .check({ key: roomKey, versionstamp: room.versionstamp })
        .set(roomKey, {
          ...room.value,
          displayTokenHashes: [...room.value.displayTokenHashes, hash],
        })
        .commit();
      return { roomId, displayToken };
    },

    async touchPresence(roomId, displayId) {
      await kv.set(["presence", roomId, displayId], 1, { expireIn: PRESENCE_TTL_MS });
    },

    async countPresence(roomId) {
      let n = 0;
      for await (const _ of kv.list({ prefix: ["presence", roomId] })) n++;
      return n;
    },

    /**
     * An in-memory counter would reset on every isolate cycle and differ per
     * region, which is to say it would not limit anything.
     * @returns {Promise<boolean>} true if the request is allowed
     */
    async underRateLimit(scope, ipHash, limit, now = new Date()) {
      const minute = Math.floor(now.getTime() / 60_000);
      const key = ["ratelimit", scope, ipHash, minute];
      const res = await kv.atomic().sum(key, 1n).commit();
      if (!res.ok) return false;
      const entry = await kv.get(key);
      const count = Number(entry.value.value);
      if (count === 1) {
        await kv.set(key, entry.value, { expireIn: RATE_WINDOW_TTL_MS });
      }
      return count <= limit;
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test tests/store_test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/store.js tests/store_test.js
git commit -m "feat: KV store with atomic counter, charge idempotency and rate limits"
```

---

### Task 6: The fan-out hub

The piece that makes two devices on two isolates behave like one system.

**Files:**
- Create: `src/hub.js`
- Test: `tests/hub_test.js`

**Interfaces:**
- Consumes: `Store` from `src/store.js`, `toSvg` from `src/qr.js`.
- Produces `createHub(store, {channelName?}) -> Hub` with:
  - `subscribe(roomId, onEvent: (name:string, data:object) => void) -> Promise<() => void>` — sends the current state immediately, returns an unsubscribe function
  - `publish(roomId, roomState) -> Promise<void>` — persists, broadcasts, fans out locally
  - `close() -> void`
  - `render(roomState) -> object` — roomState plus its rendered `svg`

- [ ] **Step 1: Write the failing test**

Create `tests/hub_test.js`:

```js
import { assertEquals } from "@std/assert";
import { createStore } from "../src/store.js";
import { createHub } from "../src/hub.js";

async function withHub(fn) {
  const kv = await Deno.openKv(":memory:");
  const store = createStore(kv);
  const hub = createHub(store, { channelName: `test-${crypto.randomUUID()}` });
  try {
    await fn(hub, store);
  } finally {
    hub.close();
    kv.close();
  }
}

const CHARGE = {
  state: "charge",
  orderNo: 7,
  totalOre: 24900,
  message: "Kaffebaren #7",
  payload: "C0701234567;249.00;Kaffebaren #7;0",
  updatedAt: 1000,
};

Deno.test("subscribing immediately replays the current state", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push({ name, data }));

    // This replay is what makes an SSE reconnect invisible instead of fatal:
    // without it a reconnecting display shows a blank welcome screen mid-scan.
    assertEquals(events.length, 1);
    assertEquals(events[0].name, "state");
    assertEquals(events[0].data.state, "idle");
    off();
  });
});

Deno.test("a subscriber joining after a charge sees the charge, not idle", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    await hub.publish(roomId, CHARGE);

    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push({ name, data }));
    assertEquals(events[0].data.state, "charge");
    assertEquals(events[0].data.orderNo, 7);
    off();
  });
});

Deno.test("publish fans out locally, because a channel never echoes to its poster", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push({ name, data }));
    events.length = 0; // drop the replay

    await hub.publish(roomId, CHARGE);
    assertEquals(events.length, 1);
    assertEquals(events[0].data.orderNo, 7);
    off();
  });
});

Deno.test("published events carry a rendered SVG", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (name, data) => events.push(data));
    events.length = 0;

    await hub.publish(roomId, CHARGE);
    assertEquals(events[0].svg.startsWith("<svg"), true);
    off();
  });
});

Deno.test("publish persists state so a later isolate can replay it", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    await hub.publish(roomId, CHARGE);
    assertEquals((await store.getCurrent(roomId)).orderNo, 7);
  });
});

Deno.test("events reach every subscriber of a room and no others", async () => {
  await withHub(async (hub, store) => {
    const a = await store.createRoom();
    const b = await store.createRoom();
    const aEvents = [];
    const bEvents = [];
    const offA1 = await hub.subscribe(a.roomId, (_n, d) => aEvents.push(d));
    const offA2 = await hub.subscribe(a.roomId, (_n, d) => aEvents.push(d));
    const offB = await hub.subscribe(b.roomId, (_n, d) => bEvents.push(d));
    aEvents.length = 0;
    bEvents.length = 0;

    await hub.publish(a.roomId, CHARGE);
    assertEquals(aEvents.length, 2);
    assertEquals(bEvents.length, 0);
    offA1();
    offA2();
    offB();
  });
});

Deno.test("unsubscribing stops delivery", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const events = [];
    const off = await hub.subscribe(roomId, (_n, d) => events.push(d));
    off();
    events.length = 0;
    await hub.publish(roomId, CHARGE);
    assertEquals(events.length, 0);
  });
});

Deno.test("a throwing subscriber does not stop the others", async () => {
  await withHub(async (hub, store) => {
    const { roomId } = await store.createRoom();
    const good = [];
    const offBad = await hub.subscribe(roomId, () => {
      throw new Error("client went away mid-write");
    });
    const offGood = await hub.subscribe(roomId, (_n, d) => good.push(d));
    good.length = 0;

    await hub.publish(roomId, CHARGE);
    assertEquals(good.length, 1);
    offBad();
    offGood();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test tests/hub_test.js`
Expected: FAIL — module `src/hub.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/hub.js`:

```js
/**
 * SSE fan-out across Deno Deploy isolates.
 *
 * Deno Deploy runs many isolates. The operator's POST and the display's open SSE
 * stream routinely land on different ones, so a purely in-process subscriber
 * registry delivers to the wrong isolate and drops the event silently.
 * BroadcastChannel is the bus between them.
 * @module
 */
import { toSvg } from "./qr.js";

/**
 * @param {ReturnType<import("./store.js").createStore>} store
 * @param {{channelName?: string}} [options]
 */
export function createHub(store, { channelName = "room-events" } = {}) {
  /** @type {Map<string, Set<(name: string, data: object) => void>>} */
  const local = new Map();
  const channel = new BroadcastChannel(channelName);

  /**
   * Attach the rendered QR. KV stores only the payload because rendering is
   * deterministic, so any isolate reproduces identical output.
   * @param {object} roomState
   */
  function render(roomState) {
    if (roomState.state !== "charge") return { ...roomState };
    return { ...roomState, svg: toSvg(roomState.payload) };
  }

  /**
   * @param {string} roomId
   * @param {string} name
   * @param {object} data
   */
  function deliverLocally(roomId, name, data) {
    const subscribers = local.get(roomId);
    if (!subscribers) return;
    for (const send of subscribers) {
      // One dead client must not block the others: a browser that vanished
      // mid-write throws here, and the next subscriber still deserves the event.
      try {
        send(name, data);
      } catch {
        // The stream's own cancel handler removes it from the set.
      }
    }
  }

  channel.onmessage = (event) => {
    const { roomId, name, data } = event.data;
    deliverLocally(roomId, name, data);
  };

  return {
    render,

    /**
     * Sends the current state immediately, then every subsequent one.
     * @param {string} roomId
     * @param {(name: string, data: object) => void} onEvent
     * @returns {Promise<() => void>} unsubscribe
     */
    async subscribe(roomId, onEvent) {
      let subscribers = local.get(roomId);
      if (!subscribers) {
        subscribers = new Set();
        local.set(roomId, subscribers);
      }
      subscribers.add(onEvent);

      // Replay on connect. SSE reconnects automatically, but a push-only server
      // would deliver nothing on reconnect and leave a blank screen in front of a
      // customer who is mid-scan.
      const current = await store.getCurrent(roomId);
      try {
        onEvent("state", render(current));
      } catch {
        // Ignore: the caller's stream is already gone.
      }

      return () => {
        const set = local.get(roomId);
        if (!set) return;
        set.delete(onEvent);
        if (set.size === 0) local.delete(roomId);
      };
    },

    /**
     * @param {string} roomId
     * @param {object} roomState
     */
    async publish(roomId, roomState) {
      await store.setCurrent(roomId, roomState);
      const data = render(roomState);
      // Post AND deliver locally: a BroadcastChannel never delivers a message
      // back to the object that posted it. Verified, not assumed.
      channel.postMessage({ roomId, name: "state", data });
      deliverLocally(roomId, "state", data);
    },

    /**
     * @param {string} roomId
     * @param {number} displays
     */
    presence(roomId, displays) {
      const data = { displays };
      channel.postMessage({ roomId, name: "presence", data });
      deliverLocally(roomId, "presence", data);
    },

    close() {
      channel.close();
      local.clear();
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test tests/hub_test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/hub.js tests/hub_test.js
git commit -m "feat: BroadcastChannel fan-out hub with replay-on-connect"
```

---

### Task 7: Server routes — rooms, settings, products, static files

`createHandler` returns a plain `(Request) => Response` function so tests can call it directly without binding a port.

**Files:**
- Create: `src/server.js`
- Create: `main.js`
- Create: `public/index.html` (placeholder, replaced in Task 10)
- Test: `tests/server_test.js`

**Interfaces:**
- Consumes: `createStore`, `createHub`.
- Produces: `createHandler({store, hub, now?}) -> (req: Request) => Promise<Response>`

- [ ] **Step 1: Write the failing test**

Create `tests/server_test.js`:

```js
import { assertEquals } from "@std/assert";
import { createStore } from "../src/store.js";
import { createHub } from "../src/hub.js";
import { createHandler } from "../src/server.js";

export async function withServer(fn) {
  const kv = await Deno.openKv(":memory:");
  const store = createStore(kv);
  const hub = createHub(store, { channelName: `test-${crypto.randomUUID()}` });
  const handler = createHandler({ store, hub });
  const call = (method, path, { token, body } = {}) =>
    handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
          "x-forwarded-for": "203.0.113.5",
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
    );
  try {
    await fn({ call, store, hub, handler });
  } finally {
    hub.close();
    kv.close();
  }
}

Deno.test("POST /api/rooms issues a room and an operator token", async () => {
  await withServer(async ({ call, store }) => {
    const res = await call("POST", "/api/rooms");
    assertEquals(res.status, 200);
    const { roomId, operatorToken } = await res.json();
    assertEquals(await store.authenticate(roomId, operatorToken), "operator");
  });
});

Deno.test("room creation is rate limited per client", async () => {
  await withServer(async ({ call }) => {
    let last;
    for (let i = 0; i < 12; i++) last = await call("POST", "/api/rooms");
    assertEquals(last.status, 429);
  });
});

Deno.test("authenticated routes reject a missing or wrong token", async () => {
  await withServer(async ({ call }) => {
    const { roomId } = await (await call("POST", "/api/rooms")).json();
    assertEquals((await call("GET", `/api/state?roomId=${roomId}`)).status, 401);
    assertEquals(
      (await call("GET", `/api/state?roomId=${roomId}`, { token: "nope" })).status,
      401,
    );
  });
});

Deno.test("settings and products round-trip through the API", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };

    let res = await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...t,
      body: { storeName: "Kaffebaren", payeeNumber: "070-123 45 67" },
    });
    assertEquals(res.status, 200);

    const products = [{ id: "a", name: "Kaffe", priceOre: 2500, sortOrder: 0 }];
    res = await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body: products });
    assertEquals(res.status, 200);

    res = await call("GET", `/api/state?roomId=${roomId}`, t);
    const state = await res.json();
    // The payee is stored normalized, so nothing downstream has to re-parse it.
    assertEquals(state.settings.payeeNumber, "0701234567");
    assertEquals(state.products, products);
  });
});

Deno.test("PUT /api/settings rejects an unpayable number", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const res = await call("PUT", `/api/settings?roomId=${roomId}`, {
      token: operatorToken,
      body: { storeName: "X", payeeNumber: "0801234567" },
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_payee");
  });
});

Deno.test("PUT /api/products validates its input", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };
    const bad = [
      [{ id: "a", name: "", priceOre: 100, sortOrder: 0 }],
      [{ id: "a", name: "Kaffe", priceOre: -5, sortOrder: 0 }],
      [{ id: "a", name: "Kaffe", priceOre: 1.5, sortOrder: 0 }],
      [{ id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0 }, {
        id: "a",
        name: "Te",
        priceOre: 200,
        sortOrder: 1,
      }],
      "not an array",
    ];
    for (const body of bad) {
      const res = await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body });
      assertEquals(res.status, 400);
    }
  });
});

Deno.test("unknown API routes 404", async () => {
  await withServer(async ({ call }) => {
    assertEquals((await call("GET", "/api/nope")).status, 404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno task test tests/server_test.js`
Expected: FAIL — module `src/server.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/server.js`:

```js
/**
 * HTTP routes. `createHandler` returns a plain (Request) => Response so tests can
 * exercise it without binding a port.
 * @module
 */
import { serveDir } from "@std/http/file-server";
import { normalizePayee } from "../public/shared/swish.js";
import { hashToken } from "./tokens.js";

const ROOMS_PER_MINUTE = 10;

/** @param {object} body @param {number} [status] */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {string} error @param {number} status @param {object} [extra] */
function fail(error, status, extra = {}) {
  return json({ error, ...extra }, status);
}

/** @param {Request} req */
function bearer(req) {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}

/** @param {Request} req */
function clientIp(req) {
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
}

/**
 * @param {{store: ReturnType<import("./store.js").createStore>,
 *          hub: ReturnType<import("./hub.js").createHub>,
 *          now?: () => Date}} deps
 */
export function createHandler({ store, hub, now = () => new Date() }) {
  /**
   * @param {Request} req
   * @param {URL} url
   * @param {"operator"|"display"|"any"} required
   */
  async function authorize(req, url, required) {
    const roomId = url.searchParams.get("roomId");
    const token = bearer(req);
    if (!roomId || !token) return null;
    const role = await store.authenticate(roomId, token);
    if (!role) return null;
    if (required !== "any" && role !== required) return null;
    return { roomId, role };
  }

  return async function handler(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return serveDir(req, { fsRoot: "public", quiet: true });
    }

    // --- room creation -----------------------------------------------------
    if (path === "/api/rooms" && req.method === "POST") {
      const ipHash = await hashToken(clientIp(req));
      if (!await store.underRateLimit("rooms", ipHash, ROOMS_PER_MINUTE, now())) {
        return fail("rate_limited", 429);
      }
      return json(await store.createRoom());
    }

    // --- operator state ----------------------------------------------------
    if (path === "/api/state" && req.method === "GET") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      return json({
        settings: await store.getSettings(auth.roomId),
        products: await store.getProducts(auth.roomId),
      });
    }

    if (path === "/api/settings" && req.method === "PUT") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      const body = await req.json().catch(() => null);
      const storeName = String(body?.storeName ?? "").trim();
      if (!storeName) return fail("invalid_store_name", 400);
      let payeeNumber;
      try {
        payeeNumber = normalizePayee(String(body?.payeeNumber ?? ""));
      } catch {
        return fail("invalid_payee", 400);
      }
      // Store the normalized form so nothing downstream has to re-parse it.
      await store.setSettings(auth.roomId, { storeName, payeeNumber });
      return json({ storeName, payeeNumber });
    }

    if (path === "/api/products" && req.method === "PUT") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      const body = await req.json().catch(() => null);
      if (!Array.isArray(body)) return fail("invalid_products", 400);
      const seen = new Set();
      for (const p of body) {
        if (typeof p?.id !== "string" || !p.id) return fail("invalid_products", 400);
        if (seen.has(p.id)) return fail("duplicate_product_id", 400);
        seen.add(p.id);
        if (typeof p.name !== "string" || !p.name.trim()) {
          return fail("invalid_products", 400);
        }
        if (!Number.isInteger(p.priceOre) || p.priceOre < 0) {
          return fail("invalid_products", 400);
        }
        if (!Number.isInteger(p.sortOrder)) return fail("invalid_products", 400);
      }
      await store.setProducts(auth.roomId, body);
      return json({ ok: true });
    }

    return fail("not_found", 404);
  };
}
```

Create `main.js`:

```js
/**
 * Entry point. Deno Deploy runs this file.
 */
import { createStore } from "./src/store.js";
import { createHub } from "./src/hub.js";
import { createHandler } from "./src/server.js";

const kv = await Deno.openKv();
const store = createStore(kv);
const hub = createHub(store);
Deno.serve(createHandler({ store, hub }));
```

Create `public/index.html` as a placeholder so static serving has something to return:

```html
<!doctype html>
<html lang="sv">
  <head><meta charset="utf-8"><title>Swish-kassa</title></head>
  <body><p>Under uppbyggnad.</p></body>
</html>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test tests/server_test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/server.js main.js public/index.html tests/server_test.js
git commit -m "feat: server routes for rooms, settings and products"
```

---

### Task 8: Pairing, stream tickets and the SSE endpoint

**Files:**
- Modify: `src/server.js` — add four routes
- Modify: `src/store.js` — add stream-ticket storage
- Modify: `tests/store_test.js` — add ticket tests
- Test: `tests/sse_test.js`

**Interfaces:**
- Consumes: everything from Tasks 5–7.
- Produces on `Store`: `createTicket(roomId, role) -> Promise<string>`, `claimTicket(ticket) -> Promise<{roomId, role}|null>`
- Produces routes: `POST /api/pair`, `POST /api/pair/claim`, `POST /api/stream-ticket`, `GET /api/events?ticket=…`

- [ ] **Step 1: Write the failing store test**

Append to `tests/store_test.js`:

```js
Deno.test("stream tickets are single-use and carry a role", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const ticket = await store.createTicket(roomId, "display");
    assertEquals(await store.claimTicket(ticket), { roomId, role: "display" });
    // Single use: the ticket appears in a URL, so it must be worthless once used.
    assertEquals(await store.claimTicket(ticket), null);
    assertEquals(await store.claimTicket("garbage"), null);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno task test tests/store_test.js`
Expected: FAIL — `store.createTicket is not a function`.

- [ ] **Step 3: Add ticket storage to `src/store.js`**

Add the constant near the other TTLs:

```js
const TICKET_TTL_MS = 30_000;
```

Add these two methods to the object returned by `createStore`, after `claimPairCode`:

```js
    /**
     * EventSource cannot set headers, so a token would otherwise end up in a URL
     * where proxy and server logs capture it. A 30-second single-use ticket is
     * exchanged over a normal POST instead.
     */
    async createTicket(roomId, role) {
      const ticket = randomToken();
      await kv.set(["ticket", ticket], { roomId, role }, { expireIn: TICKET_TTL_MS });
      return ticket;
    },

    async claimTicket(ticket) {
      if (!ticket) return null;
      const key = ["ticket", ticket];
      const entry = await kv.get(key);
      if (!entry.value) return null;
      const consumed = await kv.atomic()
        .check({ key, versionstamp: entry.versionstamp })
        .delete(key)
        .commit();
      return consumed.ok ? entry.value : null;
    },
```

- [ ] **Step 4: Run the store test to verify it passes**

Run: `deno task test tests/store_test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the failing route test**

Create `tests/sse_test.js`:

```js
import { assertEquals } from "@std/assert";
import { withServer } from "./server_test.js";

/** Read SSE frames from a Response until `count` `data:` lines have arrived. */
async function readEvents(res, count, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const name = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

Deno.test("pairing hands a display its own token", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    assertEquals(/^\d{6}$/.test(code), true);

    const claimed = await (await call("POST", "/api/pair/claim", { body: { code } })).json();
    assertEquals(claimed.roomId, roomId);
    assertEquals(await store.authenticate(roomId, claimed.displayToken), "display");
  });
});

Deno.test("a pair code cannot be claimed twice", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    assertEquals((await call("POST", "/api/pair/claim", { body: { code } })).status, 200);
    assertEquals((await call("POST", "/api/pair/claim", { body: { code } })).status, 404);
  });
});

Deno.test("pair claims are rate limited against brute force", async () => {
  await withServer(async ({ call }) => {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await call("POST", "/api/pair/claim", { body: { code: "000000" } });
    }
    assertEquals(last.status, 429);
  });
});

Deno.test("a display token cannot issue a pair code", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    const { displayToken } = await (await call("POST", "/api/pair/claim", {
      body: { code },
    })).json();

    // A display token must never be able to change what a display shows.
    const res = await call("POST", `/api/pair?roomId=${roomId}`, { token: displayToken });
    assertEquals(res.status, 401);
  });
});

Deno.test("the SSE stream sends current state as its first event", async () => {
  await withServer(async ({ call, handler }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();

    const res = await handler(new Request(`http://localhost/api/events?ticket=${ticket}`));
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const events = await readEvents(res, 1);
    assertEquals(events[0].name, "state");
    assertEquals(events[0].data.state, "idle");
  });
});

Deno.test("a ticket works exactly once", async () => {
  await withServer(async ({ call, handler }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();

    const first = await handler(new Request(`http://localhost/api/events?ticket=${ticket}`));
    await first.body.cancel();
    const second = await handler(new Request(`http://localhost/api/events?ticket=${ticket}`));
    assertEquals(second.status, 401);
  });
});

Deno.test("a published charge reaches an open stream", async () => {
  await withServer(async ({ call, handler, hub }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    const res = await handler(new Request(`http://localhost/api/events?ticket=${ticket}`));

    const pending = readEvents(res, 2);
    await hub.publish(roomId, {
      state: "charge",
      orderNo: 3,
      totalOre: 5000,
      message: "X #3",
      payload: "C0701234567;50.00;X #3;0",
      updatedAt: Date.now(),
    });
    const events = await pending;
    assertEquals(events[1].data.orderNo, 3);
    assertEquals(events[1].data.svg.startsWith("<svg"), true);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `deno task test tests/sse_test.js`
Expected: FAIL — pair routes return 404.

- [ ] **Step 7: Add the routes to `src/server.js`**

Add near `ROOMS_PER_MINUTE`:

```js
const PAIR_CLAIMS_PER_MINUTE = 20;
const HEARTBEAT_MS = 15_000;
```

Insert these routes before the final `return fail("not_found", 404);`:

```js
    // --- pairing -----------------------------------------------------------
    if (path === "/api/pair" && req.method === "POST") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      return json({ code: await store.createPairCode(auth.roomId) });
    }

    if (path === "/api/pair/claim" && req.method === "POST") {
      const ipHash = await hashToken(clientIp(req));
      // Rate limiting here is what keeps a 6-digit code from being brute-forced.
      if (!await store.underRateLimit("pair", ipHash, PAIR_CLAIMS_PER_MINUTE, now())) {
        return fail("rate_limited", 429);
      }
      const body = await req.json().catch(() => null);
      const claimed = await store.claimPairCode(String(body?.code ?? ""));
      if (!claimed) return fail("invalid_code", 404);
      return json(claimed);
    }

    // --- streaming ---------------------------------------------------------
    if (path === "/api/stream-ticket" && req.method === "POST") {
      const auth = await authorize(req, url, "any");
      if (!auth) return fail("unauthorized", 401);
      return json({ ticket: await store.createTicket(auth.roomId, auth.role) });
    }

    if (path === "/api/events" && req.method === "GET") {
      const claimed = await store.claimTicket(url.searchParams.get("ticket"));
      if (!claimed) return fail("unauthorized", 401);
      const { roomId, role } = claimed;
      const displayId = crypto.randomUUID();

      let unsubscribe = () => {};
      let heartbeat = 0;
      const encoder = new TextEncoder();

      const body = new ReadableStream({
        async start(controller) {
          const send = (name, data) => {
            controller.enqueue(
              encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
            );
          };

          unsubscribe = await hub.subscribe(roomId, send);
          if (role === "display") await store.touchPresence(roomId, displayId);

          heartbeat = setInterval(async () => {
            try {
              // A comment frame keeps intermediate proxies from closing the stream.
              controller.enqueue(encoder.encode(": ping\n\n"));
              if (role === "display") {
                await store.touchPresence(roomId, displayId);
              } else {
                send("presence", { displays: await store.countPresence(roomId) });
              }
            } catch {
              clearInterval(heartbeat);
            }
          }, HEARTBEAT_MS);

          if (role === "operator") {
            send("presence", { displays: await store.countPresence(roomId) });
          }
        },
        cancel() {
          clearInterval(heartbeat);
          unsubscribe();
        },
      });

      return new Response(body, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `deno task test`
Expected: PASS, all suites.

- [ ] **Step 9: Commit**

```bash
git add src/server.js src/store.js tests/store_test.js tests/sse_test.js
git commit -m "feat: pairing, single-use stream tickets and the SSE endpoint"
```

---

### Task 9: The charge endpoint

The task where money is decided. Every guard here exists because its absence produces a wrong or nonsensical payment.

**Files:**
- Modify: `src/server.js`
- Test: `tests/charge_test.js`

**Interfaces:**
- Consumes: everything above.
- Produces: `POST /api/charge`, `POST /api/idle`.

- [ ] **Step 1: Write the failing test**

Create `tests/charge_test.js`:

```js
import { assertEquals } from "@std/assert";
import { withServer } from "./server_test.js";

async function configuredRoom(call) {
  const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
  const t = { token: operatorToken };
  await call("PUT", `/api/settings?roomId=${roomId}`, {
    ...t,
    body: { storeName: "Kaffebaren", payeeNumber: "0701234567" },
  });
  const products = [
    { id: "kaffe", name: "Kaffe", priceOre: 2500, sortOrder: 0 },
    { id: "bulle", name: "Bulle", priceOre: 1990, sortOrder: 1 },
  ];
  await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body: products });
  const charge = (body) => call("POST", `/api/charge?roomId=${roomId}`, { ...t, body });
  return { roomId, operatorToken, t, products, charge };
}

Deno.test("a charge returns an order number, total, payload and SVG", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 2 }, { id: "bulle", qty: 1 }],
      expectedTotalOre: 6990,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.orderNo, 1);
    assertEquals(body.totalOre, 6990);
    assertEquals(body.payload, "C0701234567;69.90;Kaffebaren #1;0");
    assertEquals(body.svg.startsWith("<svg"), true);
  });
});

Deno.test("order numbers increment across charges", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const mk = () => charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 2500,
    });
    assertEquals((await (await mk()).json()).orderNo, 1);
    assertEquals((await (await mk()).json()).orderNo, 2);
  });
});

Deno.test("a repeated chargeId returns the identical response, not a new order", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const chargeId = crypto.randomUUID();
    const body = { chargeId, items: [{ id: "kaffe", qty: 1 }], expectedTotalOre: 2500 };
    const first = await (await charge(body)).json();
    const second = await (await charge(body)).json();
    // A double-tap must not consume two order numbers.
    assertEquals(second, first);
    assertEquals(first.orderNo, 1);
  });
});

Deno.test("charging publishes the state to the room", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, charge } = await configuredRoom(call);
    await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 2500,
    });
    const current = await store.getCurrent(roomId);
    assertEquals(current.state, "charge");
    assertEquals(current.orderNo, 1);
    // KV holds the payload, never the rendered SVG: rendering is deterministic.
    assertEquals(current.svg, undefined);
  });
});

Deno.test("the note is the store name and order number", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const body = await (await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "bulle", qty: 1 }],
      expectedTotalOre: 1990,
    })).json();
    assertEquals(body.message, "Kaffebaren #1");
  });
});

Deno.test("every rejection is a hard stop with a named error", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const cases = [
      [{ items: [], expectedTotalOre: 0 }, 400, "empty_basket"],
      [{ items: [{ id: "ghost", qty: 1 }], expectedTotalOre: 100 }, 400, "unknown_product"],
      [{ items: [{ id: "kaffe", qty: 0 }], expectedTotalOre: 0 }, 400, "bad_quantity"],
      [{ items: [{ id: "kaffe", qty: 1.5 }], expectedTotalOre: 100 }, 400, "bad_quantity"],
      [{ items: [{ id: "kaffe", qty: 1 }], expectedTotalOre: 9999 }, 409, "stale_total"],
    ];
    for (const [partial, status, error] of cases) {
      const res = await charge({ chargeId: crypto.randomUUID(), ...partial });
      assertEquals(res.status, status, `expected ${status} for ${error}`);
      assertEquals((await res.json()).error, error);
    }
  });
});

Deno.test("a stale total reports the corrected figure", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 1,
    });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).totalOre, 2500);
  });
});

Deno.test("absurd totals are refused at both ends", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };
    await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...t,
      body: { storeName: "K", payeeNumber: "0701234567" },
    });
    await call("PUT", `/api/products?roomId=${roomId}`, {
      ...t,
      body: [
        { id: "cheap", name: "Billig", priceOre: 50, sortOrder: 0 },
        { id: "huge", name: "Dyr", priceOre: 3_000_000, sortOrder: 1 },
      ],
    });
    const charge = (body) => call("POST", `/api/charge?roomId=${roomId}`, { ...t, body });

    let res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "cheap", qty: 1 }],
      expectedTotalOre: 50,
    });
    assertEquals((await res.json()).error, "amount_too_low");

    res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "huge", qty: 1 }],
      expectedTotalOre: 3_000_000,
    });
    assertEquals((await res.json()).error, "amount_too_high");
  });
});

Deno.test("an unconfigured room cannot charge", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    await call("PUT", `/api/products?roomId=${roomId}`, {
      token: operatorToken,
      body: [{ id: "a", name: "Kaffe", priceOre: 2500, sortOrder: 0 }],
    });
    const res = await call("POST", `/api/charge?roomId=${roomId}`, {
      token: operatorToken,
      body: {
        chargeId: crypto.randomUUID(),
        items: [{ id: "a", qty: 1 }],
        expectedTotalOre: 2500,
      },
    });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error, "not_configured");
  });
});

Deno.test("a display token cannot charge", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken, products } = await configuredRoom(call);
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    const { displayToken } = await (await call("POST", "/api/pair/claim", {
      body: { code },
    })).json();

    // This is the whole point of separate tokens: a compromised display must not
    // be able to put its own QR on the screen.
    const res = await call("POST", `/api/charge?roomId=${roomId}`, {
      token: displayToken,
      body: {
        chargeId: crypto.randomUUID(),
        items: [{ id: products[0].id, qty: 1 }],
        expectedTotalOre: 2500,
      },
    });
    assertEquals(res.status, 401);
  });
});

Deno.test("idle returns the room to its welcome state", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, t, charge } = await configuredRoom(call);
    await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 2500,
    });
    const res = await call("POST", `/api/idle?roomId=${roomId}`, t);
    assertEquals(res.status, 200);
    assertEquals(await store.getCurrent(roomId), { state: "idle" });
  });
});

Deno.test("cancelling leaves a gap in the order sequence", async () => {
  await withServer(async ({ call }) => {
    const { roomId, t, charge } = await configuredRoom(call);
    const mk = () => charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 2500,
    });
    assertEquals((await (await mk()).json()).orderNo, 1);
    await call("POST", `/api/idle?roomId=${roomId}`, t);
    // Accepted behaviour: decrementing would race the atomic increment, and a
    // gap in the sequence costs nothing.
    assertEquals((await (await mk()).json()).orderNo, 2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `deno task test tests/charge_test.js`
Expected: FAIL — `/api/charge` returns 404.

- [ ] **Step 3: Add the routes to `src/server.js`**

Add the imports at the top:

```js
import { basketTotalOre } from "../public/shared/money.js";
import { buildPayload } from "../public/shared/swish.js";
```

(The existing `normalizePayee` import stays; combine them into one line from
`swish.js`.)

Add the constants:

```js
/** Below 1 kr is not a real sale; above 20 000 kr is a fat-finger. Neither is a
 * Swish limit — actual ceilings are set per user by their bank. */
const MIN_CHARGE_ORE = 100;
const MAX_CHARGE_ORE = 2_000_000;
```

Insert before the final `return fail("not_found", 404);`:

```js
    // --- charging ----------------------------------------------------------
    if (path === "/api/charge" && req.method === "POST") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);

      const body = await req.json().catch(() => null);
      const chargeId = String(body?.chargeId ?? "");
      const items = body?.items;
      if (!chargeId || !Array.isArray(items)) return fail("bad_request", 400);

      const settings = await store.getSettings(auth.roomId);
      if (!settings?.storeName || !settings?.payeeNumber) {
        return fail("not_configured", 409);
      }
      if (items.length === 0) return fail("empty_basket", 400);

      const products = await store.getProducts(auth.roomId);
      let totalOre;
      try {
        totalOre = basketTotalOre(items, products);
      } catch (err) {
        // An unknown id is rejected, never skipped: a dropped line undercharges.
        return fail(err.message, 400, { productId: err.productId });
      }

      if (totalOre < MIN_CHARGE_ORE) return fail("amount_too_low", 400);
      if (totalOre > MAX_CHARGE_ORE) return fail("amount_too_high", 400);
      if (totalOre !== body?.expectedTotalOre) {
        return fail("stale_total", 409, { totalOre });
      }

      try {
        const response = await store.claimCharge(auth.roomId, chargeId, async () => {
          const orderNo = await store.nextOrderNo(auth.roomId, now());
          const message = `${settings.storeName} #${orderNo}`;
          const payload = buildPayload({
            payee: settings.payeeNumber,
            totalOre,
            message,
          });
          const roomState = {
            state: "charge",
            orderNo,
            totalOre,
            message,
            payload,
            updatedAt: Date.now(),
          };
          await hub.publish(auth.roomId, roomState);
          return { orderNo, totalOre, message, payload, svg: hub.render(roomState).svg };
        });
        return json(response);
      } catch (err) {
        if (err.code === "charge_in_progress") return fail("charge_in_progress", 409);
        throw err;
      }
    }

    if (path === "/api/idle" && req.method === "POST") {
      const auth = await authorize(req, url, "operator");
      if (!auth) return fail("unauthorized", 401);
      await hub.publish(auth.roomId, { state: "idle" });
      return json({ ok: true });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno task test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/server.js tests/charge_test.js
git commit -m "feat: charge endpoint with guards, idempotency and fan-out"
```

---

### Task 10: The operator page

**Files:**
- Modify: `public/index.html`
- Create: `public/app.js`
- Create: `public/style.css`

**Interfaces:**
- Consumes: `/api/*`, `public/shared/money.js`.
- Produces: no exports; a page.

- [ ] **Step 1: Write `public/style.css`**

```css
:root {
  --bg: #12141a;
  --panel: #1c1f28;
  --line: #2c313d;
  --text: #f2f4f8;
  --muted: #99a1b3;
  --accent: #00a54f;
  --danger: #d64545;
  color-scheme: dark;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  -webkit-text-size-adjust: 100%;
}
header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px; border-bottom: 1px solid var(--line);
}
header h1 { font-size: 17px; margin: 0; flex: 1; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); }
.dot.on { background: var(--accent); }
.icon-btn {
  background: none; border: 1px solid var(--line); color: var(--text);
  border-radius: 8px; padding: 8px 12px; font-size: 15px;
}
main { padding: 12px 16px 200px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 8px; }
.product {
  min-height: 74px; border-radius: 12px; border: 1px solid var(--line);
  background: var(--panel); color: var(--text); padding: 8px;
  display: flex; flex-direction: column; justify-content: space-between;
  text-align: left; font-size: 14px; position: relative;
}
.product:active { border-color: var(--accent); }
.product .price { color: var(--muted); font-size: 13px; }
.product .qty {
  position: absolute; top: -6px; right: -6px; min-width: 22px; height: 22px;
  border-radius: 11px; background: var(--accent); color: #fff;
  font-size: 13px; font-weight: 600; display: grid; place-items: center; padding: 0 6px;
}
.basket {
  position: fixed; left: 0; right: 0; bottom: 0;
  background: var(--panel); border-top: 1px solid var(--line);
  padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
}
.lines { max-height: 28vh; overflow-y: auto; margin-bottom: 8px; }
.line { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 15px; }
.line .name { flex: 1; }
.line button {
  width: 32px; height: 32px; border-radius: 8px;
  border: 1px solid var(--line); background: none; color: var(--text); font-size: 18px;
}
.total { display: flex; justify-content: space-between; font-size: 22px; font-weight: 700; }
.buy {
  width: 100%; margin-top: 10px; padding: 16px; font-size: 19px; font-weight: 700;
  border: 0; border-radius: 12px; background: var(--accent); color: #fff;
}
.buy:disabled { background: var(--line); color: var(--muted); }
dialog {
  border: 1px solid var(--line); border-radius: 14px; background: var(--panel);
  color: var(--text); width: min(560px, 92vw); padding: 16px;
}
dialog::backdrop { background: rgba(0, 0, 0, .6); }
label { display: block; margin: 10px 0 4px; font-size: 14px; color: var(--muted); }
input {
  width: 100%; padding: 10px; font-size: 16px; border-radius: 8px;
  border: 1px solid var(--line); background: var(--bg); color: var(--text);
}
.row { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
.row input.name { flex: 2; } .row input.price { flex: 1; }
.qr-wrap { text-align: center; }
.qr-wrap svg { width: min(78vw, 420px); height: auto; border-radius: 12px; }
.amount-big { font-size: 34px; font-weight: 800; margin: 8px 0 2px; }
.note { color: var(--muted); font-size: 14px; }
.warn {
  margin-top: 12px; padding: 10px; border-radius: 8px; font-size: 13px;
  background: #3a2f14; color: #f0d79a;
}
.err { color: var(--danger); font-size: 14px; min-height: 20px; }
.pair-code { font-size: 40px; font-weight: 800; letter-spacing: 6px; text-align: center; }
```

- [ ] **Step 2: Write `public/index.html`**

```html
<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Swish-kassa</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header>
  <span class="dot" id="dot" title="Kunddisplay"></span>
  <h1 id="storeName">Swish-kassa</h1>
  <button class="icon-btn" id="pairBtn">Koppla display</button>
  <button class="icon-btn" id="settingsBtn">Inställningar</button>
</header>

<main><div class="grid" id="grid"></div></main>

<section class="basket">
  <div class="lines" id="lines"></div>
  <div class="total"><span>Totalt</span><span id="total">0,00 kr</span></div>
  <div class="err" id="error"></div>
  <button class="buy" id="buyBtn" disabled>Betala</button>
</section>

<dialog id="settingsDlg">
  <h2>Inställningar</h2>
  <label for="fName">Butiksnamn (visas som meddelande)</label>
  <input id="fName" autocomplete="off">
  <label for="fPayee">Swish-nummer</label>
  <input id="fPayee" inputmode="tel" autocomplete="off" placeholder="070-123 45 67">
  <h3>Produkter</h3>
  <div id="productRows"></div>
  <button class="icon-btn" id="addRow">Lägg till produkt</button>
  <div class="err" id="settingsError"></div>
  <div class="row" style="margin-top:14px">
    <button class="icon-btn" id="cancelSettings">Avbryt</button>
    <button class="buy" style="margin:0" id="saveSettings">Spara</button>
  </div>
</dialog>

<dialog id="pairDlg">
  <h2>Koppla kunddisplay</h2>
  <p class="note">Öppna <b id="displayUrl"></b> på den andra telefonen och skriv koden.</p>
  <div class="pair-code" id="pairCode">······</div>
  <p class="note" id="pairExpiry"></p>
  <button class="icon-btn" id="closePair">Klar</button>
</dialog>

<dialog id="qrDlg">
  <div class="qr-wrap">
    <div class="amount-big" id="qrAmount"></div>
    <div class="note" id="qrNote"></div>
    <div id="qrHolder"></div>
    <div class="warn">
      Appen kan inte se om betalningen kommit fram. Kontrollera i din egen
      Swish-app innan du trycker Klar.
    </div>
    <div class="row" style="margin-top:12px">
      <button class="icon-btn" id="cancelCharge">Avbryt</button>
      <button class="buy" style="margin:0" id="doneCharge">Klar</button>
    </div>
  </div>
</dialog>

<script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `public/app.js`**

```js
import { basketTotalOre, formatOre, parseKronorToOre } from "/shared/money.js";

const $ = (id) => document.getElementById(id);
const LS = "swish-kassa-room";

let room = JSON.parse(localStorage.getItem(LS) ?? "null");
let settings = null;
let products = [];
/** @type {Map<string, number>} product id -> quantity */
const basket = new Map();
let inFlight = false;
let lastCharge = null;

// --- API -------------------------------------------------------------------

async function api(method, path, body) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}roomId=${room.roomId}`, {
    method,
    headers: {
      Authorization: `Bearer ${room.operatorToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? "fel"), { data, status: res.status });
  return data;
}

const ERRORS = {
  not_configured: "Ange butiksnamn och Swish-nummer i inställningar.",
  empty_basket: "Korgen är tom.",
  unknown_product: "En produkt i korgen finns inte längre. Uppdaterar listan.",
  bad_quantity: "Ogiltigt antal.",
  amount_too_low: "Beloppet är under 1 kr.",
  amount_too_high: "Beloppet är orimligt högt. Kontrollera korgen.",
  stale_total: "Priserna har ändrats. Kontrollera summan och tryck Betala igen.",
  charge_in_progress: "En betalning behandlas redan. Försök igen.",
  rate_limited: "För många försök. Vänta en minut.",
};

// --- rendering -------------------------------------------------------------

function renderProducts() {
  $("grid").innerHTML = "";
  for (const p of [...products].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const qty = basket.get(p.id) ?? 0;
    const btn = document.createElement("button");
    btn.className = "product";
    btn.innerHTML =
      `<span>${escapeHtml(p.name)}</span><span class="price">${formatOre(p.priceOre)}</span>` +
      (qty ? `<span class="qty">${qty}</span>` : "");
    btn.onclick = () => {
      basket.set(p.id, qty + 1);
      renderAll();
    };
    $("grid").append(btn);
  }
}

function renderBasket() {
  $("lines").innerHTML = "";
  for (const [id, qty] of basket) {
    const p = products.find((x) => x.id === id);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "line";
    row.innerHTML =
      `<span class="name">${qty} × ${escapeHtml(p.name)}</span>` +
      `<span>${formatOre(p.priceOre * qty)}</span>`;
    const minus = document.createElement("button");
    minus.textContent = "−";
    minus.onclick = () => {
      const next = qty - 1;
      if (next > 0) basket.set(id, next);
      else basket.delete(id);
      renderAll();
    };
    row.prepend(minus);
    $("lines").append(row);
  }

  const items = [...basket].map(([id, qty]) => ({ id, qty }));
  let total = 0;
  try {
    total = basketTotalOre(items, products);
  } catch {
    total = 0;
  }
  $("total").textContent = `${formatOre(total)} kr`;
  const configured = Boolean(settings?.storeName && settings?.payeeNumber);
  $("buyBtn").disabled = inFlight || items.length === 0 || !configured;
  return { items, total };
}

function renderAll() {
  $("storeName").textContent = settings?.storeName || "Swish-kassa";
  renderProducts();
  renderBasket();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// --- charging --------------------------------------------------------------

$("buyBtn").onclick = async () => {
  const { items, total } = renderBasket();
  if (!items.length) return;
  // Disable immediately: the chargeId makes a retry safe, but not showing two
  // spinners is better than relying on it.
  inFlight = true;
  $("buyBtn").disabled = true;
  $("error").textContent = "";
  try {
    const res = await api("POST", "/api/charge", {
      chargeId: crypto.randomUUID(),
      items,
      expectedTotalOre: total,
    });
    lastCharge = res;
    $("qrAmount").textContent = `${formatOre(res.totalOre)} kr`;
    $("qrNote").textContent = res.message;
    $("qrHolder").innerHTML = res.svg;
    $("qrDlg").showModal();
  } catch (err) {
    $("error").textContent = ERRORS[err.message] ?? "Kunde inte skapa betalning.";
    if (err.message === "stale_total" || err.message === "unknown_product") await refresh();
  } finally {
    inFlight = false;
    renderBasket();
  }
};

async function endCharge() {
  $("qrDlg").close();
  basket.clear();
  renderAll();
  try {
    await api("POST", "/api/idle");
  } catch { /* the display will resync on its next event */ }
}
$("doneCharge").onclick = endCharge;
$("cancelCharge").onclick = endCharge;

// --- settings --------------------------------------------------------------

function productRow(p = { id: crypto.randomUUID(), name: "", priceOre: 0 }) {
  const row = document.createElement("div");
  row.className = "row";
  row.dataset.id = p.id;
  row.innerHTML =
    `<input class="name" value="${escapeHtml(p.name)}" placeholder="Namn">` +
    `<input class="price" inputmode="decimal" value="${p.priceOre ? formatOre(p.priceOre) : ""}" placeholder="0,00">`;
  const del = document.createElement("button");
  del.className = "icon-btn";
  del.textContent = "✕";
  del.onclick = () => row.remove();
  row.append(del);
  return row;
}

$("settingsBtn").onclick = () => {
  $("fName").value = settings?.storeName ?? "";
  $("fPayee").value = settings?.payeeNumber ?? "";
  $("productRows").innerHTML = "";
  const sorted = [...products].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const p of sorted.length ? sorted : [undefined]) {
    $("productRows").append(productRow(p));
  }
  $("settingsError").textContent = "";
  $("settingsDlg").showModal();
};
$("addRow").onclick = () => $("productRows").append(productRow());
$("cancelSettings").onclick = () => $("settingsDlg").close();

$("saveSettings").onclick = async () => {
  $("settingsError").textContent = "";
  const rows = [...$("productRows").children];
  const next = [];
  try {
    rows.forEach((row, i) => {
      const name = row.querySelector(".name").value.trim();
      const priceRaw = row.querySelector(".price").value.trim();
      if (!name && !priceRaw) return;
      if (!name) throw new Error("Alla produkter behöver ett namn.");
      next.push({ id: row.dataset.id, name, priceOre: parseKronorToOre(priceRaw), sortOrder: i });
    });
  } catch (err) {
    $("settingsError").textContent = err.message === "invalid_amount"
      ? "Ett pris är ogiltigt. Skriv t.ex. 19,90."
      : err.message;
    return;
  }

  try {
    // Settings first: a bad payee must not leave products half-saved silently.
    await api("PUT", "/api/settings", {
      storeName: $("fName").value.trim(),
      payeeNumber: $("fPayee").value.trim(),
    });
    await api("PUT", "/api/products", next);
  } catch (err) {
    $("settingsError").textContent = err.message === "invalid_payee"
      ? "Swish-numret ser inte giltigt ut."
      : err.message === "invalid_store_name"
      ? "Ange ett butiksnamn."
      : "Kunde inte spara. Försök igen.";
    return; // The dialog stays open: never show a saved state we did not achieve.
  }
  $("settingsDlg").close();
  await refresh();
};

// --- pairing ---------------------------------------------------------------

$("pairBtn").onclick = async () => {
  $("displayUrl").textContent = `${location.origin}/display.html`;
  $("pairCode").textContent = "······";
  $("pairExpiry").textContent = "";
  $("pairDlg").showModal();
  try {
    const { code } = await api("POST", "/api/pair");
    $("pairCode").textContent = code;
    $("pairExpiry").textContent = "Koden gäller i 5 minuter och kan bara användas en gång.";
  } catch {
    $("pairCode").textContent = "fel";
  }
};
$("closePair").onclick = () => $("pairDlg").close();

// --- live connection -------------------------------------------------------

async function connect() {
  try {
    const { ticket } = await api("POST", "/api/stream-ticket");
    const es = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
    es.addEventListener("presence", (e) => {
      $("dot").classList.toggle("on", JSON.parse(e.data).displays > 0);
    });
    es.onerror = () => {
      $("dot").classList.remove("on");
      es.close();
      // A ticket is single-use, so a reconnect needs a fresh one. EventSource's
      // own retry cannot do that for us.
      setTimeout(connect, 3000);
    };
  } catch {
    setTimeout(connect, 5000);
  }
}

// --- boot ------------------------------------------------------------------

async function refresh() {
  const state = await api("GET", "/api/state");
  settings = state.settings;
  products = state.products;
  for (const id of [...basket.keys()]) {
    if (!products.some((p) => p.id === id)) basket.delete(id);
  }
  renderAll();
}

async function boot() {
  if (!room) {
    const res = await fetch("/api/rooms", { method: "POST" });
    room = await res.json();
    localStorage.setItem(LS, JSON.stringify(room));
  }
  await refresh();
  connect();
  if (!settings?.storeName) $("settingsBtn").click();
}

boot();
```

- [ ] **Step 4: Verify by hand**

Run: `deno task dev`, open <http://localhost:8000>.
Expected: settings dialog opens on first load; adding products and a Swish number persists across a reload; tapping products updates the total; Buy shows a QR.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/app.js public/style.css
git commit -m "feat: operator page with product grid, basket and settings"
```

---

### Task 11: The display page, README, and spec sync

**Files:**
- Create: `public/display.html`
- Create: `public/display.js`
- Create: `README.md`
- Modify: `docs/superpowers/specs/2026-09-13-swish-calculator-design.md` — §15 file layout

**Interfaces:**
- Consumes: `/api/pair/claim`, `/api/stream-ticket`, `/api/events`.

- [ ] **Step 1: Write `public/display.html`**

```html
<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Kunddisplay</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    font: 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    /* Full-bleed white: there is no web API for screen brightness, so maximising
       emitted light is the only thing the page itself can do for scannability. */
    background: #ffffff; color: #111; display: grid; place-items: center;
    text-align: center; padding: 16px; -webkit-text-size-adjust: 100%;
  }
  #pair input {
    font-size: 30px; letter-spacing: 8px; text-align: center; width: 220px;
    padding: 10px; border: 2px solid #ccc; border-radius: 10px;
  }
  #pair button {
    margin-top: 14px; font-size: 19px; padding: 14px 28px; border: 0;
    border-radius: 10px; background: #00a54f; color: #fff;
  }
  .amount { font-size: clamp(38px, 12vw, 92px); font-weight: 800; line-height: 1; }
  .note { font-size: clamp(15px, 4.5vw, 24px); color: #444; margin-top: 6px; }
  #qr svg { width: min(76vh, 88vw); height: auto; display: block; margin: 14px auto 0; }
  .idle-title { font-size: clamp(24px, 8vw, 48px); font-weight: 700; }
  .hint { color: #777; font-size: 14px; margin-top: 10px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<div id="pair">
  <p>Ange kopplingskoden från kassan.</p>
  <input id="code" inputmode="numeric" maxlength="6" placeholder="000000">
  <div><button id="claim">Koppla</button></div>
  <p class="hint" id="pairError"></p>
</div>

<div id="idle" hidden>
  <div class="idle-title">Välkommen</div>
  <p class="hint">Betala med Swish</p>
</div>

<div id="charge" hidden>
  <div class="amount" id="amount"></div>
  <div class="note" id="note"></div>
  <div id="qr"></div>
</div>

<script src="/display.js"></script>
</body>
</html>
```

- [ ] **Step 2: Write `public/display.js`**

Written as a classic script with no imports or modern syntax beyond what a dated
mobile browser handles, because this page runs on the old phone.

```js
(function () {
  var LS = "swish-kassa-display";
  var creds = null;
  try {
    creds = JSON.parse(localStorage.getItem(LS) || "null");
  } catch (e) { /* private mode or cleared storage */ }

  var el = function (id) { return document.getElementById(id); };
  var wakeLock = null;
  var lastUpdatedAt = 0;

  // --- wake lock -----------------------------------------------------------
  // Two details decide whether this works at all: it must be acquired from a
  // user gesture, and it is auto-released whenever the page is hidden. Without
  // the re-acquire it appears to work and then silently stops.
  function requestWakeLock() {
    if (!navigator.wakeLock) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      lock.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () { /* denied or unsupported */ });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && !wakeLock) requestWakeLock();
  });
  document.addEventListener("click", function () {
    if (!wakeLock) requestWakeLock();
  });

  // --- screens -------------------------------------------------------------
  function show(which) {
    el("pair").hidden = which !== "pair";
    el("idle").hidden = which !== "idle";
    el("charge").hidden = which !== "charge";
  }

  function renderState(data) {
    // Every event carries complete state, so a redelivered or out-of-order
    // event is harmless; updatedAt just stops an older one overwriting a newer.
    if (data.state === "charge") {
      if (data.updatedAt && data.updatedAt < lastUpdatedAt) return;
      lastUpdatedAt = data.updatedAt || 0;
      el("amount").textContent = formatOre(data.totalOre) + " kr";
      el("note").textContent = data.message;
      el("qr").innerHTML = data.svg;
      show("charge");
    } else {
      lastUpdatedAt = 0;
      show("idle");
    }
  }

  function formatOre(ore) {
    var abs = Math.abs(Math.trunc(ore));
    var kronor = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    var dec = String(abs % 100);
    while (dec.length < 2) dec = "0" + dec;
    return kronor + "," + dec;
  }

  // --- pairing -------------------------------------------------------------
  el("claim").addEventListener("click", function () {
    var code = el("code").value.trim();
    el("pairError").textContent = "";
    requestWakeLock(); // acquired here because this is a real user gesture
    fetch("/api/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code })
    }).then(function (res) {
      if (!res.ok) throw new Error(String(res.status));
      return res.json();
    }).then(function (data) {
      creds = data;
      try { localStorage.setItem(LS, JSON.stringify(data)); } catch (e) {}
      show("idle");
      connect();
    }).catch(function (err) {
      el("pairError").textContent = err.message === "429"
        ? "För många försök. Vänta en minut."
        : "Fel kod, eller så har den gått ut.";
    });
  });

  // --- live connection -----------------------------------------------------
  function connect() {
    if (!creds) return;
    fetch("/api/stream-ticket?roomId=" + encodeURIComponent(creds.roomId), {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.displayToken }
    }).then(function (res) {
      if (!res.ok) throw new Error("ticket");
      return res.json();
    }).then(function (data) {
      var es = new EventSource("/api/events?ticket=" + encodeURIComponent(data.ticket));
      es.addEventListener("state", function (e) { renderState(JSON.parse(e.data)); });
      es.onerror = function () {
        es.close();
        // A ticket is single-use, so EventSource's built-in retry would reuse a
        // spent one. Reconnect through a fresh ticket instead. The server replays
        // current state on connect, so the QR reappears by itself.
        setTimeout(connect, 2000);
      };
    }).catch(function () { setTimeout(connect, 3000); });
  }

  if (creds) { show("idle"); connect(); } else { show("pair"); }
})();
```

- [ ] **Step 3: Write `README.md`**

````markdown
# Swish-kassa

A two-device point-of-sale for a market stall. The operator taps products into a
basket on their phone; an old spare phone facing the customer shows a Swish QR
code for the exact total.

Design: `docs/superpowers/specs/2026-09-13-swish-calculator-design.md`

## Run locally

```bash
deno task dev     # http://localhost:8000
deno task test
```

## Deploy

Deno Deploy, entry point `main.js`. Deno KV needs no configuration.

## ⚠️ Before taking real money

**The QR payload format is community-documented, not published by Getswish.** The
test suite proves the app emits the string it intended to emit. It cannot prove
Swish accepts it. Scan a generated code with a real Swish app and confirm every
row below before your first real sale.

- [ ] The Swish app opens with the **correct payee**
- [ ] The **amount** is correct
- [ ] The **note** reads `<store name> #<order number>`
- [ ] Payee, amount and note are all **locked** against editing
- [ ] Payee is accepted in `07…` form (if not, switch `normalizePayee` to emit `46…`)
- [ ] A whole amount is accepted as `249.00` (if not, emit `249`)
- [ ] A 50-character note is accepted (if not, lower `MESSAGE_MAX_CHARS` in
      `public/shared/swish.js`)

Also confirm once after the first deploy, with the two devices on different
networks: make a charge, then kill and restore the display's connection
mid-charge and check that the QR comes back on its own.

## Setting up the display phone

1. Open `/display.html`, enter the 6-digit code from the operator's
   "Koppla display" button. You only do this once.
2. Add the page to the home screen so it opens fullscreen.
3. **Set the screen timeout to Never** and **turn off auto-brightness, with
   brightness at maximum.** The page requests a wake lock where the browser
   supports one, but older Safari has no such API, and no web page can set screen
   brightness at all. A dim screen outdoors is the most common reason a QR will
   not scan.

## What this app does not do

It cannot tell whether a payment arrived. Swish provides no callback for a
private payee number. **"Klar" means you saw the money land in your own Swish
app** — it is never a confirmation from the system.

A private Swish number is what this is built for, per the design. Swish's own
terms reserve commercial use for a merchant number (`123…`); the app accepts
either, so switching later is a settings change.
````

- [ ] **Step 4: Sync the spec's file layout**

In `docs/superpowers/specs/2026-09-13-swish-calculator-design.md` §15, replace the
`src/` and `tests/` blocks so they match what was built:

```
src/
  tokens.js          # random tokens, SHA-256 hashing, constant-time compare
  store.js           # every Deno KV read and write, incl. pairing and presence
  hub.js             # SSE subscriber registry + BroadcastChannel fan-out
  qr.js              # payload → module matrix → SVG (npm:qrcode-generator, pinned)
  server.js          # routes
main.js              # entry point
tests/
  money_test.js  swish_test.js  qr_test.js  tokens_test.js
  store_test.js  hub_test.js  server_test.js  sse_test.js  charge_test.js
```

Add a line under the block: *"`rooms.js` was split into `tokens.js`, `store.js`
and `hub.js` during implementation: four responsibilities in one file was too
many. The QR encoder is a pinned npm specifier rather than a vendored file."*

- [ ] **Step 5: Run the whole suite and check formatting**

Run: `deno task test && deno fmt --check && deno lint`
Expected: all tests pass; fmt and lint clean. Run `deno fmt` if it reports diffs.

- [ ] **Step 6: Commit**

```bash
git add public/display.html public/display.js README.md docs/
git commit -m "feat: customer display page, README verification checklist, spec sync"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §3 architecture → Tasks 6–8;
§4 payload → Task 2; §5 data model → Task 5; §6 SSE contract → Tasks 6, 8; §7 API →
Tasks 7–9; §8 QR → Task 3; §9 flows → Tasks 10–11; §10 screens and wake lock →
Tasks 10–11; §11 failure modes → distributed across the guard tests in Tasks 5, 8,
9; §12 security → Tasks 4, 5, 8, 9; §14 testing → every task. §13 Phase 2 is
deliberately unimplemented.

**Deliberate deferrals, both stated in the spec as v1 non-goals:** offline
operation, and sales history.

**One spec detail intentionally not implemented as written:** spec §11 says a
dead display still lets the operator sell, with the QR shown on the operator's own
phone. That is what Task 10 does — the operator's `qrDlg` always shows the QR
regardless of display presence — but it happens by construction rather than as a
fallback branch, so there is no separate code path to test.

**Type consistency checked:** `basketTotalOre(items, products)`, `buildPayload({payee,
totalOre, message})`, `toSvg(payload)`, `store.claimCharge(roomId, chargeId, produce)`,
`hub.publish(roomId, roomState)`, `hub.subscribe(roomId, onEvent)` and the
`RoomState` shape `{state, orderNo, totalOre, message, payload, updatedAt}` are
used identically everywhere they appear.

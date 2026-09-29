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

Deno.test("toSvg names the code for screen readers, escaping the label", () => {
  assertStringIncludes(toSvg(PAYLOAD), 'role="img" aria-label="Swish QR-kod"');
  assertStringIncludes(
    toSvg(PAYLOAD, 'Kod för "A" & <B>'),
    'aria-label="Kod för &quot;A&quot; &amp; &lt;B&gt;"',
  );
});

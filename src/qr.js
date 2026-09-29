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
 * @param {string} [label] what a screen reader announces for the code
 * @returns {string} a complete <svg> element
 */
export function toSvg(payload, label = "Swish QR-kod") {
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
    ` shape-rendering="crispEdges" role="img" aria-label="${escapeAttr(label)}">`,
    `<rect width="100%" height="100%" fill="#ffffff"/>`,
    `<path d="${path}" fill="#000000"/>`,
    `</svg>`,
  ].join("");
}

/** @param {string} s */
function escapeAttr(s) {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
}

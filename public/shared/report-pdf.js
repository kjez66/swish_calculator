/**
 * The day's sales report as a PDF, for handing in after a match: totals and
 * quantity and sum per product. Written by hand rather than with a PDF library,
 * which would add 300-500 KB for every phone to download. It uses Helvetica, one
 * of the fonts every PDF reader has built in, in WinAnsiEncoding: Swedish
 * letters, é, ×, – and the like print, and anything else prints as "?".
 * @module
 */

import { formatOre } from "./money.js";

// A4 in points, with 20 mm side margins.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const LEFT = 56.69;
const RIGHT = PAGE_W - 56.69;
/** The right edge of the Antal column; product names stop well short of it. */
const QTY_RIGHT = 400;
const NAME_MAX_WIDTH = QTY_RIGHT - 60 - LEFT;
const TOP = 785;
/** Rows stop above this; the footer goes below it, on the last page. */
const ROWS_BOTTOM = 72;
const ROW_HEIGHT = 18;

const NOTE =
  "Visar köp som markerats Klar. Appen kan inte se om pengarna kom fram, så stäm av mot din Swish-app.";

/**
 * Advance widths in 1/1000 em for WinAnsiEncoding codes 32-255, from Adobe's
 * Helvetica (F1) and Helvetica-Bold (F2) AFM files; 0 where WinAnsi has no
 * character.
 */
const WIDTHS = {
  F1: [
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667,
    667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722,
    667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500,
    556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278,
    556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 0, 556, 0, 222, 556, 333, 1000, 556,
    556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333,
    1000, 500, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737,
    370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 556, 537, 278, 333, 333, 365,
    556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667,
    278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722,
    667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278,
    278, 278, 556, 556, 556, 556, 556, 556, 556, 584, 611, 556, 556, 556, 556, 500, 556,
    500,
  ],
  F2: [
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722,
    722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722,
    667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556,
    611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333,
    611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 0, 556, 0, 278, 556, 500, 1000, 556,
    556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333,
    1000, 556, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737,
    370, 556, 584, 333, 737, 333, 400, 584, 333, 333, 333, 611, 556, 278, 333, 333, 365,
    556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667,
    278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722,
    667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278,
    278, 278, 611, 611, 611, 611, 611, 611, 611, 584, 611, 611, 611, 611, 611, 556, 611,
    556,
  ],
};

/** The code points WinAnsiEncoding puts at 0x80-0x9F, where it differs from Latin-1. */
const WIN_ANSI_HIGH = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/** Text as WinAnsi bytes, one per character (not UTF-16 unit); "?" where the font has none. */
function encode(text) {
  return Array.from(text, (char) => {
    const cp = char.codePointAt(0);
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
    return WIN_ANSI_HIGH.get(cp) ?? 0x3f;
  });
}

/**
 * How wide text is when drawn, in points.
 * @param {string} text
 * @param {"F1" | "F2"} font F1 is Helvetica, F2 Helvetica-Bold
 * @param {number} size in points
 */
export function textWidth(text, font, size) {
  let width = 0;
  for (const byte of encode(text)) width += WIDTHS[font][byte - 32];
  return (width * size) / 1000;
}

/** Text cut short with "…" so it is at most maxWidth wide. */
function fitWidth(text, font, size, maxWidth) {
  if (textWidth(text, font, size) <= maxWidth) return text;
  const chars = Array.from(text);
  while (chars.length && textWidth(`${chars.join("")}…`, font, size) > maxWidth) {
    chars.pop();
  }
  return `${chars.join("").trimEnd()}…`;
}

/** A PDF string literal's contents: WinAnsi bytes with ( ) and \ escaped. */
function pdfString(text) {
  return encode(text)
    .map((byte) => {
      const c = String.fromCharCode(byte);
      return c === "(" || c === ")" || c === "\\" ? `\\${c}` : c;
    })
    .join("");
}

const num = (n) => String(Number(n.toFixed(2)));

const createdFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * The report for one day, as the bytes of a PDF file.
 * @param {{storeName: string, date: string, createdAt: number | Date,
 *   summary: {count: number, totalOre: number,
 *     products: {name: string, qty: number, totalOre: number}[]}}} report
 *   date is YYYY-MM-DD; summary is what summarizeSales returns
 * @returns {Uint8Array}
 */
export function salesReportPdf({ storeName, date, summary, createdAt }) {
  const pages = [];
  let ops = [];
  let y = TOP;
  const text = (s, font, size, x, atY) =>
    ops.push(`BT /${font} ${size} Tf ${num(x)} ${num(atY)} Td (${pdfString(s)}) Tj ET`);
  const rightAligned = (s, font, size, rightEdge, atY) =>
    text(s, font, size, rightEdge - textWidth(s, font, size), atY);
  const tableHeader = () => {
    text("Produkt", "F2", 10, LEFT, y);
    rightAligned("Antal", "F2", 10, QTY_RIGHT, y);
    rightAligned("Summa (kr)", "F2", 10, RIGHT, y);
    ops.push(`0.5 w ${num(LEFT)} ${num(y - 6)} m ${num(RIGHT)} ${num(y - 6)} l S`);
    y -= 24;
  };

  text("Försäljning", "F2", 20, LEFT, y);
  y -= 24;
  text(storeName ? `${storeName} · ${date}` : date, "F1", 12, LEFT, y);
  y -= 34;
  text(`${summary.count} köp`, "F1", 14, LEFT, y);
  rightAligned(`${formatOre(summary.totalOre)} kr`, "F2", 14, RIGHT, y);
  y -= 36;
  tableHeader();
  for (const product of summary.products) {
    if (y < ROWS_BOTTOM) {
      pages.push(ops);
      ops = [];
      y = TOP;
      tableHeader();
    }
    text(fitWidth(product.name, "F1", 11, NAME_MAX_WIDTH), "F1", 11, LEFT, y);
    rightAligned(String(product.qty), "F1", 11, QTY_RIGHT, y);
    rightAligned(formatOre(product.totalOre), "F1", 11, RIGHT, y);
    y -= ROW_HEIGHT;
  }
  ops.push("0.4 g");
  text(NOTE, "F1", 9, LEFT, 52);
  text(`Skapad ${createdFormat.format(new Date(createdAt))}`, "F1", 9, LEFT, 40);
  ops.push("0 g");
  pages.push(ops);
  return pdfFile(pages);
}

/**
 * A PDF file of pages drawn with F1 and F2: catalog, page tree, the two fonts,
 * then a page and its content stream per page, and the cross-reference table.
 * Every character is one byte, so string length is byte offset.
 */
function pdfFile(pages) {
  const kids = pages.map((_, i) => `${5 + 2 * i} 0 R`).join(" ");
  const font = (name) =>
    `<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`,
    font("Helvetica"),
    font("Helvetica-Bold"),
  ];
  pages.forEach((ops, i) => {
    const stream = ops.join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}]` +
        ` /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    );
  });
  // The second line's bytes above 127 mark the file as binary for transfer tools.
  let out = `%PDF-1.4\n%${String.fromCharCode(0xe2, 0xe3, 0xcf, 0xd3)}\n`;
  const offsets = objects.map((body, i) => {
    const offset = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(out, (c) => c.charCodeAt(0));
}

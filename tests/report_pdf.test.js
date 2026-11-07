import { expect, test } from "vitest";
import { salesReportPdf, textWidth } from "../public/shared/report-pdf.js";
import { summarizeSales } from "../public/shared/sales.js";

// --- a small PDF reader, enough for what salesReportPdf writes -------------

/** The file as a string of one character per byte. */
function bytesToString(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** Every indirect object, checked against the cross-reference table. */
function readObjects(pdf) {
  const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)[1]);
  expect(pdf.startsWith("xref\n", startxref), "startxref points at xref").toBe(true);
  const [, count] = /^xref\n0 (\d+)\n/.exec(pdf.slice(startxref));
  const entries = pdf
    .slice(startxref)
    .split("\n")
    .slice(2, 2 + Number(count));
  const objects = new Map();
  expect(entries[0]).toBe("0000000000 65535 f ");
  entries.forEach((entry, i) => {
    if (i === 0) return;
    expect(entry, `xref entry ${i}`).toMatch(/^\d{10} 00000 n $/);
    const offset = Number(entry.slice(0, 10));
    expect(pdf.startsWith(`${i} 0 obj\n`, offset), `object ${i} at its offset`).toBe(
      true,
    );
    const end = pdf.indexOf("\nendobj\n", offset);
    objects.set(i, pdf.slice(offset + `${i} 0 obj\n`.length, end));
  });
  const trailer = pdf.slice(pdf.indexOf("trailer", startxref));
  expect(trailer).toContain(`/Size ${count}`);
  expect(trailer).toContain("/Root 1 0 R");
  return objects;
}

/** A stream object's data, after checking its /Length. */
function streamData(object) {
  const [, length] = /\/Length (\d+)/.exec(object);
  const start = object.indexOf("stream\n") + "stream\n".length;
  const end = object.lastIndexOf("\nendstream");
  expect(end - start, "stream /Length").toBe(Number(length));
  return object.slice(start, end);
}

// WinAnsi bytes 0x80-0x9F that are not Latin-1, back to Unicode.
const WIN_ANSI_HIGH = new Map([
  [0x85, "…"],
  [0x96, "–"],
  [0x80, "€"],
]);

/** The text pieces each page draws: font, size, position and the decoded text. */
function readPages(bytes) {
  const pdf = bytesToString(bytes);
  expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
  const objects = readObjects(pdf);
  const kids = /\/Kids \[([^\]]*)\]/.exec(objects.get(2))[1];
  const pageIds = [...kids.matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
  expect(objects.get(2)).toContain(`/Count ${pageIds.length}`);
  return pageIds.map((id) => {
    const page = objects.get(id);
    expect(page).toContain("/MediaBox [0 0 595.28 841.89]");
    const contents = Number(/\/Contents (\d+) 0 R/.exec(page)[1]);
    const ops = streamData(objects.get(contents));
    const texts = [];
    const re = /BT \/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj ET/g;
    for (const [, font, size, x, y, raw] of ops.matchAll(re)) {
      const text = [...raw.replace(/\\(.)/g, "$1")]
        .map((c) => WIN_ANSI_HIGH.get(c.charCodeAt(0)) ?? c)
        .join("");
      texts.push({ font, size: Number(size), x: Number(x), y: Number(y), text });
    }
    return texts;
  });
}

const line = (productId, name, priceOre, qty) => ({ productId, name, priceOre, qty });
const SALES = [
  {
    orderNo: 1,
    totalOre: 5500,
    lines: [line("k", "Kaffe", 2000, 2), line("l", "Loka", 1500, 1)],
  },
  { orderNo: 2, totalOre: 160000, lines: [line("h", "Hembakat", 160000, 1)] },
];
// 15:45 UTC is 17:45 in Stockholm (CEST).
const CREATED = Date.UTC(2026, 9, 14, 15, 45);
const report = (summary, storeName = "Kiosken") =>
  readPages(
    salesReportPdf({ storeName, date: "2026-10-11", summary, createdAt: CREATED }),
  );
const textsOf = (page) => page.map((t) => t.text);

// --- tests -------------------------------------------------------------------

test("the report is a valid one-page PDF with the day's totals", () => {
  const pages = report(summarizeSales(SALES));
  expect(pages).toHaveLength(1);
  const texts = textsOf(pages[0]);
  expect(texts).toContain("Försäljning");
  expect(texts).toContain("Kiosken · 2026-10-11");
  expect(texts).toContain("2 köp");
  expect(texts).toContain("1\u00A0655,00 kr");
});

test("the table lists each product with its quantity and sum, as on screen", () => {
  const [page] = report(summarizeSales(SALES));
  const rowOf = (name) => {
    const cell = page.find((t) => t.text === name);
    return page.filter((t) => t.y === cell.y).map((t) => t.text);
  };
  expect(rowOf("Produkt")).toEqual(["Produkt", "Antal", "Summa (kr)"]);
  expect(rowOf("Hembakat")).toEqual(["Hembakat", "1", "1\u00A0600,00"]);
  expect(rowOf("Kaffe")).toEqual(["Kaffe", "2", "40,00"]);
  expect(rowOf("Loka")).toEqual(["Loka", "1", "15,00"]);
  // In the order summarizeSales gives: most sold first, then by name.
  const ys = ["Kaffe", "Hembakat", "Loka"].map((n) => page.find((t) => t.text === n).y);
  expect(ys).toEqual([...ys].sort((a, b) => b - a));
});

test("quantities and sums are right-aligned in their columns", () => {
  const [page] = report(summarizeSales(SALES));
  const rightEdges = (header) => {
    const head = page.find((t) => t.text === header);
    const column = page.filter(
      (t) =>
        t.y < head.y &&
        Math.abs(
          t.x +
            textWidth(t.text, t.font, t.size) -
            (head.x + textWidth(head.text, head.font, head.size)),
        ) < 40,
    );
    return [head, ...column].map((t) =>
      (t.x + textWidth(t.text, t.font, t.size)).toFixed(2),
    );
  };
  for (const header of ["Antal", "Summa (kr)"]) {
    const edges = rightEdges(header);
    expect(edges.length, header).toBeGreaterThan(3);
    expect(new Set(edges).size, `${header} right edges ${edges}`).toBe(1);
  }
});

test("the footer says when it was made and what it shows", () => {
  const [page] = report(summarizeSales(SALES));
  const texts = textsOf(page);
  expect(texts).toContain("Skapad 2026-10-14 17:45");
  expect(texts.some((t) => t.includes("markerats Klar"))).toBe(true);
});

test("without a store name the subtitle is just the date", () => {
  const [page] = report(summarizeSales(SALES), "");
  expect(textsOf(page)).toContain("2026-10-11");
  expect(textsOf(page).some((t) => t.includes("·"))).toBe(false);
});

test("a long product name is cut short with an ellipsis and stays in its column", () => {
  const long = "Väldigt lång produkt med ett namn som aldrig tycks ta slut alls";
  const [page] = report(
    summarizeSales([{ orderNo: 1, totalOre: 100, lines: [line("x", long, 100, 1)] }]),
  );
  const cell = page.find((t) => t.text.startsWith("Väldigt"));
  expect(cell.text.endsWith("…")).toBe(true);
  expect(long.startsWith(cell.text.slice(0, -1))).toBe(true);
  const antal = page.find((t) => t.text === "Antal");
  expect(cell.x + textWidth(cell.text, cell.font, cell.size)).toBeLessThan(antal.x - 10);
});

test("characters the PDF font lacks print as ?, and PDF syntax is escaped", () => {
  const names = ["Kaffe 🎪", "Korv (stor) \\ extra", "Bröd – åäö ÅÄÖ é ×"];
  const sales = names.map((name, i) => ({
    orderNo: i + 1,
    totalOre: 100 * (3 - i),
    lines: [line(`p${i}`, name, 100 * (3 - i), 1)],
  }));
  const texts = textsOf(report(summarizeSales(sales))[0]);
  expect(texts).toContain("Kaffe ?");
  expect(texts).toContain("Korv (stor) \\ extra");
  expect(texts).toContain("Bröd – åäö ÅÄÖ é ×");
});

test("a long menu continues on more pages, the header repeated, the footer last", () => {
  const products = Array.from({ length: 90 }, (_, i) =>
    line(`p${i}`, `Produkt ${i + 1}`, 100, 1),
  );
  const summary = summarizeSales([{ orderNo: 1, totalOre: 9000, lines: products }]);
  const pages = report(summary);
  expect(pages.length).toBeGreaterThan(1);
  const all = pages.flatMap(textsOf);
  for (let i = 1; i <= 90; i++)
    expect(all.filter((t) => t === `Produkt ${i}`)).toHaveLength(1);
  for (const page of pages) {
    expect(textsOf(page), "table header on every page").toContain("Summa (kr)");
    // Nothing drawn below the bottom margin.
    for (const t of page) expect(t.y, t.text).toBeGreaterThanOrEqual(40);
  }
  expect(textsOf(pages.at(-1))).toContain("Skapad 2026-10-14 17:45");
  expect(textsOf(pages[0])).not.toContain("Skapad 2026-10-14 17:45");
  expect(textsOf(pages[0])).toContain("Försäljning");
});

test("textWidth measures in Helvetica's metrics", () => {
  // 'a' is 556/1000 em and 'i' 222 in Helvetica; Helvetica-Bold's 'i' is 278.
  expect(textWidth("a", "F1", 10)).toBeCloseTo(5.56);
  expect(textWidth("ii", "F1", 10)).toBeCloseTo(4.44);
  expect(textWidth("i", "F2", 10)).toBeCloseTo(2.78);
  expect(textWidth("ö", "F1", 10)).toBeCloseTo(5.56);
});

// --- the team logo -------------------------------------------------------------

// Bytes a careless writer would break: newline, ( ) \ and bytes above 127.
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x0a, 0x28, 0x29, 0x5c, 0x80, 0xff, 0xd9,
]);
const ARGS = { storeName: "Kiosken", date: "2026-10-11", createdAt: CREATED };

test("without a logo the bytes are exactly today's", async () => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    salesReportPdf({ ...ARGS, summary: summarizeSales(SALES) }),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  expect(hex).toBe("29912cbe6e4f2d2dc058072deeee3807c209e58d097ee16deb803f2b1e8f1f48");
});

const raw = (logo, summary = summarizeSales(SALES), storeName = "Kiosken") =>
  bytesToString(salesReportPdf({ ...ARGS, storeName, summary, logo }));
const DRAW = /^q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im1 Do Q$/m;

test("with a logo, the first page draws it as an embedded JPEG, top right", () => {
  const pdf = raw({ jpeg: JPEG, width: 200, height: 100 });
  const objects = readObjects(pdf);
  const [id, image] = [...objects].find(([, o]) => o.includes("/Subtype /Image"));
  for (const part of [
    "/Type /XObject",
    "/Width 200",
    "/Height 100",
    "/ColorSpace /DeviceRGB",
    "/BitsPerComponent 8",
    "/Filter /DCTDecode",
  ]) {
    expect(image).toContain(part);
  }
  expect(streamData(image)).toBe(bytesToString(JPEG));
  const firstPage = objects.get(Number(/\/Kids \[(\d+) 0 R/.exec(objects.get(2))[1]));
  expect(firstPage).toContain(`/XObject << /Im1 ${id} 0 R >>`);
  const contents = streamData(
    objects.get(Number(/\/Contents (\d+) 0 R/.exec(firstPage)[1])),
  );
  const [, w, h, x, y] = DRAW.exec(contents).map(Number);
  expect([w, h]).toEqual([56, 28]);
  expect(x + w).toBeCloseTo(538.59, 2);
  expect(y + h).toBeCloseTo(799, 2);
});

test("a tall logo is fitted to the box by its height", () => {
  const pdf = raw({ jpeg: JPEG, width: 50, height: 200 });
  const [, w, h] = DRAW.exec(pdf).map(Number);
  expect([w, h]).toEqual([14, 56]);
});

test("the logo is drawn on the first page only", () => {
  const products = Array.from({ length: 90 }, (_, i) => line(`p${i}`, `P ${i}`, 100, 1));
  const summary = summarizeSales([{ orderNo: 1, totalOre: 9000, lines: products }]);
  const pdf = raw({ jpeg: JPEG, width: 10, height: 10 }, summary);
  expect(pdf.match(/\/Im1 Do/g)).toHaveLength(1);
  expect(pdf.match(/\/Subtype \/Image/g)).toHaveLength(1);
  expect(pdf.match(/\/XObject <</g)).toHaveLength(1);
});

test("a long store name stops short of the logo", () => {
  const long = "Föreningen med det väldigt långa namnet som inte tar slut i första taget";
  const pages = readPages(
    salesReportPdf({
      ...ARGS,
      storeName: long,
      summary: summarizeSales(SALES),
      logo: { jpeg: JPEG, width: 1, height: 1 },
    }),
  );
  const sub = pages[0].find((t) => t.text.startsWith("Föreningen"));
  expect(sub.text.endsWith("…")).toBe(true);
  expect(sub.x + textWidth(sub.text, sub.font, sub.size)).toBeLessThanOrEqual(
    538.59 - 56 - 12,
  );
});

test("without a logo the file has no image", () => {
  const without = raw(undefined);
  expect(without).not.toContain("/XObject");
  expect(without).toBe(
    bytesToString(salesReportPdf({ ...ARGS, summary: summarizeSales(SALES) })),
  );
});

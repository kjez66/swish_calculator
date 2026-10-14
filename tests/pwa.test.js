import { expect, test } from "vitest";
import { assetBytes, assetText } from "./assets.js";

// Both pages install as their own app: the operator's till and the customer
// display. Chrome offers to install a page whose manifest has a name, a start
// URL, a display mode and 192 px and 512 px icons, and whose service worker
// handles fetches; iOS uses the apple-touch-icon.
const APPS = [
  {
    page: "/index.html",
    script: "/app.js",
    manifest: "/manifest.webmanifest",
  },
  {
    page: "/display.html",
    script: "/display.js",
    manifest: "/display.webmanifest",
  },
];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...bytes.slice(0, 8)], "not a PNG").toEqual(signature);
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

for (const { page, script, manifest } of APPS) {
  test(`public${page} is installable`, async () => {
    const html = await assetText(page);
    expect(html.includes(`<link rel="manifest" href="${manifest}">`), "manifest link")
      .toBe(true);
    expect(html.includes('<meta name="theme-color"'), "theme-color").toBe(true);
    const touch = /<link rel="apple-touch-icon" href="([^"]+)">/.exec(html);
    expect(touch, "apple-touch-icon").toBeTruthy();
    expect(pngSize(await assetBytes(touch[1]))).toBe("180x180");

    const m = JSON.parse(await assetText(manifest));
    for (const field of ["id", "name", "short_name", "start_url", "scope"]) {
      expect(typeof m[field] === "string" && m[field], field).toBeTruthy();
    }
    expect(["standalone", "fullscreen"].includes(m.display), "display").toBe(true);
    expect(m.theme_color, "theme_color").toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color, "background_color").toMatch(/^#[0-9a-f]{6}$/i);
    for (const icon of m.icons) {
      const bytes = await assetBytes(icon.src);
      expect(pngSize(bytes), icon.src).toBe(icon.sizes);
      expect(icon.type).toBe("image/png");
    }
    const any = m.icons.filter((i) => (i.purpose ?? "any") === "any").map((i) => i.sizes);
    expect(any.includes("192x192") && any.includes("512x512"), "192 and 512 icons")
      .toBe(true);
    expect(m.icons.some((i) => i.purpose === "maskable"), "a maskable icon").toBe(true);

    const js = await assetText(script);
    expect(js.includes('serviceWorker.register("/sw.js")'), "registers the service worker")
      .toBe(true);
  });
}

test("the service worker handles fetches but never the API", async () => {
  const sw = await assetText("/sw.js");
  expect(sw.includes('addEventListener("fetch"'), "fetch handler").toBe(true);
  expect(sw.includes('"/api/"'), "skips /api/").toBe(true);
});

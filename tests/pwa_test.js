import { assert, assertEquals } from "@std/assert";

// Both pages install as their own app: the operator's till and the customer
// display. Chrome offers to install a page whose manifest has a name, a start
// URL, a display mode and 192 px and 512 px icons, and whose service worker
// handles fetches; iOS uses the apple-touch-icon.
const APPS = [
  {
    page: "public/index.html",
    script: "public/app.js",
    manifest: "/manifest.webmanifest",
  },
  {
    page: "public/display.html",
    script: "public/display.js",
    manifest: "/display.webmanifest",
  },
];

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assertEquals([...bytes.slice(0, 8)], signature, "not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

for (const { page, script, manifest } of APPS) {
  Deno.test(`${page} is installable`, async () => {
    const html = await Deno.readTextFile(page);
    assert(html.includes(`<link rel="manifest" href="${manifest}">`), "manifest link");
    assert(html.includes('<meta name="theme-color"'), "theme-color");
    const touch = /<link rel="apple-touch-icon" href="([^"]+)">/.exec(html);
    assert(touch, "apple-touch-icon");
    assertEquals(pngSize(await Deno.readFile(`public${touch[1]}`)), "180x180");

    const m = JSON.parse(await Deno.readTextFile(`public${manifest}`));
    for (const field of ["id", "name", "short_name", "start_url", "scope"]) {
      assert(typeof m[field] === "string" && m[field], field);
    }
    assert(["standalone", "fullscreen"].includes(m.display), "display");
    assert(/^#[0-9a-f]{6}$/i.test(m.theme_color), "theme_color");
    assert(/^#[0-9a-f]{6}$/i.test(m.background_color), "background_color");
    for (const icon of m.icons) {
      const bytes = await Deno.readFile(`public${icon.src}`);
      assertEquals(pngSize(bytes), icon.sizes, icon.src);
      assertEquals(icon.type, "image/png");
    }
    const any = m.icons.filter((i) => (i.purpose ?? "any") === "any").map((i) => i.sizes);
    assert(any.includes("192x192") && any.includes("512x512"), "192 and 512 icons");
    assert(m.icons.some((i) => i.purpose === "maskable"), "a maskable icon");

    const js = await Deno.readTextFile(script);
    assert(
      js.includes('serviceWorker.register("/sw.js")'),
      "registers the service worker",
    );
  });
}

Deno.test("the service worker handles fetches but never the API", async () => {
  const sw = await Deno.readTextFile("public/sw.js");
  assert(sw.includes('addEventListener("fetch"'), "fetch handler");
  assert(sw.includes('"/api/"'), "skips /api/");
});

import { expect, test } from "vitest";
import { assetText } from "./assets.js";

// The browser finds app.js's imports only after app.js has arrived, one round
// trip later; preloaded, they load alongside it. A new import needs a new link.
test("the operator page preloads every module app.js imports", async () => {
  const js = await assetText("/app.js");
  const html = await assetText("/");
  const imports = [...js.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(0);
  for (const path of imports) {
    expect(html.includes(`<link rel="modulepreload" href="${path}">`), path).toBe(true);
  }
});

// The tool's name, wherever the till shows it before a store name is set.
test("the till is called Swish-kalkylator everywhere it shows its name", async () => {
  const NAME = "Swish-kalkylator";
  const html = await assetText("/");
  expect(html).toContain(`<title>${NAME}</title>`);
  expect(html).toContain(`<h1 id="storeName">${NAME}</h1>`);
  expect(await assetText("/app.js")).toContain(`settings?.storeName || "${NAME}"`);
  expect(JSON.parse(await assetText("/manifest.webmanifest")).name).toBe(NAME);
});

test("the official Swish logo is shipped and shown on both pages", async () => {
  const logo = await assetText("/brand/swish-logo.svg");
  expect(logo.startsWith("<svg")).toBe(true);
  for (const page of ["/display.html", "/index.html"]) {
    const html = await assetText(page);
    expect(html.includes('src="/brand/swish-logo.svg"'), page).toBe(true);
  }
});

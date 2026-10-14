import { expect, test } from "vitest";
import { assetText } from "./assets.js";

test("the official Swish logo is shipped and shown on both pages", async () => {
  const logo = await assetText("/brand/swish-logo.svg");
  expect(logo.startsWith("<svg")).toBe(true);
  for (const page of ["/display.html", "/index.html"]) {
    const html = await assetText(page);
    expect(html.includes('src="/brand/swish-logo.svg"'), page).toBe(true);
  }
});

import { expect, test } from "vitest";
import { asset, assetBytes, assetText } from "./assets.js";

test("asset fails with the path when a public file is missing", async () => {
  await expect(asset("/no-such-file.js")).rejects.toThrow("/no-such-file.js");
});

test("assetText and assetBytes return the served file", async () => {
  expect(await assetText("/sw.js")).toContain('addEventListener("fetch"');
  const png = await assetBytes("/icons/kassa-192.png");
  expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
});

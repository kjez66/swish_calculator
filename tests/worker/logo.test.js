import { expect, test } from "vitest";
import { call, configuredRoom, newRoom, openSocket, pairDisplay } from "./helpers.js";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngOf = (...rest) => Uint8Array.from([...SIGNATURE, ...rest]);
const PNG = pngOf(0, 0, 0, 13, 0xff, 0x0a);
const putLogo = (api, bytes = PNG) => api("PUT", "/api/logo", { raw: bytes });
const state = async (api) => await (await api("GET", "/api/state")).json();

test("an uploaded PNG is served by its URL, without a token, cacheable for a year", async () => {
  const { roomId, api } = await newRoom();
  const res = await putLogo(api);
  expect(res.status).toBe(200);
  const { version } = await res.json();
  expect(version).toMatch(/^[0-9a-f]{16}$/);
  const { logoUrl } = await state(api);
  expect(logoUrl).toBe(`/api/logo?roomId=${roomId}&v=${version}`);
  const img = await call("GET", logoUrl);
  expect(img.status).toBe(200);
  expect(img.headers.get("Content-Type")).toBe("image/png");
  expect(img.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  expect(img.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
});

test("a kassa without a logo has no logo URL, and its logo route is a 404", async () => {
  const { roomId, api } = await newRoom();
  expect((await state(api)).logoUrl).toBe(null);
  expect((await call("GET", `/api/logo?roomId=${roomId}&v=0`)).status).toBe(404);
});

test("only a PNG of at most 256 KB is accepted", async () => {
  const { api } = await newRoom();
  const refused = async (bytes) => {
    const res = await putLogo(api, bytes);
    return [res.status, (await res.json()).error];
  };
  expect(await refused(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toEqual([
    400,
    "invalid_logo",
  ]);
  expect(await refused(new Uint8Array(0))).toEqual([400, "invalid_logo"]);
  const tooBig = new Uint8Array(262_145);
  tooBig.set(SIGNATURE);
  expect(await refused(tooBig)).toEqual([413, "logo_too_large"]);
  const justFits = new Uint8Array(262_144);
  justFits.set(SIGNATURE);
  expect((await putLogo(api, justFits)).status).toBe(200);
});

test("only the operator can change the logo", async () => {
  const { roomId, api } = await configuredRoom();
  const displayToken = await pairDisplay(api);
  for (const method of ["PUT", "DELETE"]) {
    for (const token of [undefined, displayToken]) {
      const res = await call(method, `/api/logo?roomId=${roomId}`, { token, raw: PNG });
      expect(res.status, `${method} as ${token ? "display" : "nobody"}`).toBe(401);
    }
  }
});

test("a replaced or removed logo is gone from its old URL", async () => {
  const { api } = await newRoom();
  await putLogo(api);
  const first = (await state(api)).logoUrl;
  await putLogo(api, pngOf(1, 2, 3));
  const second = (await state(api)).logoUrl;
  expect(second).not.toBe(first);
  expect((await call("GET", first)).status).toBe(404);
  expect((await call("GET", second)).status).toBe(200);
  expect((await api("DELETE", "/api/logo")).status).toBe(200);
  expect((await state(api)).logoUrl).toBe(null);
  expect((await call("GET", second)).status).toBe(404);
  // Removing a logo that is not there is fine.
  expect((await api("DELETE", "/api/logo")).status).toBe(200);
});

test("saving settings keeps the logo", async () => {
  const { api } = await newRoom();
  await putLogo(api);
  const before = (await state(api)).logoUrl;
  expect(before).toMatch(/^\/api\/logo\?/);
  await api("PUT", "/api/settings", {
    body: { storeName: "Kiosken", payeeNumber: "0701234567" },
  });
  expect((await state(api)).logoUrl).toBe(before);
});

test("displays get the logo URL on hello and whenever it changes", async () => {
  const { roomId, api } = await configuredRoom();
  const display = await openSocket(roomId, await pairDisplay(api));
  expect(await display.next("room")).toEqual({ storeName: "Kiosken", logoUrl: null });
  await putLogo(api);
  const { logoUrl } = await state(api);
  expect(await display.next("room")).toEqual({ storeName: "Kiosken", logoUrl });
  await api("DELETE", "/api/logo");
  expect(await display.next("room")).toEqual({ storeName: "Kiosken", logoUrl: null });
});

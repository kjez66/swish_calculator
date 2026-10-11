import { expect, test } from "vitest";
import { call, newRoom, pairDisplay } from "./helpers.js";

test("pairing hands a display its own token, with a scannable link", async () => {
  const { roomId, operatorToken, api } = await newRoom();
  const pair = await (await api("POST", "/api/pair")).json();
  expect(pair.code).toMatch(/^\d{6}$/);
  expect(pair.pairUrl).toBe(`https://kassa.test/display.html?code=${pair.code}`);
  expect(pair.pairQrSvg.startsWith("<svg")).toBe(true);
  const claim = await (await call("POST", "/api/pair/claim", {
    body: { code: pair.code },
  })).json();
  expect(claim.roomId).toBe(roomId);
  // The live tests show this token opens a display socket.
  expect(claim.displayToken.length).toBeGreaterThan(40);
  expect(claim.displayToken).not.toBe(operatorToken);
});

test("a pair code cannot be claimed twice", async () => {
  const { api } = await newRoom();
  const { code } = await (await api("POST", "/api/pair")).json();
  expect((await call("POST", "/api/pair/claim", { body: { code } })).status).toBe(200);
  const again = await call("POST", "/api/pair/claim", { body: { code } });
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ error: "invalid_code" });
});

test("pair claims are rate limited against brute force", async () => {
  const claim = () =>
    call("POST", "/api/pair/claim", { body: { code: "000000" }, ip: "203.0.113.77" });
  for (let i = 0; i < 20; i++) expect((await claim()).status).toBe(404);
  expect((await claim()).status).toBe(429);
});

test("a display token cannot issue a pair code", async () => {
  const { roomId, api } = await newRoom();
  const displayToken = await pairDisplay(api);
  const res = await call("POST", `/api/pair?roomId=${roomId}`, { token: displayToken });
  expect(res.status).toBe(401);
});

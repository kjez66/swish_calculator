import { expect, test } from "vitest";
import { call, newRoom } from "./helpers.js";

test("POST /api/rooms issues a kassa with the default menu", async () => {
  const { roomId, operatorToken, api } = await newRoom();
  expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
  expect(operatorToken.length).toBeGreaterThan(40);
  const state = await (await api("GET", "/api/state")).json();
  expect(state.settings).toBe(null);
  expect(state.products.map((p) => p.name)[0]).toBe("Loka");
  expect(state.products).toHaveLength(11);
});

test("room creation is rate limited per client", async () => {
  for (let i = 0; i < 10; i++) {
    expect((await call("POST", "/api/rooms", { ip: "203.0.113.9" })).status).toBe(200);
  }
  expect((await call("POST", "/api/rooms", { ip: "203.0.113.9" })).status).toBe(429);
  expect((await call("POST", "/api/rooms", { ip: "203.0.113.10" })).status).toBe(200);
});

test("kassa routes reject a missing or wrong token, and a bad roomId", async () => {
  const { roomId } = await newRoom();
  expect((await call("GET", `/api/state?roomId=${roomId}`)).status).toBe(401);
  expect(
    (await call("GET", `/api/state?roomId=${roomId}`, { token: "nope" })).status,
  ).toBe(401);
  expect((await call("GET", "/api/state?roomId=not-a-uuid", { token: "x" })).status).toBe(
    401,
  );
  const unknown = crypto.randomUUID();
  expect((await call("GET", `/api/state?roomId=${unknown}`, { token: "x" })).status).toBe(
    401,
  );
});

test("settings and products round-trip", async () => {
  const { api } = await newRoom();
  let res = await api("PUT", "/api/settings", {
    body: { storeName: " Kiosken ", payeeNumber: "070-123 45 67" },
  });
  expect(await res.json()).toEqual({ storeName: "Kiosken", payeeNumber: "0701234567" });
  const products = [
    { id: "a", name: "Kaffe", priceOre: 2000, sortOrder: 0 },
    { id: "b", name: "Bulle", priceOre: 1500, sortOrder: 1, enabled: false },
  ];
  res = await api("PUT", "/api/products", { body: products });
  expect(res.status).toBe(200);
  const state = await (await api("GET", "/api/state")).json();
  expect(state).toEqual({
    settings: { storeName: "Kiosken", payeeNumber: "0701234567" },
    products,
  });
});

test("PUT /api/settings rejects an unpayable number and an empty name", async () => {
  const { api } = await newRoom();
  let res = await api("PUT", "/api/settings", {
    body: { storeName: "K", payeeNumber: "12345" },
  });
  expect(await res.json()).toEqual({ error: "invalid_payee" });
  res = await api("PUT", "/api/settings", {
    body: { storeName: " ", payeeNumber: "0701234567" },
  });
  expect(await res.json()).toEqual({ error: "invalid_store_name" });
});

test("PUT /api/products validates its input", async () => {
  const { api } = await newRoom();
  const bad = [
    [{ id: "a", name: "", priceOre: 100, sortOrder: 0 }],
    [{ id: "a", name: "Kaffe", priceOre: -5, sortOrder: 0 }],
    [{ id: "a", name: "Kaffe", priceOre: 1.5, sortOrder: 0 }],
    [{ id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0, enabled: "no" }],
    [
      { id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0 },
      { id: "a", name: "Te", priceOre: 200, sortOrder: 1 },
    ],
    "not an array",
  ];
  for (const body of bad) {
    expect((await api("PUT", "/api/products", { body })).status).toBe(400);
  }
});

import { expect, test } from "vitest";
import { call, configuredRoom, newRoom, pairDisplay } from "./helpers.js";

test("a charge returns an order number, total, note, payload and SVG", async () => {
  const { charge } = await configuredRoom();
  const body = await charge([{ id: "kaffe", qty: 2 }, { id: "loka", qty: 1 }], 5500);
  expect(body.orderNo).toBe(1);
  expect(body.totalOre).toBe(5500);
  expect(body.message).toBe("Kiosken #1");
  expect(body.payload).toBe("C0701234567;55.00;Kiosken #1;0");
  expect(body.svg.startsWith("<svg")).toBe(true);
  expect((await charge([{ id: "loka", qty: 1 }], 1500)).orderNo).toBe(2);
});

test("a repeated chargeId returns the identical response, not a new order", async () => {
  const { charge } = await configuredRoom();
  const id = crypto.randomUUID();
  const first = await charge([{ id: "kaffe", qty: 1 }], 2000, id);
  expect(await charge([{ id: "kaffe", qty: 1 }], 2000, id)).toEqual(first);
  expect((await charge([{ id: "kaffe", qty: 1 }], 2000)).orderNo).toBe(first.orderNo + 1);
});

test("every rejection is a named error", async () => {
  const { charge, api } = await configuredRoom();
  expect(await charge([], 0)).toEqual({ error: "empty_basket" });
  expect((await charge([{ id: "nope", qty: 1 }], 2000)).error).toBe("unknown_product");
  expect((await charge([{ id: "kaffe", qty: 0 }], 0)).error).toBe("bad_quantity");
  expect(await charge([{ id: "kaffe", qty: 1 }], 1999)).toEqual({
    error: "stale_total",
    totalOre: 2000,
  });
  const malformed = await api("POST", "/api/charge", {
    body: { chargeId: "x", items: [null], expectedTotalOre: 0 },
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "bad_request" });
});

test("absurd totals are refused at both ends", async () => {
  const { api, charge } = await configuredRoom();
  await api("PUT", "/api/products", {
    body: [
      { id: "cheap", name: "Billig", priceOre: 50, sortOrder: 0 },
      { id: "huge", name: "Dyr", priceOre: 3_000_000, sortOrder: 1 },
    ],
  });
  expect((await charge([{ id: "cheap", qty: 1 }], 50)).error).toBe("amount_too_low");
  expect((await charge([{ id: "huge", qty: 1 }], 3_000_000)).error).toBe(
    "amount_too_high",
  );
});

test("a disabled product cannot be charged", async () => {
  const { api, products, charge } = await configuredRoom();
  await api("PUT", "/api/products", {
    body: [{ ...products[0], enabled: false }, products[2]],
  });
  expect((await charge([{ id: "kaffe", qty: 1 }], 2000)).error).toBe("unknown_product");
  expect((await charge([{ id: "loka", qty: 1 }], 1500)).orderNo).toBe(1);
});

test("an unconfigured kassa cannot charge", async () => {
  const { api } = await newRoom();
  const state = await (await api("GET", "/api/state")).json();
  const p = state.products[0];
  const res = await api("POST", "/api/charge", {
    body: { chargeId: "c", items: [{ id: p.id, qty: 1 }], expectedTotalOre: p.priceOre },
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "not_configured" });
});

test("a display token cannot charge", async () => {
  const { roomId, api } = await configuredRoom();
  const displayToken = await pairDisplay(api);
  const res = await call("POST", `/api/charge?roomId=${roomId}`, {
    token: displayToken,
    body: { chargeId: "c", items: [{ id: "kaffe", qty: 1 }], expectedTotalOre: 2000 },
  });
  expect(res.status).toBe(401);
});

test("a long store name is cut so the note still ends with the order number", async () => {
  const { api, charge } = await configuredRoom();
  await api("PUT", "/api/settings", {
    body: { storeName: "Å".repeat(80) + ";x", payeeNumber: "0701234567" },
  });
  const { message, payload } = await charge([{ id: "kaffe", qty: 1 }], 2000);
  expect(Array.from(message).length).toBe(50);
  expect(message.endsWith(" #1")).toBe(true);
  expect(payload.split(";")).toHaveLength(4);
});

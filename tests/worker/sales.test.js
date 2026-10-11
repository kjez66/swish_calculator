import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { stockholmDate } from "../../src/dates.js";
import { configuredRoom, newRoom } from "./helpers.js";

const DAY = 24 * 60 * 60_000;

test("Klar saves the sale with its lines, as charged", async () => {
  const { api, products, charge, idle, sales } = await configuredRoom();
  const { orderNo } = await charge(
    [{ id: "kaffe", qty: 2 }, { id: "loka", qty: 1 }],
    5500,
  );
  await idle(true);
  // A later rename or price change must not rewrite what was sold.
  await api("PUT", "/api/products", {
    body: [{ ...products[0], name: "Bryggkaffe", priceOre: 2500 }],
  });
  const body = await sales();
  expect(body.date).toBe(stockholmDate(new Date()));
  expect(body.sales).toHaveLength(1);
  expect(body.sales[0]).toMatchObject({
    orderNo,
    totalOre: 5500,
    lines: [
      { productId: "kaffe", name: "Kaffe", priceOre: 2000, qty: 2 },
      { productId: "loka", name: "Loka", priceOre: 1500, qty: 1 },
    ],
  });
  expect(typeof body.sales[0].paidAt).toBe("number");
});

test("Avbryt saves nothing, and a later Klar cannot revive it", async () => {
  const { charge, idle, sales } = await configuredRoom();
  await charge([{ id: "kaffe", qty: 1 }], 2000);
  await idle(false);
  await idle(true);
  expect((await sales()).sales).toEqual([]);
});

test("a repeated Klar saves the sale once", async () => {
  const { charge, idle, sales } = await configuredRoom();
  await charge([{ id: "korv", qty: 1 }], 2000);
  await Promise.all([idle(true), idle(true)]);
  await idle(true);
  expect((await sales()).sales).toHaveLength(1);
});

test("an abandoned charge is replaced by the next one", async () => {
  const { charge, idle, sales } = await configuredRoom();
  await charge([{ id: "kaffe", qty: 1 }], 2000);
  const second = await charge([{ id: "loka", qty: 3 }], 4500);
  await idle(true);
  expect((await sales()).sales.map((s) => [s.orderNo, s.totalOre])).toEqual([
    [second.orderNo, 4500],
  ]);
});

test("sales list in order-number order past #9", async () => {
  const { charge, idle, sales } = await configuredRoom();
  for (let i = 0; i < 11; i++) {
    await charge([{ id: "loka", qty: 1 }], 1500);
    await idle(true);
  }
  expect((await sales()).sales.map((s) => s.orderNo)).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
});

test("DELETE /api/sales removes one sale, once", async () => {
  const { api, charge, idle, sales } = await configuredRoom();
  const first = await charge([{ id: "kaffe", qty: 1 }], 2000);
  await idle(true);
  const second = await charge([{ id: "loka", qty: 1 }], 1500);
  await idle(true);
  const date = stockholmDate(new Date());
  const del = (orderNo) => api("DELETE", `/api/sales?date=${date}&orderNo=${orderNo}`);
  expect((await del(first.orderNo)).status).toBe(200);
  expect((await sales()).sales.map((s) => s.orderNo)).toEqual([second.orderNo]);
  const again = await del(first.orderNo);
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ error: "sale_not_found" });
  expect(await (await del("x")).json()).toEqual({ error: "invalid_sale" });
});

test("GET /api/sales needs a valid date; no date means today", async () => {
  const { api, sales } = await configuredRoom();
  const res = await api("GET", "/api/sales?date=igår");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_date" });
  expect((await sales()).date).toBe(stockholmDate(new Date()));
  expect((await sales("2020-01-01")).sales).toEqual([]);
});

test("a sale older than 31 days is never listed, and the alarm deletes it", async () => {
  const { roomId, api } = await newRoom();
  const sales = async (date) => await (await api("GET", `/api/sales?date=${date}`)).json();
  const stub = env.KASSA.getByName(roomId);
  const now = Date.now();
  await runInDurableObject(stub, async (_, state) => {
    const sale = (orderNo, paidAt) => ({
      orderNo,
      date: "2026-09-01",
      totalOre: 1500,
      lines: [],
      paidAt,
    });
    await state.storage.put("sale:2026-09-01:000001", sale(1, now - 31 * DAY - 1000));
    await state.storage.put("sale:2026-09-01:000002", sale(2, now - 30 * DAY));
  });
  expect((await sales("2026-09-01")).sales.map((s) => s.orderNo)).toEqual([2]);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await runInDurableObject(stub, async (_, state) => {
    expect([...(await state.storage.list({ prefix: "sale:" })).keys()]).toEqual([
      "sale:2026-09-01:000002",
    ]);
  });
});

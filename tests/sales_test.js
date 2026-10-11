import { assertEquals } from "@std/assert";
import { withServer } from "./helpers.js";
import { summarizeSales } from "../public/shared/sales.js";
import { stockholmDate } from "../src/store.js";

async function configuredRoom(call) {
  const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
  const t = { token: operatorToken };
  await call("PUT", `/api/settings?roomId=${roomId}`, {
    ...t,
    body: { storeName: "Kiosken", payeeNumber: "0701234567" },
  });
  const products = [
    { id: "kaffe", name: "Kaffe", priceOre: 2000, sortOrder: 0 },
    { id: "korv", name: "Korv med bröd", priceOre: 2000, sortOrder: 1 },
    { id: "loka", name: "Loka", priceOre: 1500, sortOrder: 2 },
  ];
  await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body: products });
  const charge = async (items, expectedTotalOre) =>
    await (await call("POST", `/api/charge?roomId=${roomId}`, {
      ...t,
      body: { chargeId: crypto.randomUUID(), items, expectedTotalOre },
    })).json();
  const idle = (paid) =>
    call("POST", `/api/idle?roomId=${roomId}`, {
      ...t,
      body: paid ? { paid } : undefined,
    });
  const sales = async (date = stockholmDate(new Date())) =>
    await (await call("GET", `/api/sales?roomId=${roomId}&date=${date}`, t)).json();
  return { roomId, t, products, charge, idle, sales };
}

Deno.test("Klar saves the sale with its lines, as charged", async () => {
  await withServer(async ({ call }) => {
    const { roomId, t, products, charge, idle, sales } = await configuredRoom(call);
    const { orderNo } = await charge(
      [{ id: "kaffe", qty: 2 }, { id: "loka", qty: 1 }],
      5500,
    );
    await idle(true);

    // A later rename or price change must not rewrite what was sold.
    await call("PUT", `/api/products?roomId=${roomId}`, {
      ...t,
      body: [{ ...products[0], name: "Bryggkaffe", priceOre: 2500 }],
    });

    const body = await sales();
    assertEquals(body.date, stockholmDate(new Date()));
    assertEquals(body.sales.length, 1);
    const [sale] = body.sales;
    assertEquals(sale.orderNo, orderNo);
    assertEquals(sale.totalOre, 5500);
    assertEquals(sale.lines, [
      { productId: "kaffe", name: "Kaffe", priceOre: 2000, qty: 2 },
      { productId: "loka", name: "Loka", priceOre: 1500, qty: 1 },
    ]);
    assertEquals(typeof sale.paidAt, "number");
  });
});

Deno.test("Avbryt saves nothing, and a later Klar cannot revive it", async () => {
  await withServer(async ({ call }) => {
    const { charge, idle, sales } = await configuredRoom(call);
    await charge([{ id: "kaffe", qty: 1 }], 2000);
    await idle(false);
    await idle(true);
    assertEquals((await sales()).sales, []);
  });
});

Deno.test("a repeated Klar saves the sale once", async () => {
  await withServer(async ({ call }) => {
    const { charge, idle, sales } = await configuredRoom(call);
    await charge([{ id: "korv", qty: 1 }], 2000);
    await Promise.all([idle(true), idle(true)]);
    await idle(true);
    assertEquals((await sales()).sales.length, 1);
  });
});

Deno.test("an abandoned charge is replaced by the next one", async () => {
  await withServer(async ({ call }) => {
    const { charge, idle, sales } = await configuredRoom(call);
    await charge([{ id: "kaffe", qty: 1 }], 2000);
    const second = await charge([{ id: "loka", qty: 3 }], 4500);
    await idle(true);
    const body = await sales();
    assertEquals(body.sales.map((s) => [s.orderNo, s.totalOre]), [[
      second.orderNo,
      4500,
    ]]);
  });
});

Deno.test("the basket lines never reach the customer display's state", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, charge } = await configuredRoom(call);
    await charge([{ id: "kaffe", qty: 1 }], 2000);
    assertEquals("lines" in await store.getCurrent(roomId), false);
  });
});

Deno.test("DELETE /api/sales removes one sale, once", async () => {
  await withServer(async ({ call }) => {
    const { roomId, t, charge, idle, sales } = await configuredRoom(call);
    const first = await charge([{ id: "kaffe", qty: 1 }], 2000);
    await idle(true);
    const second = await charge([{ id: "loka", qty: 1 }], 1500);
    await idle(true);
    const date = stockholmDate(new Date());
    const del = (orderNo, token = t.token) =>
      call("DELETE", `/api/sales?roomId=${roomId}&date=${date}&orderNo=${orderNo}`, {
        token,
      });

    let res = await del(first.orderNo);
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals((await sales()).sales.map((s) => s.orderNo), [second.orderNo]);

    // Already gone: say so, rather than pretend something was removed.
    res = await del(first.orderNo);
    assertEquals(res.status, 404);
    assertEquals((await res.json()).error, "sale_not_found");

    res = await del("x");
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_sale");

    res = await del(second.orderNo, "not-a-token");
    assertEquals(res.status, 401);
    await res.body?.cancel();
    assertEquals((await sales()).sales.length, 1);
  });
});

Deno.test("GET /api/sales is for the operator, with a valid date", async () => {
  await withServer(async ({ call }) => {
    const { roomId, t } = await configuredRoom(call);
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, t)).json();
    const { displayToken } = await (await call("POST", "/api/pair/claim", {
      body: { code },
    })).json();
    let res = await call("GET", `/api/sales?roomId=${roomId}`, { token: displayToken });
    assertEquals(res.status, 401);
    await res.body?.cancel();

    res = await call("GET", `/api/sales?roomId=${roomId}&date=igår`, t);
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_date");

    // No date means today in Stockholm; another day is simply empty.
    res = await call("GET", `/api/sales?roomId=${roomId}`, t);
    assertEquals((await res.json()).date, stockholmDate(new Date()));
    res = await call("GET", `/api/sales?roomId=${roomId}&date=2020-01-01`, t);
    assertEquals((await res.json()).sales, []);
  });
});

Deno.test("summarizeSales totals the day per product", () => {
  const line = (productId, name, priceOre, qty) => ({ productId, name, priceOre, qty });
  const summary = summarizeSales([
    {
      orderNo: 1,
      totalOre: 5500,
      lines: [line("k", "Kaffe", 2000, 2), line("l", "Loka", 1500, 1)],
    },
    { orderNo: 2, totalOre: 2000, lines: [line("k", "Kaffe", 2000, 1)] },
    // A price change during the day: still one product, summed at each price.
    { orderNo: 3, totalOre: 2500, lines: [line("k", "Bryggkaffe", 2500, 1)] },
  ]);
  assertEquals(summary, {
    count: 3,
    totalOre: 10000,
    products: [
      { productId: "k", name: "Bryggkaffe", qty: 4, totalOre: 8500 },
      { productId: "l", name: "Loka", qty: 1, totalOre: 1500 },
    ],
  });
  assertEquals(summarizeSales([]), { count: 0, totalOre: 0, products: [] });
});

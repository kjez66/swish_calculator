import { assertEquals } from "@std/assert";
import { withServer } from "./helpers.js";
import { MESSAGE_MAX_CHARS } from "../public/shared/swish.js";

async function configuredRoom(call) {
  const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
  const t = { token: operatorToken };
  await call("PUT", `/api/settings?roomId=${roomId}`, {
    ...t,
    body: { storeName: "Kaffebaren", payeeNumber: "0701234567" },
  });
  const products = [
    { id: "kaffe", name: "Kaffe", priceOre: 2500, sortOrder: 0 },
    { id: "bulle", name: "Bulle", priceOre: 1990, sortOrder: 1 },
  ];
  await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body: products });
  const charge = (body) => call("POST", `/api/charge?roomId=${roomId}`, { ...t, body });
  return { roomId, operatorToken, t, products, charge };
}

Deno.test("a charge returns an order number, total, payload and SVG", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 2 }, { id: "bulle", qty: 1 }],
      expectedTotalOre: 6990,
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.orderNo, 1);
    assertEquals(body.totalOre, 6990);
    assertEquals(body.payload, "C0701234567;69.90;Kaffebaren #1;0");
    assertEquals(body.svg.startsWith("<svg"), true);
  });
});

Deno.test("order numbers increment across charges", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const mk = () =>
      charge({
        chargeId: crypto.randomUUID(),
        items: [{ id: "kaffe", qty: 1 }],
        expectedTotalOre: 2500,
      });
    assertEquals((await (await mk()).json()).orderNo, 1);
    assertEquals((await (await mk()).json()).orderNo, 2);
  });
});

Deno.test("a repeated chargeId returns the identical response, not a new order", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const chargeId = crypto.randomUUID();
    const body = { chargeId, items: [{ id: "kaffe", qty: 1 }], expectedTotalOre: 2500 };
    const first = await (await charge(body)).json();
    const second = await (await charge(body)).json();
    // A double-tap must not consume two order numbers.
    assertEquals(second, first);
    assertEquals(first.orderNo, 1);
  });
});

Deno.test("charging publishes the state to the room", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, charge } = await configuredRoom(call);
    await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 2500,
    });
    const current = await store.getCurrent(roomId);
    assertEquals(current.state, "charge");
    assertEquals(current.orderNo, 1);
    // KV holds the payload, never the rendered SVG: rendering is deterministic.
    assertEquals(current.svg, undefined);
  });
});

Deno.test("the note is the store name and order number", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const body = await (await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "bulle", qty: 1 }],
      expectedTotalOre: 1990,
    })).json();
    assertEquals(body.message, "Kaffebaren #1");
  });
});

Deno.test("every rejection is a hard stop with a named error", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const cases = [
      [{ items: [], expectedTotalOre: 0 }, 400, "empty_basket"],
      [
        { items: [{ id: "ghost", qty: 1 }], expectedTotalOre: 100 },
        400,
        "unknown_product",
      ],
      [{ items: [{ id: "kaffe", qty: 0 }], expectedTotalOre: 0 }, 400, "bad_quantity"],
      [
        { items: [{ id: "kaffe", qty: 1.5 }], expectedTotalOre: 100 },
        400,
        "bad_quantity",
      ],
      [{ items: [{ id: "kaffe", qty: 1 }], expectedTotalOre: 9999 }, 409, "stale_total"],
    ];
    for (const [partial, status, error] of cases) {
      const res = await charge({ chargeId: crypto.randomUUID(), ...partial });
      assertEquals(res.status, status, `expected ${status} for ${error}`);
      const body = await res.json();
      assertEquals(body.error, error);
      if (error === "unknown_product") assertEquals(body.id, "ghost");
      if (error === "bad_quantity") assertEquals(body.id, "kaffe");
    }
  });
});

Deno.test("a stale total reports the corrected figure", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    const res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 1,
    });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).totalOre, 2500);
  });
});

Deno.test("absurd totals are refused at both ends", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };
    await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...t,
      body: { storeName: "K", payeeNumber: "0701234567" },
    });
    await call("PUT", `/api/products?roomId=${roomId}`, {
      ...t,
      body: [
        { id: "cheap", name: "Billig", priceOre: 50, sortOrder: 0 },
        { id: "huge", name: "Dyr", priceOre: 3_000_000, sortOrder: 1 },
      ],
    });
    const charge = (body) => call("POST", `/api/charge?roomId=${roomId}`, { ...t, body });

    let res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "cheap", qty: 1 }],
      expectedTotalOre: 50,
    });
    assertEquals((await res.json()).error, "amount_too_low");

    res = await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "huge", qty: 1 }],
      expectedTotalOre: 3_000_000,
    });
    assertEquals((await res.json()).error, "amount_too_high");
  });
});

Deno.test("an unconfigured room cannot charge", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    await call("PUT", `/api/products?roomId=${roomId}`, {
      token: operatorToken,
      body: [{ id: "a", name: "Kaffe", priceOre: 2500, sortOrder: 0 }],
    });
    const res = await call("POST", `/api/charge?roomId=${roomId}`, {
      token: operatorToken,
      body: {
        chargeId: crypto.randomUUID(),
        items: [{ id: "a", qty: 1 }],
        expectedTotalOre: 2500,
      },
    });
    assertEquals(res.status, 409);
    assertEquals((await res.json()).error, "not_configured");
  });
});

Deno.test("a display token cannot charge", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken, products } = await configuredRoom(call);
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    const { displayToken } = await (await call("POST", "/api/pair/claim", {
      body: { code },
    })).json();

    // This is the whole point of separate tokens: a compromised display must not
    // be able to put its own QR on the screen.
    const res = await call("POST", `/api/charge?roomId=${roomId}`, {
      token: displayToken,
      body: {
        chargeId: crypto.randomUUID(),
        items: [{ id: products[0].id, qty: 1 }],
        expectedTotalOre: 2500,
      },
    });
    assertEquals(res.status, 401);
  });
});

Deno.test("idle returns the room to its welcome state", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, t, charge } = await configuredRoom(call);
    await charge({
      chargeId: crypto.randomUUID(),
      items: [{ id: "kaffe", qty: 1 }],
      expectedTotalOre: 2500,
    });
    const res = await call("POST", `/api/idle?roomId=${roomId}`, t);
    assertEquals(res.status, 200);
    assertEquals(await store.getCurrent(roomId), { state: "idle" });
  });
});

Deno.test("cancelling leaves a gap in the order sequence", async () => {
  await withServer(async ({ call }) => {
    const { roomId, t, charge } = await configuredRoom(call);
    const mk = () =>
      charge({
        chargeId: crypto.randomUUID(),
        items: [{ id: "kaffe", qty: 1 }],
        expectedTotalOre: 2500,
      });
    assertEquals((await (await mk()).json()).orderNo, 1);
    await call("POST", `/api/idle?roomId=${roomId}`, t);
    // Accepted behaviour: decrementing would race the atomic increment, and a
    // gap in the sequence costs nothing.
    assertEquals((await (await mk()).json()).orderNo, 2);
  });
});

Deno.test("a store name longer than MESSAGE_MAX_CHARS still yields a note ending in the order number", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };
    const longName = "A".repeat(MESSAGE_MAX_CHARS + 20);
    await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...t,
      body: { storeName: longName, payeeNumber: "0701234567" },
    });
    await call("PUT", `/api/products?roomId=${roomId}`, {
      ...t,
      body: [{ id: "kaffe", name: "Kaffe", priceOre: 2500, sortOrder: 0 }],
    });
    const res = await call("POST", `/api/charge?roomId=${roomId}`, {
      ...t,
      body: {
        chargeId: crypto.randomUUID(),
        items: [{ id: "kaffe", qty: 1 }],
        expectedTotalOre: 2500,
      },
    });
    const body = await res.json();
    assertEquals(body.message.endsWith(" #1"), true);
    assertEquals(Array.from(body.message).length <= MESSAGE_MAX_CHARS, true);
    const note = body.payload.split(";")[2];
    assertEquals(body.message, note);
  });
});

Deno.test("a store name containing a semicolon never corrupts the payload", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };
    await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...t,
      body: { storeName: "Kaffe;bar", payeeNumber: "0701234567" },
    });
    await call("PUT", `/api/products?roomId=${roomId}`, {
      ...t,
      body: [{ id: "kaffe", name: "Kaffe", priceOre: 2500, sortOrder: 0 }],
    });
    const res = await call("POST", `/api/charge?roomId=${roomId}`, {
      ...t,
      body: {
        chargeId: crypto.randomUUID(),
        items: [{ id: "kaffe", qty: 1 }],
        expectedTotalOre: 2500,
      },
    });
    const body = await res.json();
    assertEquals(body.message.includes(";"), false);
    const note = body.payload.split(";")[2];
    assertEquals(body.message, note);
  });
});

Deno.test("a malformed item is a 400, never a 500", async () => {
  await withServer(async ({ call }) => {
    const { charge } = await configuredRoom(call);
    for (const items of [[null], ["kaffe"], [42]]) {
      const res = await charge({
        chargeId: crypto.randomUUID(),
        items,
        expectedTotalOre: 100,
      });
      assertEquals(res.status, 400);
      assertEquals((await res.json()).error, "bad_request");
    }
  });
});

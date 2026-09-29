import { assertEquals } from "@std/assert";
import { withServer } from "./helpers.js";

Deno.test("POST /api/rooms issues a room and an operator token", async () => {
  await withServer(async ({ call, store }) => {
    const res = await call("POST", "/api/rooms");
    assertEquals(res.status, 200);
    const { roomId, operatorToken } = await res.json();
    assertEquals(await store.authenticate(roomId, operatorToken), "operator");
  });
});

Deno.test("room creation is rate limited per client", async () => {
  await withServer(async ({ call }) => {
    let last;
    for (let i = 0; i < 12; i++) last = await call("POST", "/api/rooms");
    assertEquals(last.status, 429);
  });
});

Deno.test("a spoofed x-forwarded-for does not escape the rate limit", async () => {
  await withServer(async ({ call }) => {
    // Same remoteAddr (the real client, per Deno.ServeHandlerInfo) on every
    // call; only the client-controllable XFF header rotates. The limit must
    // still trip, proving the rate-limit key never trusts XFF.
    let last;
    for (let i = 0; i < 12; i++) {
      last = await call("POST", "/api/rooms", { xff: `10.0.0.${i}` });
    }
    assertEquals(last.status, 429);
  });
});

Deno.test("a different remoteAddr is not caught by another client's rate limit", async () => {
  await withServer(async ({ call }) => {
    let last;
    for (let i = 0; i < 12; i++) {
      last = await call("POST", "/api/rooms", { remoteAddr: "198.51.100.9" });
    }
    assertEquals(last.status, 429);

    // A genuinely different client (different remoteAddr) still gets through.
    const res = await call("POST", "/api/rooms", { remoteAddr: "198.51.100.10" });
    assertEquals(res.status, 200);
  });
});

Deno.test("authenticated routes reject a missing or wrong token", async () => {
  await withServer(async ({ call }) => {
    const { roomId } = await (await call("POST", "/api/rooms")).json();
    assertEquals((await call("GET", `/api/state?roomId=${roomId}`)).status, 401);
    assertEquals(
      (await call("GET", `/api/state?roomId=${roomId}`, { token: "nope" })).status,
      401,
    );
  });
});

Deno.test("settings and products round-trip through the API", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };

    let res = await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...t,
      body: { storeName: "Kaffebaren", payeeNumber: "070-123 45 67" },
    });
    assertEquals(res.status, 200);

    const products = [{ id: "a", name: "Kaffe", priceOre: 2500, sortOrder: 0 }];
    res = await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body: products });
    assertEquals(res.status, 200);

    res = await call("GET", `/api/state?roomId=${roomId}`, t);
    const state = await res.json();
    // The payee is stored normalized, so nothing downstream has to re-parse it.
    assertEquals(state.settings.payeeNumber, "0701234567");
    assertEquals(state.products, products);
  });
});

Deno.test("PUT /api/settings rejects an unpayable number", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const res = await call("PUT", `/api/settings?roomId=${roomId}`, {
      token: operatorToken,
      body: { storeName: "X", payeeNumber: "0801234567" },
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "invalid_payee");
  });
});

Deno.test("PUT /api/products validates its input", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const t = { token: operatorToken };
    const bad = [
      [{ id: "a", name: "", priceOre: 100, sortOrder: 0 }],
      [{ id: "a", name: "Kaffe", priceOre: -5, sortOrder: 0 }],
      [{ id: "a", name: "Kaffe", priceOre: 1.5, sortOrder: 0 }],
      [{ id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0 }, {
        id: "a",
        name: "Te",
        priceOre: 200,
        sortOrder: 1,
      }],
      "not an array",
    ];
    for (const body of bad) {
      const res = await call("PUT", `/api/products?roomId=${roomId}`, { ...t, body });
      assertEquals(res.status, 400);
    }
  });
});

Deno.test("unknown API routes 404", async () => {
  await withServer(async ({ call }) => {
    assertEquals((await call("GET", "/api/nope")).status, 404);
  });
});

Deno.test("the official Swish logo is served and shown on both pages", async () => {
  await withServer(async ({ call }) => {
    const logo = await call("GET", "/brand/swish-logo.svg");
    assertEquals(logo.status, 200);
    assertEquals(logo.headers.get("content-type"), "image/svg+xml");
    assertEquals((await logo.text()).startsWith("<svg"), true);

    for (const page of ["/display.html", "/"]) {
      const html = await (await call("GET", page)).text();
      assertEquals(html.includes('src="/brand/swish-logo.svg"'), true, page);
    }
  });
});

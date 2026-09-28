import { assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { createStore, stockholmDate } from "../src/store.js";

async function withStore(fn) {
  const kv = await Deno.openKv(":memory:");
  try {
    await fn(createStore(kv), kv);
  } finally {
    kv.close();
  }
}

// createStore's second, optional argument is a test-only seam (see its
// JSDoc): it lets a test inject a deterministic pair-code generator so the
// collision-retry path can be exercised without seeding the full 10^6-value
// code space.
function createStoreForTest(kv, randomPairCode) {
  return createStore(kv, { randomPairCode });
}

Deno.test("createRoom issues a room and an operator token that authenticates", async () => {
  await withStore(async (store) => {
    const { roomId, operatorToken } = await store.createRoom();
    assertEquals(typeof roomId, "string");
    assertEquals(await store.authenticate(roomId, operatorToken), "operator");
    assertEquals(await store.authenticate(roomId, "wrong"), null);
    assertEquals(await store.authenticate("nosuchroom", operatorToken), null);
  });
});

Deno.test("settings and products round-trip", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    assertEquals(await store.getSettings(roomId), null);
    assertEquals(await store.getProducts(roomId), []);

    await store.setSettings(roomId, {
      storeName: "Kaffebaren",
      payeeNumber: "0701234567",
    });
    assertEquals(await store.getSettings(roomId), {
      storeName: "Kaffebaren",
      payeeNumber: "0701234567",
    });

    const products = [{ id: "a", name: "Kaffe", priceOre: 2500, sortOrder: 0 }];
    await store.setProducts(roomId, products);
    assertEquals(await store.getProducts(roomId), products);
  });
});

Deno.test("current state defaults to idle and round-trips", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    assertEquals(await store.getCurrent(roomId), { state: "idle" });

    const charge = {
      state: "charge",
      orderNo: 7,
      totalOre: 24900,
      message: "Kaffebaren #7",
      payload: "C0701234567;249.00;Kaffebaren #7;0",
      updatedAt: 1234,
    };
    await store.setCurrent(roomId, charge);
    assertEquals(await store.getCurrent(roomId), charge);
  });
});

Deno.test("stockholmDate uses Stockholm local time, not UTC", () => {
  // 22:30 UTC on 12 Sep is already 00:30 on 13 Sep in Stockholm (CEST, UTC+2).
  // Using UTC here would reset order numbers mid-evening during a late market.
  assertEquals(stockholmDate(new Date("2026-09-12T22:30:00Z")), "2026-09-13");
  assertEquals(stockholmDate(new Date("2026-09-12T21:30:00Z")), "2026-09-12");
  // Winter is UTC+1.
  assertEquals(stockholmDate(new Date("2026-01-12T23:30:00Z")), "2026-01-13");
});

Deno.test("nextOrderNo increments per day and resets on a new Stockholm date", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const day1 = new Date("2026-09-13T09:00:00Z");
    assertEquals(await store.nextOrderNo(roomId, day1), 1);
    assertEquals(await store.nextOrderNo(roomId, day1), 2);
    assertEquals(await store.nextOrderNo(roomId, day1), 3);

    const day2 = new Date("2026-09-14T09:00:00Z");
    assertEquals(await store.nextOrderNo(roomId, day2), 1);
  });
});

Deno.test("nextOrderNo never issues a duplicate under concurrency", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const day = new Date("2026-09-13T09:00:00Z");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => store.nextOrderNo(roomId, day)),
    );
    assertEquals(new Set(results).size, 50);
    assertEquals(Math.max(...results), 50);
  });
});

Deno.test("claimCharge runs the producer once and replays the stored response", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    let calls = 0;
    const produce = async () => {
      calls++;
      return { orderNo: await store.nextOrderNo(roomId, new Date()), totalOre: 100 };
    };

    const first = await store.claimCharge(roomId, "charge-1", produce);
    const second = await store.claimCharge(roomId, "charge-1", produce);

    // A retry must return the original response, not mint a second order number.
    assertEquals(calls, 1);
    assertEquals(second, first);
    assertEquals(first.orderNo, 1);

    const other = await store.claimCharge(roomId, "charge-2", produce);
    assertEquals(calls, 2);
    assertNotEquals(other.orderNo, first.orderNo);
  });
});

Deno.test("claimCharge never returns a pending record as a response", async () => {
  await withStore(async (store, kv) => {
    const { roomId } = await store.createRoom();
    const key = ["charge", roomId, "charge-pending"];
    // Simulate another request that has claimed the charge but not yet produced
    // a response.
    await kv.set(key, { pending: true });

    let produceCalled = false;
    const producePromise = store.claimCharge(roomId, "charge-pending", () => {
      produceCalled = true;
      return Promise.resolve({ orderNo: 1, totalOre: 100 });
    });

    // Give the wait loop a moment to poll, then complete the "other request".
    await new Promise((r) => setTimeout(r, 60));
    const response = { orderNo: 42, totalOre: 500 };
    await kv.set(key, response);

    const result = await producePromise;
    assertEquals(result, response);
    assertEquals(produceCalled, false);
  });
});

Deno.test("claimCharge deletes the pending claim if produce throws, so a retry can proceed", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    let calls = 0;
    const failingProduce = () => {
      calls++;
      return Promise.reject(new Error("boom"));
    };

    await assertRejects(() => store.claimCharge(roomId, "charge-fail", failingProduce));
    assertEquals(calls, 1);

    // The pending claim must be gone: a retry (even with a working producer)
    // must not be stuck waiting 120s for a claim that will never resolve.
    const succeed = () => Promise.resolve({ orderNo: 1, totalOre: 100 });
    const result = await store.claimCharge(roomId, "charge-fail", succeed);
    assertEquals(result, { orderNo: 1, totalOre: 100 });
  });
});

Deno.test("pair codes are single-use and yield a working display token", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const code = await store.createPairCode(roomId);
    assertEquals(/^\d{6}$/.test(code), true);

    const claimed = await store.claimPairCode(code);
    assertEquals(claimed?.roomId, roomId);
    assertEquals(await store.authenticate(roomId, claimed.displayToken), "display");

    // Single use: a shoulder-surfed code is worth nothing once claimed.
    assertEquals(await store.claimPairCode(code), null);
    assertEquals(await store.claimPairCode("000000"), null);
  });
});

Deno.test("createPairCode never overwrites a live code from another room, and retries", async () => {
  await withStore(async (store, kv) => {
    const { roomId: otherRoomId } = await store.createRoom();
    // Pre-seed a live code as if it had just been issued to another room and
    // not yet claimed.
    await kv.set(["pair", "123456"], { roomId: otherRoomId }, { expireIn: 5 * 60_000 });

    const { roomId } = await store.createRoom();
    // Inject a deterministic generator: draw the colliding code twice (so the
    // retry loop must actually run more than once), then a free one.
    const draws = ["123456", "123456", "654321"];
    let calls = 0;
    const storeWithStubbedDraw = createStoreForTest(kv, () => draws[calls++]);

    const code = await storeWithStubbedDraw.createPairCode(roomId);

    assertEquals(calls, 3);
    assertEquals(code, "654321");
    // The colliding code still belongs to the other room, untouched.
    const stillOthers = await kv.get(["pair", "123456"]);
    assertEquals(stillOthers.value, { roomId: otherRoomId });
    // The fresh code is claimable and resolves to the right room.
    const claimed = await store.claimPairCode("654321");
    assertEquals(claimed?.roomId, roomId);
  });
});

Deno.test("presence counts distinct displays", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    assertEquals(await store.countPresence(roomId), 0);
    await store.touchPresence(roomId, "d1");
    await store.touchPresence(roomId, "d2");
    await store.touchPresence(roomId, "d1");
    assertEquals(await store.countPresence(roomId), 2);
  });
});

Deno.test("stream tickets are single-use and carry a role", async () => {
  await withStore(async (store) => {
    const { roomId } = await store.createRoom();
    const ticket = await store.createTicket(roomId, "display");
    assertEquals(await store.claimTicket(ticket), { roomId, role: "display" });
    // Single use: the ticket appears in a URL, so it must be worthless once used.
    assertEquals(await store.claimTicket(ticket), null);
    assertEquals(await store.claimTicket("garbage"), null);
  });
});

Deno.test("rate limiting counts per scope, per client, per minute", async () => {
  await withStore(async (store) => {
    const t = new Date("2026-09-13T10:00:00Z");
    for (let i = 0; i < 5; i++) {
      assertEquals(await store.underRateLimit("rooms", "ip-a", 5, t), true);
    }
    assertEquals(await store.underRateLimit("rooms", "ip-a", 5, t), false);
    // A different client is unaffected.
    assertEquals(await store.underRateLimit("rooms", "ip-b", 5, t), true);
    // A different scope is unaffected.
    assertEquals(await store.underRateLimit("pair", "ip-a", 5, t), true);
    // The next minute starts a fresh window.
    assertEquals(
      await store.underRateLimit("rooms", "ip-a", 5, new Date("2026-09-13T10:01:00Z")),
      true,
    );
  });
});

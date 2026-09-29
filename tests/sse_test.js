import { assertEquals, assertRejects } from "@std/assert";
import { withServer } from "./helpers.js";

/** Read SSE frames from a Response until `count` `data:` lines have arrived. */
async function readEvents(res, count, timeoutMs = 3000) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (events.length < count && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const name = /^event: (.+)$/m.exec(frame)?.[1];
      const data = /^data: (.+)$/m.exec(frame)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return events;
}

Deno.test("pairing hands a display its own token", async () => {
  await withServer(async ({ call, store }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    assertEquals(/^\d{6}$/.test(code), true);

    const claimed = await (await call("POST", "/api/pair/claim", { body: { code } }))
      .json();
    assertEquals(claimed.roomId, roomId);
    assertEquals(await store.authenticate(roomId, claimed.displayToken), "display");
  });
});

Deno.test("a pair code cannot be claimed twice", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    assertEquals((await call("POST", "/api/pair/claim", { body: { code } })).status, 200);
    assertEquals((await call("POST", "/api/pair/claim", { body: { code } })).status, 404);
  });
});

Deno.test("pair claims are rate limited against brute force", async () => {
  await withServer(async ({ call }) => {
    let last;
    for (let i = 0; i < 25; i++) {
      last = await call("POST", "/api/pair/claim", { body: { code: "000000" } });
    }
    assertEquals(last.status, 429);
  });
});

Deno.test("a display token cannot issue a pair code", async () => {
  await withServer(async ({ call }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    const { displayToken } = await (await call("POST", "/api/pair/claim", {
      body: { code },
    })).json();

    // A display token must never be able to change what a display shows.
    const res = await call("POST", `/api/pair?roomId=${roomId}`, { token: displayToken });
    assertEquals(res.status, 401);
  });
});

Deno.test("the SSE stream sends current state as its first event", async () => {
  await withServer(async ({ call, handler }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();

    const res = await handler(
      new Request(`http://localhost/api/events?ticket=${ticket}`),
    );
    assertEquals(res.headers.get("Content-Type"), "text/event-stream");
    const events = await readEvents(res, 1);
    assertEquals(events[0].name, "state");
    assertEquals(events[0].data.state, "idle");
  });
});

Deno.test("a ticket works exactly once", async () => {
  await withServer(async ({ call, handler }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();

    const first = await handler(
      new Request(`http://localhost/api/events?ticket=${ticket}`),
    );
    await first.body.cancel();
    const second = await handler(
      new Request(`http://localhost/api/events?ticket=${ticket}`),
    );
    assertEquals(second.status, 401);
  });
});

Deno.test("a published charge reaches an open stream", async () => {
  await withServer(async ({ call, handler, hub }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();
    const res = await handler(
      new Request(`http://localhost/api/events?ticket=${ticket}`),
    );

    // The stream's owner is an operator, and an operator connection also gets an
    // immediate "presence" event. Its position relative to the initial "state"
    // replay is not a contract (see R11), so read all three frames that this
    // scenario produces and pick out the "state" events by name rather than by
    // position.
    const pending = readEvents(res, 3).then((events) =>
      events.filter((e) => e.name === "state")
    );
    await hub.publish(roomId, {
      state: "charge",
      orderNo: 3,
      totalOre: 5000,
      message: "X #3",
      payload: "C0701234567;50.00;X #3;0",
      updatedAt: Date.now(),
    });
    const events = await pending;
    assertEquals(events[1].data.orderNo, 3);
    assertEquals(events[1].data.svg.startsWith("<svg"), true);
  });
});

Deno.test("a rejecting presence call during start() errors the stream and unsubscribes from the hub", async () => {
  await withServer(async ({ call, handler, store, hub }) => {
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })).json();

    // Fail the operator's post-subscribe presence count, so start() rejects
    // after hub.subscribe has already succeeded — the exact ordering the
    // review flagged as leaving a zombie, still-subscribed stream.
    store.countPresence = () => Promise.reject(new Error("kv boom"));

    // Wrap hub.subscribe to observe whether the route actually calls the
    // unsubscribe function it was handed, without reaching into the hub's
    // private subscriber set.
    let unsubscribeCalled = false;
    const originalSubscribe = hub.subscribe.bind(hub);
    hub.subscribe = async (id, onEvent) => {
      const unsubscribe = await originalSubscribe(id, onEvent);
      return () => {
        unsubscribeCalled = true;
        unsubscribe();
      };
    };

    const res = await handler(
      new Request(`http://localhost/api/events?ticket=${ticket}`),
    );
    const reader = res.body.getReader();

    // The initial "state" replay is enqueued before the failing presence call
    // runs, so the first read still succeeds.
    const first = await reader.read();
    assertEquals(first.done, false);

    // The failing presence call must then error the stream rather than
    // leaving it open-but-silent or hanging.
    await assertRejects(() => reader.read());
    assertEquals(unsubscribeCalled, true);
  });
});

Deno.test("end to end: create room, pair, charge, and the display stream receives it", async () => {
  await withServer(async ({ call, handler }) => {
    // Operator: create and configure a room.
    const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
    const op = { token: operatorToken };
    await call("PUT", `/api/settings?roomId=${roomId}`, {
      ...op,
      body: { storeName: "Kaffebaren", payeeNumber: "0701234567" },
    });
    await call("PUT", `/api/products?roomId=${roomId}`, {
      ...op,
      body: [{ id: "kaffe", name: "Kaffe", priceOre: 2500, sortOrder: 0 }],
    });

    // Display: pair through a code, then open its own stream with its own token.
    const { code } = await (await call("POST", `/api/pair?roomId=${roomId}`, op)).json();
    const { displayToken } = await (await call("POST", "/api/pair/claim", {
      body: { code },
    })).json();
    const ticketRes = await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: displayToken,
    });
    assertEquals(ticketRes.status, 200);
    const { ticket } = await ticketRes.json();
    const res = await handler(
      new Request(`http://localhost/api/events?ticket=${ticket}`),
    );
    assertEquals(res.status, 200);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    // A read that never resolves must fail the test, not hang it.
    const read = () => {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("no SSE event within 3 s")), 3000);
      });
      return Promise.race([reader.read(), timeout]).finally(() => clearTimeout(timer));
    };
    /** Next named SSE event; comment frames (heartbeats) are skipped. */
    const nextEvent = async () => {
      while (true) {
        const i = buffer.indexOf("\n\n");
        if (i !== -1) {
          const frame = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const name = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (name && data) return { name, data: JSON.parse(data) };
          continue;
        }
        const { value, done } = await read();
        if (done) throw new Error("stream ended before the expected event");
        buffer += decoder.decode(value, { stream: true });
      }
    };

    try {
      // Wait for the replay first, so the charge below cannot race it.
      const replay = await nextEvent();
      assertEquals(replay.name, "state");
      assertEquals(replay.data.state, "idle");

      const chargeRes = await call("POST", `/api/charge?roomId=${roomId}`, {
        ...op,
        body: {
          chargeId: crypto.randomUUID(),
          items: [{ id: "kaffe", qty: 2 }],
          expectedTotalOre: 5000,
        },
      });
      assertEquals(chargeRes.status, 200);
      const charged = await chargeRes.json();

      const event = await nextEvent();
      assertEquals(event.name, "state");
      assertEquals(event.data.state, "charge");
      assertEquals(event.data.orderNo, charged.orderNo);
      assertEquals(event.data.orderNo, 1);
      assertEquals(event.data.amountText, "50,00");
      assertEquals(event.data.message, "Kaffebaren #1");
      assertEquals(event.data.svg.startsWith("<svg"), true);
    } finally {
      await reader.cancel();
    }
  });
});

import { assertEquals } from "@std/assert";
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

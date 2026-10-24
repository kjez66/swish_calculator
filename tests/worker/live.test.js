import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { call, configuredRoom, openSocket, pairDisplay } from "./helpers.js";

async function withDisplay() {
  const room = await configuredRoom();
  const displayToken = await pairDisplay(room.api);
  return { ...room, displayToken };
}

async function issueTicket(roomId, token) {
  const res = await call("POST", `/api/stream-ticket?roomId=${roomId}`, { token });
  expect(res.status).toBe(200);
  return (await res.json()).ticket;
}

function upgrade(roomId, ticket) {
  return call("GET", `/api/events?roomId=${roomId}&ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
}

test("a display reconnect replaces its oldest socket instead of being refused", async () => {
  const { roomId, displayToken, operatorToken } = await withDisplay();
  const first = await openSocket(roomId, displayToken);
  await first.next("state");
  const closed = new Promise((resolve) => {
    first.ws.addEventListener("close", (e) => resolve(e.code));
  });
  const second = await openSocket(roomId, displayToken);
  await second.next("state");
  // After a network drop the old socket can stay open, silent, on the server:
  // refusing the new one would keep the display off the air.
  const third = await openSocket(roomId, displayToken);
  expect(await third.next("state")).toEqual({ state: "idle" });
  expect(await closed).toBe(4000);
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("presence")).toEqual({ displays: 2 });
});

test("fresh tickets cannot bypass a display credential's concurrent socket limit", async () => {
  const { roomId, displayToken, operatorToken, api } = await withDisplay();
  const tickets = await Promise.all(
    Array.from({ length: 6 }, () => issueTicket(roomId, displayToken)),
  );
  const results = await Promise.all(tickets.map((ticket) => upgrade(roomId, ticket)));
  expect(results.map((res) => res.status)).toEqual([101, 101, 101, 101, 101, 101]);
  for (const res of results) res.webSocket.accept();
  // The budget is per credential and room; it does not block the operator.
  const other = await openSocket(roomId, await pairDisplay(api));
  expect(await other.next("state")).toEqual({ state: "idle" });
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("presence")).toEqual({ displays: 3 });
  const otherRoom = await withDisplay();
  const separate = await openSocket(otherRoom.roomId, otherRoom.displayToken);
  expect(await separate.next("state")).toEqual({ state: "idle" });
});

test("the room bounds all display sockets and frees capacity after a close", async () => {
  const { roomId, operatorToken, displayToken, api } = await withDisplay();
  const displays = [];
  for (let i = 0; i < 16; i++) {
    const token = i === 0 ? displayToken : await pairDisplay(api);
    for (let j = 0; j < 2; j++) {
      const display = await openSocket(roomId, token);
      await display.next("state");
      displays.push(display);
    }
  }
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("presence")).toEqual({ displays: 32 });
  const anotherToken = await pairDisplay(api);
  const refusedTicket = await issueTicket(roomId, anotherToken);
  expect((await upgrade(roomId, refusedTicket)).status).toBe(429);
  // A refused upgrade still consumes its single-use ticket.
  expect((await upgrade(roomId, refusedTicket)).status).toBe(401);
  displays[0].ws.close(1000, "bye");
  expect(await operator.next("presence")).toEqual({ displays: 31 });
  const replacement = await openSocket(roomId, displayToken);
  expect(await replacement.next("state")).toEqual({ state: "idle" });
  expect(await operator.next("presence")).toEqual({ displays: 32 });
});

test("a display hello burst is ignored before replay and presence work", async () => {
  const { roomId, operatorToken, displayToken } = await withDisplay();
  const stub = env.KASSA.getByName(roomId);
  const now = Date.now();
  await runInDurableObject(stub, (instance) => {
    instance.now = () => new Date(now);
  });
  const operator = await openSocket(roomId, operatorToken);
  await operator.next("state");
  await operator.next("presence");
  const display = await openSocket(roomId, displayToken);
  await display.next("room");
  await display.next("state");
  await operator.next("presence");
  // Await the handlers so the assertions do not depend on network timing.
  await runInDurableObject(stub, async (instance, state) => {
    const ws = state.getWebSockets("display")[0];
    await Promise.all(
      Array.from({ length: 20 }, () => instance.webSocketMessage(ws, "hello")),
    );
  });
  display.ws.send("ping");
  operator.ws.send("ping");
  await display.nextRaw("pong");
  await operator.nextRaw("pong");
  expect(display.pending()).toBe(0);
  expect(operator.pending()).toBe(0);
  // Replays resume at the boundary, with concurrent repeats still suppressed.
  await runInDurableObject(stub, async (instance, state) => {
    instance.now = () => new Date(now + 5000);
    const ws = state.getWebSockets("display")[0];
    await Promise.all([
      instance.webSocketMessage(ws, "hello"),
      instance.webSocketMessage(ws, "hello"),
    ]);
  });
  expect(await display.next("room")).toEqual({ storeName: "Kiosken" });
  expect(await display.next("state")).toEqual({ state: "idle" });
  expect(await operator.next("presence")).toEqual({ displays: 1 });
  display.ws.send("ping");
  operator.ws.send("ping");
  await display.nextRaw("pong");
  await operator.nextRaw("pong");
  expect(display.pending()).toBe(0);
  expect(operator.pending()).toBe(0);
});

test("hello replays the store name and the current state to a display", async () => {
  const { roomId, displayToken } = await withDisplay();
  const display = await openSocket(roomId, displayToken);
  expect(await display.next("room")).toEqual({ storeName: "Kiosken" });
  expect(await display.next("state")).toEqual({ state: "idle" });
});

test("a charge reaches the display, rendered, without the basket lines", async () => {
  const { roomId, displayToken, charge } = await withDisplay();
  const display = await openSocket(roomId, displayToken);
  await display.next("state");
  const { orderNo } = await charge([{ id: "kaffe", qty: 1 }], 2000);
  const state = await display.next("state");
  expect(state).toMatchObject({
    state: "charge",
    orderNo,
    totalOre: 2000,
    amountText: "20,00",
  });
  expect(state.svg.startsWith("<svg")).toBe(true);
  expect("lines" in state).toBe(false);
});

test("a new socket replays an open charge", async () => {
  const { roomId, operatorToken, charge } = await withDisplay();
  const { orderNo } = await charge([{ id: "loka", qty: 1 }], 1500);
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("state")).toMatchObject({ state: "charge", orderNo });
});

test("Klar thanks the customer live, but a replay shows a plain idle", async () => {
  const { roomId, displayToken, charge, idle } = await withDisplay();
  const display = await openSocket(roomId, displayToken);
  await display.next("state");
  await charge([{ id: "kaffe", qty: 1 }], 2000);
  await display.next("state");
  await idle(true);
  expect(await display.next("state")).toEqual({ state: "idle", thanks: true });
  const later = await openSocket(roomId, displayToken);
  expect(await later.next("state")).toEqual({ state: "idle" });
});

test("a new store name reaches open displays", async () => {
  const { roomId, displayToken, api } = await withDisplay();
  const display = await openSocket(roomId, displayToken);
  await display.next("room");
  await api("PUT", "/api/settings", {
    body: { storeName: "Nya kiosken", payeeNumber: "0701234567" },
  });
  expect(await display.next("room")).toEqual({ storeName: "Nya kiosken" });
});

test("a ticket works exactly once", async () => {
  const { roomId, operatorToken } = await configuredRoom();
  const first = await openSocket(roomId, operatorToken);
  const again = await call("GET", `/api/events?roomId=${roomId}&ticket=${first.ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(again.status).toBe(401);
});

test("an expired ticket is refused", async () => {
  const { roomId, operatorToken } = await configuredRoom();
  const { ticket } = await (
    await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
      token: operatorToken,
    })
  ).json();
  await runInDurableObject(env.KASSA.getByName(roomId), (instance) => {
    instance.now = () => new Date(Date.now() + 31_000);
  });
  const res = await call("GET", `/api/events?roomId=${roomId}&ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(401);
});

test("/api/events without an upgrade is refused", async () => {
  const { roomId } = await configuredRoom();
  const res = await call("GET", `/api/events?roomId=${roomId}&ticket=x`);
  expect(res.status).toBe(426);
});

test("ping is answered with pong", async () => {
  const { roomId, operatorToken } = await configuredRoom();
  const operator = await openSocket(roomId, operatorToken);
  operator.ws.send("ping");
  expect(await operator.nextRaw("pong")).toBe("pong");
});

test("the operator sees displays come and go", async () => {
  const { roomId, operatorToken, displayToken } = await withDisplay();
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("presence")).toEqual({ displays: 0 });
  const display = await openSocket(roomId, displayToken);
  expect(await operator.next("presence")).toEqual({ displays: 1 });
  display.ws.close(1000, "bye");
  expect(await operator.next("presence")).toEqual({ displays: 0 });
});

test("a display that stops pinging no longer counts", async () => {
  const { roomId, operatorToken, displayToken } = await withDisplay();
  const operator = await openSocket(roomId, operatorToken);
  await operator.next("presence");
  await openSocket(roomId, displayToken);
  expect(await operator.next("presence")).toEqual({ displays: 1 });
  await runInDurableObject(env.KASSA.getByName(roomId), (instance) => {
    instance.now = () => new Date(Date.now() + 46_000);
  });
  operator.ws.send("presence");
  expect(await operator.next("presence")).toEqual({ displays: 0 });
});

test("unknown messages are ignored", async () => {
  const { roomId, operatorToken, displayToken } = await withDisplay();
  const display = await openSocket(roomId, displayToken);
  await display.next("state");
  display.ws.send("foo");
  display.ws.send("presence"); // operators only
  display.ws.send("ping");
  // Unknown messages leave the socket usable and send no extra response.
  expect(await display.nextRaw("pong")).toBe("pong");
  expect(await display.next("room")).toEqual({ storeName: "Kiosken" });
  expect(display.pending()).toBe(0);
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("presence")).toEqual({ displays: 1 });
});

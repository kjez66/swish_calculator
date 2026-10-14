import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { call, configuredRoom, openSocket, pairDisplay } from "./helpers.js";

async function withDisplay() {
  const room = await configuredRoom();
  const displayToken = await pairDisplay(room.api);
  return { ...room, displayToken };
}

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
  display.ws.send("hello");
  // The socket still works: the hello is answered, and nothing else was sent.
  expect(await display.next("state")).toEqual({ state: "idle" });
  const operator = await openSocket(roomId, operatorToken);
  expect(await operator.next("presence")).toEqual({ displays: 1 });
});

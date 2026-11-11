import { runInThisContext } from "node:vm";
import { expect, test } from "vitest";
import { assetText } from "./assets.js";

const ROOM = "0f8b2c4e-1d3a-4b5c-9e7f-a1b2c3d4e5f6";
const GOOD = `/api/logo?roomId=${ROOM}&v=0123456789abcdef`;

// Run the actual ES5 asset, paired and connected, and hand back a way to
// deliver socket messages and the src of each team logo <img>.
async function display() {
  const node = () => ({ hidden: false, textContent: "", addEventListener() {} });
  const elements = {};
  const thanks = { id: "thanks" };
  const imgs = [
    { parentNode: { id: "welcome" } },
    { parentNode: { id: "charge" } },
    { parentNode: thanks },
  ];
  for (const img of imgs) {
    img.hidden = true;
    img.removeAttribute = (name) => {
      delete img[name];
    };
  }
  const document = {
    getElementById: (id) => (elements[id] ??= node()),
    querySelector: () => node(),
    querySelectorAll: (selector) => (selector === ".team-logo" ? imgs : []),
    addEventListener() {},
  };
  const storage = {
    getItem: () => JSON.stringify({ roomId: ROOM, displayToken: "token" }),
    setItem() {},
    removeItem() {},
  };
  const location = {
    search: "",
    pathname: "/display",
    protocol: "https:",
    host: "kassa.test",
  };
  const fetch = () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ticket: "t" }),
    });
  let socket = null;
  function WebSocket() {
    socket = this;
    this.send = () => {};
    this.close = () => {};
  }
  const source = await assetText("/display.js");
  runInThisContext(
    "(function(document,localStorage,location,history,navigator,fetch,window,setTimeout,clearTimeout,WebSocket){" +
      source +
      "\n})",
  )(
    document,
    storage,
    location,
    {},
    {},
    fetch,
    {},
    () => 0,
    () => {},
    WebSocket,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  const room = (logoUrl) =>
    socket.onmessage({
      data: JSON.stringify({ event: "room", data: { storeName: "Kiosken", logoUrl } }),
    });
  return { room, srcs: () => imgs.map((img) => img.src) };
}

test("the logo URL the server sends is loaded on every screen", async () => {
  const page = await display();
  page.room(GOOD);
  expect(page.srcs()).toEqual([GOOD, GOOD, GOOD]);
});

test("a logo URL that is not this app's logo path is never loaded", async () => {
  const page = await display();
  for (const bad of [
    "javascript:alert(1)",
    "https://evil.test/x.png",
    "//evil.test/api/logo?roomId=a&v=b",
    "/api/logo?roomId=a&v=b&x=javascript:alert(1)",
    `/api/logo?roomId=${ROOM}&v=0123456789abcdef#x`,
  ]) {
    page.room(GOOD);
    page.room(bad);
    expect(page.srcs(), bad).toEqual([undefined, undefined, undefined]);
  }
});

import { runInThisContext } from "node:vm";
import { expect, test, vi } from "vitest";
import { assetText } from "./assets.js";

const LS = "swish-kassa-display";
const saved = { roomId: "original-room", displayToken: "original-token" };
const proposed = {
  roomId: "proposed-room",
  displayToken: "proposed-token",
  storeName: "Andra kiosken",
  payeeNumber: "0707654321",
};

// Run the actual ES5 asset with browser boundaries supplied explicitly. No
// stream request or storage mutation may happen before the user's decision.
async function display({
  search = "?code=123456",
  paired = true,
  approve = false,
  status = 200,
} = {}) {
  const elements = {};
  const element = (id) =>
    (elements[id] ??= {
      hidden: false,
      disabled: false,
      value: "",
      textContent: "",
      addEventListener(event, handler) {
        this[event] = handler;
      },
    });
  let stored = paired ? JSON.stringify(saved) : null;
  const storage = {
    getItem: vi.fn(() => stored),
    setItem: vi.fn((_key, value) => {
      stored = value;
    }),
    removeItem: vi.fn(() => {
      stored = null;
    }),
  };
  const location = {
    search,
    pathname: "/display",
    protocol: "https:",
    host: "kassa.test",
    replace: vi.fn(),
  };
  const history = { replaceState: vi.fn() };
  const confirm = vi.fn(() => {
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/pair/claim"]);
    expect(JSON.parse(stored)).toEqual(saved);
    return approve;
  });
  const fetch = vi.fn((url) =>
    Promise.resolve({
      ok: url === "/api/pair/claim" && status === 200,
      status,
      json: () => Promise.resolve(proposed),
    }),
  );
  const source = await assetText("/display.js");
  const run = runInThisContext(
    "(function(document,localStorage,location,history,navigator,fetch,window,setTimeout,clearTimeout){" +
      source +
      "\n})",
  );
  run(
    { getElementById: element, addEventListener() {} },
    storage,
    location,
    history,
    {},
    fetch,
    { confirm },
    () => 0,
    () => {},
  );
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  await settle();
  return {
    element,
    storage,
    location,
    history,
    confirm,
    fetch,
    settle,
    stored: () => JSON.parse(stored),
  };
}

test("declining a URL pairing keeps saved credentials and never connects to the proposed room", async () => {
  const page = await display();
  expect(page.confirm).toHaveBeenCalledOnce();
  const message = page.confirm.mock.calls[0][0];
  for (const value of [proposed.storeName, proposed.payeeNumber, proposed.roomId]) {
    expect(message).toContain(value);
  }
  expect(page.stored()).toEqual(saved);
  expect(page.storage.setItem).not.toHaveBeenCalled();
  expect(page.fetch).toHaveBeenCalledOnce();
  expect(page.location.replace).toHaveBeenCalledWith("/display");
  expect(page.history.replaceState).toHaveBeenCalledWith(null, "", "/display");
});

test("approval is required before persisting and connecting to a replacement", async () => {
  const page = await display({ approve: true });
  expect(page.confirm).toHaveBeenCalledOnce();
  expect(page.storage.setItem).toHaveBeenCalledWith(
    LS,
    JSON.stringify({
      roomId: proposed.roomId,
      displayToken: proposed.displayToken,
    }),
  );
  expect(page.fetch).toHaveBeenLastCalledWith("/api/stream-ticket?roomId=proposed-room", {
    method: "POST",
    headers: { Authorization: "Bearer proposed-token" },
  });
});

test("an invalid URL code preserves the pairing and offers a return to it", async () => {
  const page = await display({ status: 404 });
  expect(page.stored()).toEqual(saved);
  expect(page.storage.removeItem).not.toHaveBeenCalled();
  expect(page.storage.setItem).not.toHaveBeenCalled();
  expect(page.confirm).not.toHaveBeenCalled();
  expect(page.element("claim").disabled).toBe(false);
  expect(page.element("keepPairing").hidden).toBe(false);
  page.element("keepPairing").click();
  expect(page.location.replace).toHaveBeenCalledWith("/display");
});

test("the pair query cannot discard credentials or bypass confirmation on manual submission", async () => {
  const page = await display({ search: "?pair&code=123456" });
  expect(page.confirm).toHaveBeenCalledOnce();
  expect(page.stored()).toEqual(saved);
  const manual = await display({ search: "?pair" });
  expect(manual.storage.removeItem).not.toHaveBeenCalled();
  expect(manual.fetch).not.toHaveBeenCalled();
  manual.element("code").value = "123456";
  manual.element("pair").submit({ preventDefault() {} });
  manual.element("pair").submit({ preventDefault() {} });
  await manual.settle();
  expect(manual.confirm).toHaveBeenCalledOnce();
  expect(manual.fetch).toHaveBeenCalledOnce();
  expect(manual.stored()).toEqual(saved);
});

test("first-time URL pairing still connects automatically", async () => {
  const page = await display({ paired: false });
  expect(page.confirm).not.toHaveBeenCalled();
  expect(page.stored()).toEqual({
    roomId: proposed.roomId,
    displayToken: proposed.displayToken,
  });
  expect(page.fetch).toHaveBeenCalledTimes(2);
});

test("opening the display normally reconnects to the saved room", async () => {
  const page = await display({ search: "" });
  expect(page.confirm).not.toHaveBeenCalled();
  expect(page.storage.removeItem).not.toHaveBeenCalled();
  expect(page.storage.setItem).not.toHaveBeenCalled();
  expect(page.fetch).toHaveBeenCalledExactlyOnceWith(
    "/api/stream-ticket?roomId=original-room",
    {
      method: "POST",
      headers: { Authorization: "Bearer original-token" },
    },
  );
});

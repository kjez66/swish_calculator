# Cloudflare Workers Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Swish-kassa's server from Deno Deploy (Deno KV, SSE, `BroadcastChannel`) to Cloudflare Workers with one Durable Object per kassa, on the free plan, with no change to what the operator and the customer see.

**Architecture:** A thin Worker routes `/api/*` to a `Kassa` Durable Object (one per kassa, SQLite-backed storage, all real work including QR rendering) or to a single `Directory` Durable Object (pair codes, rate limits). Static pages are served by Workers Static Assets. Live updates move from SSE to hibernatable WebSockets with a `hello` replay, a runtime-answered `ping`, and a daily alarm for retention.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite backend), Wrangler 4, Vitest 4.1 + `@cloudflare/vitest-plugin`, plain ES modules, `qrcode-generator@1.4.4`; Deno 2 stays only as the test runner for the pure shared modules.

**Verified before writing the tasks** (spike on Windows, Node 24.19, npm 11.17, wrangler 4.149.0, vitest 4.1.11, @cloudflare/vitest-plugin 1.4.0, workerd 1.20261006.1): `exports.default.fetch` and `env` from `cloudflare:workers`; `getByName` and RPC to a Durable Object; `src/qr.js` and `public/shared/money.js` bundle and run inside it; Stockholm time zone data; `CF-Connecting-IP` and the origin reach the object unchanged; `storage.put(object)`, `list({ prefix })`, `setAlarm`; hibernatable WebSockets with tags, attachments, runtime-answered `ping`/`pong`, `getWebSocketAutoResponseTimestamp`, `readyState` after close; `runInDurableObject` swapping the `now` field; `runDurableObjectAlarm`; `compatibility_date: "2026-10-01"`.

**Spec:** `docs/superpowers/specs/2026-10-11-cloudflare-workers-design.md` (hosting and live updates), on top of `docs/superpowers/specs/2026-09-13-swish-calculator-design.md` (everything else).

## Global Constraints

- Workers Free plan: Worker CPU 10 ms per request; Durable Object CPU 30 s per request/message; 100,000 requests/day; 13,000 GB-s Durable Object duration/day; 5 GB SQLite storage.
- No QR rendering, hashing loops or other real work in `src/worker.js`: it routes only.
- Live updates use hibernatable WebSockets (`ctx.acceptWebSocket`), never `ws.accept()` in the object and never SSE.
- Amounts are integer öre everywhere. `MIN_CHARGE_ORE = 100`, `MAX_CHARGE_ORE = 2_000_000`.
- Pair codes: 6 digits, single use, valid 5 minutes. Stream tickets: single use, valid 30 seconds. Charge records: 120 seconds. Sales: 31 days.
- Rate limits: room creation 10/minute per client, pair claims 20/minute per client; client = `CF-Connecting-IP`.
- `public/display.js` stays ES5 (`var`, no arrow functions, no `async`): it runs on an old phone.
- UI copy is Swedish; code, comments and docs are English.
- Operator token and display tokens are stored only as SHA-256 hashes.
- The customer display never receives basket lines or the payee number.

## Review Focus

1. A phone that loses its network without a close frame: the client must notice within two pings (≤ 30 s) and reconnect without waiting for the browser's `onclose`, and the operator's "Display ansluten" must drop within a minute (45 s presence window, checked at the operator's next 15 s `presence` question). Pinned by `"a display that stops pinging no longer counts"` in Task 6; the client side is checked by hand in Task 7.
2. The operator page reloaded mid-charge: a fresh socket's `hello` must bring back the open charge. Pinned by `"a new socket replays an open charge"` in Task 6.
3. Two Klar requests arriving together: exactly one sale. Pinned by `"a repeated Klar saves the sale once"` in Task 5.
4. A stream ticket used after 30 s: refused. Pinned by `"an expired ticket is refused"` in Task 6.
5. Unknown or out-of-role socket messages (`foo`, a display sending `presence`): ignored, socket stays usable. Pinned by `"unknown messages are ignored"` in Task 6.

## File Structure

| File | Responsibility |
|---|---|
| `package.json` | npm scripts (`dev`, `deploy`, `test`) and dependencies |
| `wrangler.jsonc` | Worker name, entry, static assets, Durable Object bindings and migration |
| `vitest.config.js` | Runs `tests/worker/**/*.test.js` inside the Workers runtime |
| `src/worker.js` | Entry: routes `/api/*`; exports `Kassa` and `Directory` |
| `src/kassa.js` | `Kassa` Durable Object: storage, auth, every kassa route, WebSockets, retention alarm |
| `src/directory.js` | `Directory` Durable Object: pair codes, rate limits, purge alarm |
| `src/http.js` | `json`, `fail`, `bearer` response helpers |
| `src/dates.js` | `stockholmDate` (moved from `src/store.js`) |
| `src/defaults.js` | `DEFAULT_PRODUCTS` and `defaultProducts()` (moved from `src/store.js`) |
| `src/render.js` | `render(roomState)`: adds `svg` and `amountText` to a charge (moved from `src/hub.js`) |
| `src/qr.js`, `src/tokens.js`, `public/shared/*` | Unchanged pure modules |
| `public/app.js`, `public/display.js` | Live connection switches from `EventSource` to `WebSocket` |
| `tests/worker/*.test.js`, `tests/worker/helpers.js` | Vitest tests in the Workers runtime |
| `tests/*_test.js` | Deno tests for pure modules only |
| Removed in Task 8 | `main.js`, `src/server.js`, `src/store.js`, `src/hub.js`, Deno server tests |

---

### Task 1: Toolchain and Worker skeleton

**Files:**
- Create: `package.json`, `wrangler.jsonc`, `vitest.config.js`, `src/worker.js`, `src/kassa.js`, `src/directory.js`, `src/http.js`, `tests/worker/skeleton.test.js`
- Modify: `.gitignore`, `deno.json`

**Interfaces:**
- Produces: `json(body, status = 200)`, `fail(error, status, extra = {})`, `bearer(request) -> string|null` in `src/http.js`; Worker default export `{ fetch(request, env) }`; exported classes `Kassa`, `Directory`; bindings `env.KASSA`, `env.DIRECTORY`.

- [ ] **Step 1: Install Node.js LTS (the user does this once)**

Run in PowerShell: `winget install OpenJS.NodeJS.LTS`, then open a new terminal.
Check: `node -v` prints `v22.x` or later and `npm -v` prints a version.

- [ ] **Step 2: Branch off from a clean tree**

Task 7 replaces `connect` in `public/display.js` as it is now, including the
not-yet-committed `room` event, and Task 8 deletes `src/hub.js` and
`src/server.js`. So everything currently in the working tree must be committed
first (the user decides how). Then:

```bash
git status --short   # must print nothing
git switch -c cloudflare-workers
```

- [ ] **Step 3: Create `package.json`**

```json
{
  "name": "swish-kassa",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --ip 0.0.0.0",
    "deploy": "wrangler deploy",
    "test": "vitest run"
  }
}
```

Then install, pinning the QR library to the version Deno's import map uses:

```bash
npm i -E qrcode-generator@1.4.4
npm i -D wrangler@^4 vitest@^4.1.0 @cloudflare/vitest-plugin
npm approve-scripts workerd
```

npm 11 blocks install scripts by default and warns
`allow-scripts workerd@… (postinstall: node install.js)`. `approve-scripts`
allows Cloudflare's runtime to finish installing and records that in
`package.json` under `allowScripts`, so a fresh `npm install` works too. After
upgrading Wrangler, run it again for the new `workerd` version.

- [ ] **Step 4: Create `wrangler.jsonc`**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "swish-kassa",
  "main": "src/worker.js",
  // If Wrangler says this date is newer than its runtime, use the date it names.
  "compatibility_date": "2026-10-01",
  // public/ is served as-is; the Worker only runs for paths with no file.
  "assets": { "directory": "./public" },
  "durable_objects": {
    "bindings": [
      { "name": "KASSA", "class_name": "Kassa" },
      { "name": "DIRECTORY", "class_name": "Directory" }
    ]
  },
  // SQLite-backed classes: the only kind the Free plan offers.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Kassa", "Directory"] }],
  "observability": { "enabled": true }
}
```

- [ ] **Step 5: Create `vitest.config.js`**

```js
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: { include: ["tests/worker/**/*.test.js"] },
});
```

- [ ] **Step 6: Keep Deno away from the Worker files**

In `deno.json`, add a `test` section and extend the `fmt` exclude, so Deno neither runs the Vitest files (they import `cloudflare:*`) nor formats generated folders. The file becomes:

```json
{
  "unstable": ["kv"],
  "tasks": {
    "dev": "deno run -A --watch main.js",
    "start": "deno run -A main.js",
    "test": "deno test -A"
  },
  "imports": {
    "qrcode-generator": "npm:qrcode-generator@1.4.4",
    "jsqr": "npm:jsqr@1.4.0",
    "@std/assert": "jsr:@std/assert@1",
    "@std/http/file-server": "jsr:@std/http@1/file-server"
  },
  "test": { "exclude": ["tests/worker/", "node_modules/"] },
  "lint": { "exclude": ["tests/worker/", "node_modules/", ".wrangler/"] },
  "fmt": {
    "indentWidth": 2,
    "lineWidth": 90,
    "exclude": ["docs/", "public/brand/", "node_modules/", ".wrangler/"]
  }
}
```

Append to `.gitignore`:

```
.wrangler/
```

- [ ] **Step 7: Write the failing smoke test** `tests/worker/skeleton.test.js`

```js
import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";

test("unknown API routes 404", async () => {
  const res = await exports.default.fetch("https://kassa.test/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});
```

- [ ] **Step 8: Run it to see it fail**

Run: `npm test`
Expected: FAIL, Wrangler cannot find `src/worker.js`.

- [ ] **Step 9: Create `src/http.js`**

```js
/**
 * JSON response helpers shared by the Worker and the Durable Objects.
 * @module
 */

/** @param {unknown} body @param {number} [status] */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** @param {string} error @param {number} status @param {object} [extra] */
export function fail(error, status, extra = {}) {
  return json({ error, ...extra }, status);
}

/** @param {Request} request @returns {string|null} */
export function bearer(request) {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}
```

- [ ] **Step 10: Create empty Durable Object classes**

`src/kassa.js`:

```js
import { DurableObject } from "cloudflare:workers";

/** One kassa: its settings, products, sales and live connections. */
export class Kassa extends DurableObject {}
```

`src/directory.js`:

```js
import { DurableObject } from "cloudflare:workers";

/** Shared by every kassa: pair codes and rate limits. */
export class Directory extends DurableObject {}
```

- [ ] **Step 11: Create `src/worker.js`**

```js
/**
 * The Worker: routes /api/* to the Durable Objects. It does no real work of
 * its own, because the Free plan allows it only 10 ms of CPU per request;
 * QR rendering and everything else runs in the kassa's object (30 s).
 * Static files in public/ never reach it: Workers Static Assets serves them.
 * @module
 */
import { fail } from "./http.js";

export { Directory } from "./directory.js";
export { Kassa } from "./kassa.js";

export default {
  fetch() {
    return fail("not_found", 404);
  },
};
```

- [ ] **Step 12: Run the test to see it pass**

Run: `npm test`
Expected: PASS, 1 test.

Run: `deno task test`
Expected: all existing Deno tests still pass (the `tests/worker/` folder is excluded).

- [ ] **Step 13: Commit**

```bash
git add package.json package-lock.json wrangler.jsonc vitest.config.js deno.json .gitignore src/worker.js src/kassa.js src/directory.js src/http.js tests/worker/skeleton.test.js
git commit -m "build: Cloudflare Workers toolchain and skeleton"
```

---

### Task 2: Move shared helpers out of the Deno server

**Files:**
- Create: `src/dates.js`, `src/defaults.js`, `src/render.js`, `tests/dates_test.js`, `tests/worker/runtime.test.js`
- Modify: `src/store.js` (import from the new modules), `src/hub.js` (import `render`), `tests/store_test.js` (drop the moved test)

**Interfaces:**
- Produces: `stockholmDate(date: Date) -> "YYYY-MM-DD"`; `defaultProducts() -> {id, name, priceOre, sortOrder, enabled}[]` with fresh UUIDs; `render(roomState) -> roomState` plus `svg` and `amountText` when `state === "charge"`.

- [ ] **Step 1: Write the failing tests**

`tests/dates_test.js` (Deno), moved from `tests/store_test.js`:

```js
import { assertEquals } from "@std/assert";
import { stockholmDate } from "../src/dates.js";

Deno.test("stockholmDate uses Stockholm local time, not UTC", () => {
  // 22:30 UTC on 12 Sep is already 00:30 on 13 Sep in Stockholm (CEST, UTC+2).
  // Using UTC here would reset order numbers mid-evening during a late market.
  assertEquals(stockholmDate(new Date("2026-09-12T22:30:00Z")), "2026-09-13");
  assertEquals(stockholmDate(new Date("2026-09-12T21:30:00Z")), "2026-09-12");
  // Winter is UTC+1.
  assertEquals(stockholmDate(new Date("2026-01-12T23:30:00Z")), "2026-01-13");
});
```

`tests/worker/runtime.test.js` (Workers runtime: proves its `Intl` knows Stockholm time and the QR library bundles):

```js
import { expect, test } from "vitest";
import { stockholmDate } from "../../src/dates.js";
import { render } from "../../src/render.js";
import { defaultProducts } from "../../src/defaults.js";

test("the Workers runtime has Stockholm time zone data", () => {
  expect(stockholmDate(new Date("2026-09-12T22:30:00Z"))).toBe("2026-09-13");
  expect(stockholmDate(new Date("2026-01-12T23:30:00Z"))).toBe("2026-01-13");
});

test("render adds the QR and amount text to a charge only", () => {
  const charge = render({ state: "charge", totalOre: 4500, payload: "C0701234567;45.00;K #1;0" });
  expect(charge.svg.startsWith("<svg")).toBe(true);
  expect(charge.amountText).toBe("45,00");
  expect(render({ state: "idle" })).toEqual({ state: "idle" });
});

test("defaultProducts is the kiosk menu with fresh ids", () => {
  const a = defaultProducts();
  expect(a.map((p) => [p.name, p.priceOre / 100])).toEqual([
    ["Loka", 15], ["Capri Sun", 15], ["Läsk Cola/Fanta", 20], ["Kaffe", 20],
    ["Hembakat", 15], ["Delicatoboll", 15], ["Korv med bröd", 20],
    ["Wasa Knäcke", 15], ["Corny", 15], ["Chips", 15], ["Kexchoklad", 15],
  ]);
  expect(a.every((p, i) => p.sortOrder === i && p.enabled === true)).toBe(true);
  const ids = new Set([...a, ...defaultProducts()].map((p) => p.id));
  expect(ids.size).toBe(22);
});
```

Delete the `"stockholmDate uses Stockholm local time, not UTC"` test from `tests/store_test.js` (it now lives in `tests/dates_test.js`).

- [ ] **Step 2: Run them to see them fail**

Run: `deno test -A tests/dates_test.js` → FAIL, module `src/dates.js` not found.
Run: `npm test` → FAIL, `src/dates.js` not found.

- [ ] **Step 3: Create the modules**

`src/dates.js` (body moved verbatim from `src/store.js`):

```js
/**
 * The order counter must roll over at Stockholm midnight. UTC rolls over at 01:00
 * or 02:00 local, which would reset order numbers mid-evening during a late market.
 * sv-SE formats as YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
export function stockholmDate(date) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
```

`src/defaults.js`:

```js
/**
 * HK Halmstad P13's kiosk menu, in menu order: a new kassa starts with it, so
 * the kiosk can sell right away. Prices in whole kronor.
 */
export const DEFAULT_PRODUCTS = [
  ["Loka", 15],
  ["Capri Sun", 15],
  ["Läsk Cola/Fanta", 20],
  ["Kaffe", 20],
  ["Hembakat", 15],
  ["Delicatoboll", 15],
  ["Korv med bröd", 20],
  ["Wasa Knäcke", 15],
  ["Corny", 15],
  ["Chips", 15],
  ["Kexchoklad", 15],
];

/** Fresh ids per kassa: a product id is never reused (see the spec). */
export function defaultProducts() {
  return DEFAULT_PRODUCTS.map(([name, kronor], i) => ({
    id: crypto.randomUUID(),
    name,
    priceOre: kronor * 100,
    sortOrder: i,
    enabled: true,
  }));
}
```

`src/render.js` (moved from `createHub`'s `render` in `src/hub.js`):

```js
import { toSvg } from "./qr.js";
import { formatOre } from "../public/shared/money.js";

/**
 * Attach the rendered QR and amount text. Storage keeps only the payload and
 * total because rendering is deterministic. The display page draws `svg` and
 * `amountText` and runs no payment logic of its own.
 * @param {object} roomState
 */
export function render(roomState) {
  if (roomState.state !== "charge") return { ...roomState };
  return {
    ...roomState,
    svg: toSvg(roomState.payload, `Swish QR-kod för ${formatOre(roomState.totalOre)} kr`),
    amountText: formatOre(roomState.totalOre),
  };
}
```

- [ ] **Step 4: Point the Deno server at them (it keeps working until Task 8)**

In `src/store.js`: delete the `stockholmDate` function and the `DEFAULT_PRODUCTS` constant, add at the top

```js
import { stockholmDate } from "./dates.js";
import { defaultProducts } from "./defaults.js";

export { stockholmDate };
```

and in `createRoom` replace the `DEFAULT_PRODUCTS.map(...)` expression with `defaultProducts()`.

In `src/hub.js`: delete the inner `render` function and its two imports (`toSvg`, `formatOre`), and add `import { render } from "./render.js";`.

- [ ] **Step 5: Run all tests**

Run: `deno task test` → PASS (same count as before: one test moved, none lost).
Run: `npm test` → PASS, 4 tests.

- [ ] **Step 6: Commit**

```bash
git add src/dates.js src/defaults.js src/render.js src/store.js src/hub.js tests/dates_test.js tests/store_test.js tests/worker/runtime.test.js
git commit -m "refactor: move dates, default menu and QR rendering into shared modules"
```

---

### Task 3: Directory — pair codes and rate limits

**Files:**
- Modify: `src/directory.js`
- Test: `tests/worker/directory.test.js`

**Interfaces:**
- Produces (RPC on `env.DIRECTORY.getByName("global")`):
  - `allow(scope: string, ipHash: string, limit: number, now = Date.now()) -> Promise<boolean>`
  - `createPairCode(roomId: string, now = Date.now()) -> Promise<string>` (6 digits)
  - `claimPairCode(code: string, now = Date.now()) -> Promise<string|null>` (the roomId)
  - Test seam: instance field `drawPairCode: () => string`.

- [ ] **Step 1: Write the failing tests** `tests/worker/directory.test.js`

```js
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

const directory = () => env.DIRECTORY.getByName("global");

test("rate limiting counts per scope, per client, per minute", async () => {
  const d = directory();
  const t = Date.now();
  for (let i = 0; i < 3; i++) expect(await d.allow("rooms", "ipA", 3, t)).toBe(true);
  expect(await d.allow("rooms", "ipA", 3, t)).toBe(false);
  expect(await d.allow("rooms", "ipB", 3, t)).toBe(true);
  expect(await d.allow("pair", "ipA", 3, t)).toBe(true);
  expect(await d.allow("rooms", "ipA", 3, t + 60_000)).toBe(true);
});

test("pair codes are six digits, single-use and expire after 5 minutes", async () => {
  const d = directory();
  const t = Date.now();
  const code = await d.createPairCode("room-1", t);
  expect(code).toMatch(/^\d{6}$/);
  expect(await d.claimPairCode(code, t + 1000)).toBe("room-1");
  expect(await d.claimPairCode(code, t + 2000)).toBe(null);

  const late = await d.createPairCode("room-2", t);
  expect(await d.claimPairCode(late, t + 5 * 60_000 + 1)).toBe(null);
  expect(await d.claimPairCode("12ab56", t)).toBe(null);
});

test("createPairCode never overwrites a live code from another kassa", async () => {
  const d = directory();
  const t = Date.now();
  const draws = ["111111", "111111", "222222"];
  let original;
  await runInDurableObject(d, (instance) => {
    original = instance.drawPairCode;
    instance.drawPairCode = () => draws.shift();
  });
  try {
    expect(await d.createPairCode("room-a", t)).toBe("111111");
    expect(await d.createPairCode("room-b", t)).toBe("222222");
    expect(await d.claimPairCode("111111", t)).toBe("room-a");
  } finally {
    // The instance outlives this test: an empty draw list would make the next
    // createPairCode loop forever.
    await runInDurableObject(d, (instance) => {
      instance.drawPairCode = original;
    });
  }
});

test("the purge alarm removes expired codes and windows only", async () => {
  const d = directory();
  const now = Date.now();
  const stale = await d.createPairCode("room-old", now - 10 * 60_000);
  const fresh = await d.createPairCode("room-new", now);
  await d.allow("rooms", "ipOld", 5, now - 5 * 60_000);
  expect(await runDurableObjectAlarm(d)).toBe(true);
  await runInDurableObject(d, async (_, state) => {
    const keys = [...(await state.storage.list()).keys()];
    expect(keys).toContain(`pair:${fresh}`);
    expect(keys).not.toContain(`pair:${stale}`);
    expect(keys.some((k) => k.includes("ipOld"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `npm test -- directory`
Expected: FAIL, `d.allow is not a function`.

- [ ] **Step 3: Implement `src/directory.js`**

```js
import { DurableObject } from "cloudflare:workers";
import { randomPairCode } from "./tokens.js";

const PAIR_CODE_TTL_MS = 5 * 60_000;
const RATE_WINDOW_MS = 60_000;
const PURGE_DELAY_MS = 10 * 60_000;
/** storage.delete() takes at most 128 keys per call. */
const DELETE_BATCH = 128;

/**
 * Shared by every kassa, as the single instance "global": pair codes (a display
 * claims one before it knows its kassa) and per-client rate limits.
 *
 * Each method's reads and writes touch only storage, so they run without
 * another request interleaving (Durable Object input gates): read-then-write
 * needs no extra locking here.
 */
export class Directory extends DurableObject {
  /** Test seam: a test injects a fixed sequence to force a collision. */
  drawPairCode = randomPairCode;

  /**
   * @returns {Promise<boolean>} true if this request is within the limit
   */
  async allow(scope, ipHash, limit, now = Date.now()) {
    const key = `rate:${scope}:${ipHash}:${Math.floor(now / RATE_WINDOW_MS)}`;
    const count = ((await this.ctx.storage.get(key))?.count ?? 0) + 1;
    await this.ctx.storage.put(key, { count, expiresAt: now + 2 * RATE_WINDOW_MS });
    await this.#schedulePurge();
    return count <= limit;
  }

  /**
   * A collision with another kassa's still-live code is redrawn, never
   * overwritten: that code's claimant would end up paired to the wrong kassa.
   */
  async createPairCode(roomId, now = Date.now()) {
    while (true) {
      const code = this.drawPairCode();
      const key = `pair:${code}`;
      const live = await this.ctx.storage.get(key);
      if (live && live.expiresAt > now) continue;
      await this.ctx.storage.put(key, { roomId, expiresAt: now + PAIR_CODE_TTL_MS });
      await this.#schedulePurge();
      return code;
    }
  }

  /** Single use: deleted on the first claim, valid or expired. */
  async claimPairCode(code, now = Date.now()) {
    if (!/^\d{6}$/.test(code)) return null;
    const key = `pair:${code}`;
    const entry = await this.ctx.storage.get(key);
    if (!entry) return null;
    await this.ctx.storage.delete(key);
    return entry.expiresAt > now ? entry.roomId : null;
  }

  async alarm() {
    const now = Date.now();
    const expired = [];
    for (const [key, value] of await this.ctx.storage.list()) {
      if (value.expiresAt <= now) expired.push(key);
    }
    for (let i = 0; i < expired.length; i += DELETE_BATCH) {
      await this.ctx.storage.delete(expired.slice(i, i + DELETE_BATCH));
    }
    // Anything still stored expires later: come back for it.
    if ((await this.ctx.storage.list({ limit: 1 })).size > 0) {
      await this.ctx.storage.setAlarm(now + PURGE_DELAY_MS);
    }
  }

  /** From the real clock, not the caller's `now`: a past time would fire at once. */
  async #schedulePurge() {
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PURGE_DELAY_MS);
    }
  }
}
```

- [ ] **Step 4: Run to see them pass**

Run: `npm test -- directory`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/directory.js tests/worker/directory.test.js
git commit -m "feat(worker): Directory object for pair codes and rate limits"
```

---

### Task 4: Kassa — create, authenticate, settings and products

**Files:**
- Modify: `src/kassa.js`, `src/worker.js`
- Create: `tests/worker/helpers.js`, `tests/worker/rooms.test.js`

**Interfaces:**
- Consumes: `Directory.allow`, `json`/`fail`/`bearer`, `defaultProducts`, `hashToken`/`randomToken`/`safeEqual` from `src/tokens.js`.
- Produces:
  - `Kassa.create(roomId: string) -> Promise<{roomId, operatorToken}>` (RPC)
  - `Kassa.fetch(request)` answering `GET /api/state`, `PUT /api/settings`, `PUT /api/products`
  - Kassa internals later tasks extend: `this.now: () => Date` (test seam), `#serial(fn)`, `#authorize(request, required) -> {role, room}|null`, `#routes(request, url, auth)`, storage keys `room`, `settings`, `products`.
  - Test helpers: `call(method, path, {token, body, ip, headers})`, `newIp()`, `newRoom() -> {roomId, operatorToken, api(method, path, opts)}`.

- [ ] **Step 1: Create `tests/worker/helpers.js`**

```js
import { exports } from "cloudflare:workers";

let ipSeq = 0;
/** A fresh client address, so one test never trips another's rate limit. */
export const newIp = () => `198.51.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

/**
 * Call the Worker the way a browser on the internet would.
 * @param {string} method
 * @param {string} path
 * @param {{token?: string, body?: unknown, ip?: string, headers?: object}} [options]
 */
export function call(method, path, { token, body, ip = newIp(), headers = {} } = {}) {
  return exports.default.fetch(`https://kassa.test${path}`, {
    method,
    headers: {
      "CF-Connecting-IP": ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

/** A new kassa, with `api` calling its routes as the operator. */
export async function newRoom() {
  const { roomId, operatorToken } = await (await call("POST", "/api/rooms")).json();
  const api = (method, path, options = {}) =>
    call(method, `${path}${path.includes("?") ? "&" : "?"}roomId=${roomId}`, {
      token: operatorToken,
      ...options,
    });
  return { roomId, operatorToken, api };
}
```

- [ ] **Step 2: Write the failing tests** `tests/worker/rooms.test.js`

```js
import { expect, test } from "vitest";
import { call, newRoom } from "./helpers.js";

test("POST /api/rooms issues a kassa with the default menu", async () => {
  const { roomId, operatorToken, api } = await newRoom();
  expect(roomId).toMatch(/^[0-9a-f-]{36}$/);
  expect(operatorToken.length).toBeGreaterThan(40);
  const state = await (await api("GET", "/api/state")).json();
  expect(state.settings).toBe(null);
  expect(state.products.map((p) => p.name)[0]).toBe("Loka");
  expect(state.products).toHaveLength(11);
});

test("room creation is rate limited per client", async () => {
  for (let i = 0; i < 10; i++) {
    expect((await call("POST", "/api/rooms", { ip: "203.0.113.9" })).status).toBe(200);
  }
  expect((await call("POST", "/api/rooms", { ip: "203.0.113.9" })).status).toBe(429);
  expect((await call("POST", "/api/rooms", { ip: "203.0.113.10" })).status).toBe(200);
});

test("kassa routes reject a missing or wrong token, and a bad roomId", async () => {
  const { roomId } = await newRoom();
  expect((await call("GET", `/api/state?roomId=${roomId}`)).status).toBe(401);
  expect((await call("GET", `/api/state?roomId=${roomId}`, { token: "nope" })).status).toBe(401);
  expect((await call("GET", "/api/state?roomId=not-a-uuid", { token: "x" })).status).toBe(401);
  const unknown = crypto.randomUUID();
  expect((await call("GET", `/api/state?roomId=${unknown}`, { token: "x" })).status).toBe(401);
});

test("settings and products round-trip", async () => {
  const { api } = await newRoom();
  let res = await api("PUT", "/api/settings", {
    body: { storeName: " Kiosken ", payeeNumber: "070-123 45 67" },
  });
  expect(await res.json()).toEqual({ storeName: "Kiosken", payeeNumber: "0701234567" });
  const products = [
    { id: "a", name: "Kaffe", priceOre: 2000, sortOrder: 0 },
    { id: "b", name: "Bulle", priceOre: 1500, sortOrder: 1, enabled: false },
  ];
  res = await api("PUT", "/api/products", { body: products });
  expect(res.status).toBe(200);
  const state = await (await api("GET", "/api/state")).json();
  expect(state).toEqual({
    settings: { storeName: "Kiosken", payeeNumber: "0701234567" },
    products,
  });
});

test("PUT /api/settings rejects an unpayable number and an empty name", async () => {
  const { api } = await newRoom();
  let res = await api("PUT", "/api/settings", {
    body: { storeName: "K", payeeNumber: "12345" },
  });
  expect(await res.json()).toEqual({ error: "invalid_payee" });
  res = await api("PUT", "/api/settings", { body: { storeName: " ", payeeNumber: "0701234567" } });
  expect(await res.json()).toEqual({ error: "invalid_store_name" });
});

test("PUT /api/products validates its input", async () => {
  const { api } = await newRoom();
  const bad = [
    [{ id: "a", name: "", priceOre: 100, sortOrder: 0 }],
    [{ id: "a", name: "Kaffe", priceOre: -5, sortOrder: 0 }],
    [{ id: "a", name: "Kaffe", priceOre: 1.5, sortOrder: 0 }],
    [{ id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0, enabled: "no" }],
    [
      { id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0 },
      { id: "a", name: "Te", priceOre: 200, sortOrder: 1 },
    ],
    "not an array",
  ];
  for (const body of bad) {
    expect((await api("PUT", "/api/products", { body })).status).toBe(400);
  }
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test -- rooms`
Expected: FAIL (`/api/rooms` returns 404).

- [ ] **Step 4: Route in `src/worker.js`**

Replace the file with:

```js
/**
 * The Worker: routes /api/* to the Durable Objects. It does no real work of
 * its own, because the Free plan allows it only 10 ms of CPU per request;
 * QR rendering and everything else runs in the kassa's object (30 s).
 * Static files in public/ never reach it: Workers Static Assets serves them.
 * @module
 */
import { fail, json } from "./http.js";
import { hashToken } from "./tokens.js";

export { Directory } from "./directory.js";
export { Kassa } from "./kassa.js";

const ROOMS_PER_MINUTE = 10;
/** Only ids this Worker issued: a guessed name would wake an empty object. */
const ROOM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The routes a kassa answers; anything else under /api/ is a 404. */
const KASSA_ROUTES = new Set([
  "/api/state",
  "/api/settings",
  "/api/products",
  "/api/pair",
  "/api/stream-ticket",
  "/api/events",
  "/api/charge",
  "/api/idle",
  "/api/sales",
]);

export default {
  /** @param {Request} request @param {Env} env */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    // Set by Cloudflare from the connection, overwriting any value a client
    // sends, so unlike x-forwarded-for it cannot be spoofed to dodge a limit.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const directory = env.DIRECTORY.getByName("global");

    if (path === "/api/rooms" && request.method === "POST") {
      if (!await directory.allow("rooms", await hashToken(ip), ROOMS_PER_MINUTE)) {
        return fail("rate_limited", 429);
      }
      const roomId = crypto.randomUUID();
      return json(await env.KASSA.getByName(roomId).create(roomId));
    }

    if (!KASSA_ROUTES.has(path)) return fail("not_found", 404);
    const roomId = url.searchParams.get("roomId") ?? "";
    if (!ROOM_ID.test(roomId)) return fail("unauthorized", 401);
    return env.KASSA.getByName(roomId).fetch(request);
  },
};
```

- [ ] **Step 5: Implement the first part of `src/kassa.js`**

Replace the file with:

```js
import { DurableObject } from "cloudflare:workers";
import { normalizePayee } from "../public/shared/swish.js";
import { defaultProducts } from "./defaults.js";
import { bearer, fail, json } from "./http.js";
import { hashToken, randomToken, safeEqual } from "./tokens.js";

/**
 * One kassa: its token hashes, settings, products, current state, sales log
 * and live connections, in this object's own SQLite-backed storage.
 *
 * Storage keys: "room", "settings", "products", "current", "open-sale",
 * "counter:<date>", "charge:<chargeId>", "ticket:<ticket>",
 * "sale:<date>:<orderNo, 6 digits>".
 */
export class Kassa extends DurableObject {
  /** Test seam: the clock. */
  now = () => new Date();
  #queue = Promise.resolve();

  /** RPC from the Worker: set up a new kassa. */
  async create(roomId) {
    const operatorToken = randomToken();
    await this.ctx.storage.put({
      room: {
        roomId,
        createdAt: this.now().getTime(),
        operatorTokenHash: await hashToken(operatorToken),
        displayTokenHashes: [],
      },
      products: defaultProducts(),
    });
    return { roomId, operatorToken };
  }

  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    return await this.#serial(() => this.#api(request, url));
  }

  /**
   * One request at a time. A kassa sees a handful a minute, and handling them
   * in turn makes every read-then-write (order numbers, Klar, a repeated
   * chargeId) safe without per-case locking, even across awaits that are not
   * storage calls (hashing), which input gates alone would not cover.
   * @template T @param {() => Promise<T>} fn @returns {Promise<T>}
   */
  #serial(fn) {
    const run = this.#queue.then(fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * @param {Request} request
   * @param {"operator"|"display"|"any"} required
   */
  async #authorize(request, required) {
    const token = bearer(request);
    const room = await this.ctx.storage.get("room");
    if (!token || !room) return null;
    const hash = await hashToken(token);
    const role = safeEqual(hash, room.operatorTokenHash)
      ? "operator"
      : room.displayTokenHashes.some((h) => safeEqual(hash, h))
      ? "display"
      : null;
    if (!role || (required !== "any" && role !== required)) return null;
    return { role, room };
  }

  /** @param {Request} request @param {URL} url */
  async #api(request, url) {
    const path = url.pathname;
    const method = request.method;
    const storage = this.ctx.storage;

    if (path === "/api/state" && method === "GET") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      return json({
        settings: (await storage.get("settings")) ?? null,
        products: (await storage.get("products")) ?? [],
      });
    }

    if (path === "/api/settings" && method === "PUT") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const body = await request.json().catch(() => null);
      const storeName = String(body?.storeName ?? "").trim();
      if (!storeName) return fail("invalid_store_name", 400);
      let payeeNumber;
      try {
        payeeNumber = normalizePayee(String(body?.payeeNumber ?? ""));
      } catch {
        return fail("invalid_payee", 400);
      }
      // Store the normalized form so nothing downstream has to re-parse it.
      await storage.put("settings", { storeName, payeeNumber });
      return json({ storeName, payeeNumber });
    }

    if (path === "/api/products" && method === "PUT") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const body = await request.json().catch(() => null);
      if (!Array.isArray(body)) return fail("invalid_products", 400);
      const seen = new Set();
      for (const p of body) {
        if (typeof p?.id !== "string" || !p.id) return fail("invalid_products", 400);
        if (seen.has(p.id)) return fail("duplicate_product_id", 400);
        seen.add(p.id);
        if (typeof p.name !== "string" || !p.name.trim()) {
          return fail("invalid_products", 400);
        }
        if (!Number.isInteger(p.priceOre) || p.priceOre < 0) {
          return fail("invalid_products", 400);
        }
        if (!Number.isInteger(p.sortOrder)) return fail("invalid_products", 400);
        // Optional: products saved before the flag existed have none, and are on.
        if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
          return fail("invalid_products", 400);
        }
      }
      await storage.put("products", body);
      return json({ ok: true });
    }

    return fail("not_found", 404);
  }
}
```

- [ ] **Step 6: Run to see them pass**

Run: `npm test`
Expected: PASS (all files so far).

- [ ] **Step 7: Commit**

```bash
git add src/worker.js src/kassa.js tests/worker/helpers.js tests/worker/rooms.test.js
git commit -m "feat(worker): Kassa object with kassa creation, settings and products"
```

---

### Task 5: Pairing, charging, Klar and the sales log

**Files:**
- Modify: `src/kassa.js`, `src/worker.js`, `tests/worker/helpers.js`
- Create: `tests/worker/pairing.test.js`, `tests/worker/charge.test.js`, `tests/worker/sales.test.js`

**Interfaces:**
- Consumes: Task 3 `Directory.createPairCode/claimPairCode/allow`; Task 4 `#serial`, `#authorize`, `#api`, `this.now`, `newRoom`, `call`.
- Produces:
  - `Kassa.addDisplay() -> Promise<string|null>` (RPC; the new display token)
  - Routes `POST /api/pair`, `POST /api/pair/claim` (Worker), `POST /api/charge`, `POST /api/idle`, `GET /api/sales`, `DELETE /api/sales`
  - `Kassa.alarm()` (retention), `#publish(state, live = {})` (Task 6 adds the sending)
  - Test helpers `configuredRoom()`, `pairDisplay(roomId, api) -> displayToken`
  - Storage `current`, `open-sale`, `counter:<date>`, `charge:<id>`, `sale:<date>:<000001>`

- [ ] **Step 1: Add helpers to `tests/worker/helpers.js`**

```js
/** A kassa with a store name, Swish number and three known products. */
export async function configuredRoom() {
  const room = await newRoom();
  await room.api("PUT", "/api/settings", {
    body: { storeName: "Kiosken", payeeNumber: "0701234567" },
  });
  const products = [
    { id: "kaffe", name: "Kaffe", priceOre: 2000, sortOrder: 0 },
    { id: "korv", name: "Korv med bröd", priceOre: 2000, sortOrder: 1 },
    { id: "loka", name: "Loka", priceOre: 1500, sortOrder: 2 },
  ];
  await room.api("PUT", "/api/products", { body: products });
  const charge = async (items, expectedTotalOre, chargeId = crypto.randomUUID()) =>
    await (await room.api("POST", "/api/charge", {
      body: { chargeId, items, expectedTotalOre },
    })).json();
  const idle = (paid) => room.api("POST", "/api/idle", paid ? { body: { paid } } : {});
  const sales = async (date) =>
    await (await room.api("GET", `/api/sales${date ? `?date=${date}` : ""}`)).json();
  return { ...room, products, charge, idle, sales };
}

/** Pair a display to the kassa the way the display page does. */
export async function pairDisplay(api) {
  const { code } = await (await api("POST", "/api/pair")).json();
  const res = await call("POST", "/api/pair/claim", { body: { code } });
  return (await res.json()).displayToken;
}
```

- [ ] **Step 2: Write the failing tests**

`tests/worker/pairing.test.js`:

```js
import { expect, test } from "vitest";
import { call, newRoom, pairDisplay } from "./helpers.js";

test("pairing hands a display its own token, with a scannable link", async () => {
  const { roomId, api } = await newRoom();
  const pair = await (await api("POST", "/api/pair")).json();
  expect(pair.code).toMatch(/^\d{6}$/);
  expect(pair.pairUrl).toBe(`https://kassa.test/display.html?code=${pair.code}`);
  expect(pair.pairQrSvg.startsWith("<svg")).toBe(true);
  const claim = await (await call("POST", "/api/pair/claim", { body: { code: pair.code } }))
    .json();
  expect(claim.roomId).toBe(roomId);
  const ticket = await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
    token: claim.displayToken,
  });
  expect(ticket.status).toBe(200);
});

test("a pair code cannot be claimed twice", async () => {
  const { api } = await newRoom();
  const { code } = await (await api("POST", "/api/pair")).json();
  expect((await call("POST", "/api/pair/claim", { body: { code } })).status).toBe(200);
  const again = await call("POST", "/api/pair/claim", { body: { code } });
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ error: "invalid_code" });
});

test("pair claims are rate limited against brute force", async () => {
  for (let i = 0; i < 20; i++) {
    const res = await call("POST", "/api/pair/claim", { body: { code: "000000" }, ip: "203.0.113.77" });
    expect(res.status).toBe(404);
  }
  const res = await call("POST", "/api/pair/claim", { body: { code: "000000" }, ip: "203.0.113.77" });
  expect(res.status).toBe(429);
});

test("a display token cannot issue a pair code", async () => {
  const { roomId, api } = await newRoom();
  const displayToken = await pairDisplay(api);
  const res = await call("POST", `/api/pair?roomId=${roomId}`, { token: displayToken });
  expect(res.status).toBe(401);
});
```

`tests/worker/charge.test.js`:

```js
import { expect, test } from "vitest";
import { call, configuredRoom, newRoom, pairDisplay } from "./helpers.js";

test("a charge returns an order number, total, note, payload and SVG", async () => {
  const { charge } = await configuredRoom();
  const body = await charge([{ id: "kaffe", qty: 2 }, { id: "loka", qty: 1 }], 5500);
  expect(body.orderNo).toBe(1);
  expect(body.totalOre).toBe(5500);
  expect(body.message).toBe("Kiosken #1");
  expect(body.payload).toBe("C0701234567;55.00;Kiosken #1;0");
  expect(body.svg.startsWith("<svg")).toBe(true);
  expect((await charge([{ id: "loka", qty: 1 }], 1500)).orderNo).toBe(2);
});

test("a repeated chargeId returns the identical response, not a new order", async () => {
  const { charge } = await configuredRoom();
  const id = crypto.randomUUID();
  const first = await charge([{ id: "kaffe", qty: 1 }], 2000, id);
  expect(await charge([{ id: "kaffe", qty: 1 }], 2000, id)).toEqual(first);
  expect((await charge([{ id: "kaffe", qty: 1 }], 2000)).orderNo).toBe(first.orderNo + 1);
});

test("every rejection is a named error", async () => {
  const { charge, api } = await configuredRoom();
  expect(await charge([], 0)).toEqual({ error: "empty_basket" });
  expect((await charge([{ id: "nope", qty: 1 }], 2000)).error).toBe("unknown_product");
  expect((await charge([{ id: "kaffe", qty: 0 }], 0)).error).toBe("bad_quantity");
  expect(await charge([{ id: "kaffe", qty: 1 }], 1999)).toEqual({
    error: "stale_total",
    totalOre: 2000,
  });
  const malformed = await api("POST", "/api/charge", {
    body: { chargeId: "x", items: [null], expectedTotalOre: 0 },
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.json()).toEqual({ error: "bad_request" });
});

test("absurd totals are refused at both ends", async () => {
  const { api, charge } = await configuredRoom();
  await api("PUT", "/api/products", {
    body: [
      { id: "cheap", name: "Billig", priceOre: 50, sortOrder: 0 },
      { id: "huge", name: "Dyr", priceOre: 3_000_000, sortOrder: 1 },
    ],
  });
  expect((await charge([{ id: "cheap", qty: 1 }], 50)).error).toBe("amount_too_low");
  expect((await charge([{ id: "huge", qty: 1 }], 3_000_000)).error).toBe("amount_too_high");
});

test("a disabled product cannot be charged", async () => {
  const { api, products, charge } = await configuredRoom();
  await api("PUT", "/api/products", {
    body: [{ ...products[0], enabled: false }, products[2]],
  });
  expect((await charge([{ id: "kaffe", qty: 1 }], 2000)).error).toBe("unknown_product");
  expect((await charge([{ id: "loka", qty: 1 }], 1500)).orderNo).toBe(1);
});

test("an unconfigured kassa cannot charge", async () => {
  const { api } = await newRoom();
  const state = await (await api("GET", "/api/state")).json();
  const p = state.products[0];
  const res = await api("POST", "/api/charge", {
    body: { chargeId: "c", items: [{ id: p.id, qty: 1 }], expectedTotalOre: p.priceOre },
  });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "not_configured" });
});

test("a display token cannot charge", async () => {
  const { roomId, api } = await configuredRoom();
  const displayToken = await pairDisplay(api);
  const res = await call("POST", `/api/charge?roomId=${roomId}`, {
    token: displayToken,
    body: { chargeId: "c", items: [{ id: "kaffe", qty: 1 }], expectedTotalOre: 2000 },
  });
  expect(res.status).toBe(401);
});

test("a long store name is cut so the note still ends with the order number", async () => {
  const { api, charge } = await configuredRoom();
  await api("PUT", "/api/settings", {
    body: { storeName: "Å".repeat(80) + ";x", payeeNumber: "0701234567" },
  });
  const { message, payload } = await charge([{ id: "kaffe", qty: 1 }], 2000);
  expect(Array.from(message).length).toBe(50);
  expect(message.endsWith(" #1")).toBe(true);
  expect(payload.split(";")).toHaveLength(4);
});
```

`tests/worker/sales.test.js`:

```js
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { stockholmDate } from "../../src/dates.js";
import { configuredRoom, newRoom } from "./helpers.js";

const DAY = 24 * 60 * 60_000;

test("Klar saves the sale with its lines, as charged", async () => {
  const { api, products, charge, idle, sales } = await configuredRoom();
  const { orderNo } = await charge([{ id: "kaffe", qty: 2 }, { id: "loka", qty: 1 }], 5500);
  await idle(true);
  // A later rename or price change must not rewrite what was sold.
  await api("PUT", "/api/products", {
    body: [{ ...products[0], name: "Bryggkaffe", priceOre: 2500 }],
  });
  const body = await sales();
  expect(body.date).toBe(stockholmDate(new Date()));
  expect(body.sales).toHaveLength(1);
  expect(body.sales[0]).toMatchObject({
    orderNo,
    totalOre: 5500,
    lines: [
      { productId: "kaffe", name: "Kaffe", priceOre: 2000, qty: 2 },
      { productId: "loka", name: "Loka", priceOre: 1500, qty: 1 },
    ],
  });
  expect(typeof body.sales[0].paidAt).toBe("number");
});

test("Avbryt saves nothing, and a later Klar cannot revive it", async () => {
  const { charge, idle, sales } = await configuredRoom();
  await charge([{ id: "kaffe", qty: 1 }], 2000);
  await idle(false);
  await idle(true);
  expect((await sales()).sales).toEqual([]);
});

test("a repeated Klar saves the sale once", async () => {
  const { charge, idle, sales } = await configuredRoom();
  await charge([{ id: "korv", qty: 1 }], 2000);
  await Promise.all([idle(true), idle(true)]);
  await idle(true);
  expect((await sales()).sales).toHaveLength(1);
});

test("an abandoned charge is replaced by the next one", async () => {
  const { charge, idle, sales } = await configuredRoom();
  await charge([{ id: "kaffe", qty: 1 }], 2000);
  const second = await charge([{ id: "loka", qty: 3 }], 4500);
  await idle(true);
  expect((await sales()).sales.map((s) => [s.orderNo, s.totalOre])).toEqual([
    [second.orderNo, 4500],
  ]);
});

test("sales list in order-number order past #9", async () => {
  const { charge, idle, sales } = await configuredRoom();
  for (let i = 0; i < 11; i++) {
    await charge([{ id: "loka", qty: 1 }], 1500);
    await idle(true);
  }
  expect((await sales()).sales.map((s) => s.orderNo)).toEqual(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
});

test("DELETE /api/sales removes one sale, once", async () => {
  const { api, charge, idle, sales } = await configuredRoom();
  const first = await charge([{ id: "kaffe", qty: 1 }], 2000);
  await idle(true);
  const second = await charge([{ id: "loka", qty: 1 }], 1500);
  await idle(true);
  const date = stockholmDate(new Date());
  const del = (orderNo) => api("DELETE", `/api/sales?date=${date}&orderNo=${orderNo}`);
  expect((await del(first.orderNo)).status).toBe(200);
  expect((await sales()).sales.map((s) => s.orderNo)).toEqual([second.orderNo]);
  const again = await del(first.orderNo);
  expect(again.status).toBe(404);
  expect(await again.json()).toEqual({ error: "sale_not_found" });
  expect(await (await del("x")).json()).toEqual({ error: "invalid_sale" });
});

test("GET /api/sales needs a valid date; no date means today", async () => {
  const { api, sales } = await configuredRoom();
  const res = await api("GET", "/api/sales?date=igår");
  expect(res.status).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid_date" });
  expect((await sales()).date).toBe(stockholmDate(new Date()));
  expect((await sales("2020-01-01")).sales).toEqual([]);
});

test("a sale older than 31 days is never listed, and the alarm deletes it", async () => {
  const { roomId, api } = await newRoom();
  const sales = async (date) => await (await api("GET", `/api/sales?date=${date}`)).json();
  const stub = env.KASSA.getByName(roomId);
  const now = Date.now();
  await runInDurableObject(stub, async (_, state) => {
    const sale = (orderNo, paidAt) => ({ orderNo, date: "2026-09-01", totalOre: 1500, lines: [], paidAt });
    await state.storage.put("sale:2026-09-01:000001", sale(1, now - 31 * DAY - 1000));
    await state.storage.put("sale:2026-09-01:000002", sale(2, now - 30 * DAY));
  });
  expect((await sales("2026-09-01")).sales.map((s) => s.orderNo)).toEqual([2]);
  expect(await runDurableObjectAlarm(stub)).toBe(true);
  await runInDurableObject(stub, async (_, state) => {
    expect([...(await state.storage.list({ prefix: "sale:" })).keys()]).toEqual([
      "sale:2026-09-01:000002",
    ]);
  });
});
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test -- pairing charge sales`
Expected: FAIL (`/api/pair` 404).

- [ ] **Step 4: Add the pair claim route to `src/worker.js`**

Add the constant next to `ROOMS_PER_MINUTE`:

```js
const PAIR_CLAIMS_PER_MINUTE = 20;
```

and insert this block after the `/api/rooms` block:

```js
    if (path === "/api/pair/claim" && request.method === "POST") {
      // Rate limiting is what keeps a 6-digit code from being brute-forced.
      if (!await directory.allow("pair", await hashToken(ip), PAIR_CLAIMS_PER_MINUTE)) {
        return fail("rate_limited", 429);
      }
      const body = await request.json().catch(() => null);
      const roomId = await directory.claimPairCode(String(body?.code ?? ""));
      const displayToken = roomId && await env.KASSA.getByName(roomId).addDisplay();
      if (!displayToken) return fail("invalid_code", 404);
      return json({ roomId, displayToken });
    }
```

- [ ] **Step 5: Extend `src/kassa.js`**

Replace the imports and constants at the top with:

```js
import { DurableObject } from "cloudflare:workers";
import { basketTotalOre } from "../public/shared/money.js";
import {
  buildPayload,
  MESSAGE_MAX_CHARS,
  normalizePayee,
  sanitizeMessage,
} from "../public/shared/swish.js";
import { stockholmDate } from "./dates.js";
import { defaultProducts } from "./defaults.js";
import { bearer, fail, json } from "./http.js";
import { toSvg } from "./qr.js";
import { render } from "./render.js";
import { hashToken, randomToken, safeEqual } from "./tokens.js";

/** Below 1 kr is not a real sale; above 20 000 kr is a fat-finger. Neither is a
 * Swish limit — actual ceilings are set per user by their bank. */
const MIN_CHARGE_ORE = 100;
const MAX_CHARGE_ORE = 2_000_000;
const CHARGE_RECORD_TTL_MS = 120_000;
const TICKET_TTL_MS = 30_000;
const SALE_TTL_MS = 31 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
/** storage.delete() takes at most 128 keys per call. */
const DELETE_BATCH = 128;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Zero-padded, so storage's key order is order-number order. */
const saleKey = (date, orderNo) => `sale:${date}:${String(orderNo).padStart(6, "0")}`;
```

In `create`, after the `storage.put`, start the retention alarm:

```js
    await this.ctx.storage.setAlarm(this.now().getTime() + DAY_MS);
```

Add these methods to the class (after `create`):

```js
  /** RPC from the Worker, after a valid pair claim: a new display token. */
  async addDisplay() {
    return await this.#serial(async () => {
      const room = await this.ctx.storage.get("room");
      if (!room) return null;
      const displayToken = randomToken();
      room.displayTokenHashes = [...room.displayTokenHashes, await hashToken(displayToken)];
      await this.ctx.storage.put("room", room);
      return displayToken;
    });
  }

  /**
   * Daily: delete sales paid more than 31 days ago, expired tickets and charge
   * records, and order counters older than two days. Reads skip expired
   * entries too, so nothing outlives its limit while waiting for this.
   */
  async alarm() {
    const now = this.now().getTime();
    const storage = this.ctx.storage;
    const doomed = [];
    for (const [key, sale] of await storage.list({ prefix: "sale:" })) {
      if (sale.paidAt <= now - SALE_TTL_MS) doomed.push(key);
    }
    for (const prefix of ["ticket:", "charge:"]) {
      for (const [key, value] of await storage.list({ prefix })) {
        if (value.expiresAt <= now) doomed.push(key);
      }
    }
    const oldestCounter = `counter:${stockholmDate(new Date(now - 2 * DAY_MS))}`;
    for (const key of (await storage.list({ prefix: "counter:" })).keys()) {
      if (key < oldestCounter) doomed.push(key);
    }
    for (let i = 0; i < doomed.length; i += DELETE_BATCH) {
      await storage.delete(doomed.slice(i, i + DELETE_BATCH));
    }
    await storage.setAlarm(now + DAY_MS);
  }

  /**
   * Store the new state. Task 6 adds the push to open sockets and the `live`
   * parameter (the idle route already passes it).
   * @param {object} state
   */
  async #publish(state) {
    await this.ctx.storage.put("current", state);
  }
```

In `#api`, add these routes before the final `return fail("not_found", 404);`:

```js
    if (path === "/api/pair" && method === "POST") {
      const auth = await this.#authorize(request, "operator");
      if (!auth) return fail("unauthorized", 401);
      const code = await this.env.DIRECTORY.getByName("global")
        .createPairCode(auth.room.roomId);
      // Scanning this with the display phone's camera opens the display page
      // and pairs it, with no typing. It is not payment data: it only grants the
      // same single-use, 5-minute, read-only pairing the typed code does.
      const pairUrl = `${url.origin}/display.html?code=${code}`;
      return json({
        code,
        pairUrl,
        pairQrSvg: toSvg(pairUrl, "QR-kod för att koppla displayen"),
      });
    }

    if (path === "/api/charge" && method === "POST") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const body = await request.json().catch(() => null);
      const chargeId = String(body?.chargeId ?? "");
      const items = body?.items;
      if (!chargeId || !Array.isArray(items)) return fail("bad_request", 400);
      // A non-object line would otherwise surface as a TypeError (500).
      if (items.some((i) => i === null || typeof i !== "object")) {
        return fail("bad_request", 400);
      }

      const settings = await storage.get("settings");
      if (!settings?.storeName || !settings?.payeeNumber) {
        return fail("not_configured", 409);
      }
      if (items.length === 0) return fail("empty_basket", 400);

      // A disabled product is not for sale: treated as unknown, so a stale
      // basket is refused rather than charged for something taken off the menu.
      const products = ((await storage.get("products")) ?? [])
        .filter((p) => p.enabled !== false);
      let totalOre;
      try {
        totalOre = basketTotalOre(items, products);
      } catch (err) {
        // An unknown id is rejected, never skipped: a dropped line undercharges.
        return fail(err.message, 400, { id: err.productId });
      }
      if (totalOre < MIN_CHARGE_ORE) return fail("amount_too_low", 400);
      if (totalOre > MAX_CHARGE_ORE) return fail("amount_too_high", 400);
      if (totalOre !== body?.expectedTotalOre) {
        return fail("stale_total", 409, { totalOre });
      }

      // A retry (double tap, flaky network) gets the stored response, never a
      // second order number. Requests are serial, so no claim marker is needed.
      const chargedAt = this.now();
      const recordKey = `charge:${chargeId}`;
      const record = await storage.get(recordKey);
      if (record && record.expiresAt > chargedAt.getTime()) return json(record.response);

      const date = stockholmDate(chargedAt);
      const orderNo = ((await storage.get(`counter:${date}`)) ?? 0) + 1;
      await storage.put(`counter:${date}`, orderNo);
      // The order number must survive truncation: build the suffix first,
      // then leave the store name only as much room as remains.
      const suffix = ` #${orderNo}`;
      const name = Array.from(sanitizeMessage(settings.storeName))
        .slice(0, MESSAGE_MAX_CHARS - Array.from(suffix).length)
        .join("")
        .trim();
      const message = name + suffix;
      const payload = buildPayload({ payee: settings.payeeNumber, totalOre, message });
      const roomState = {
        state: "charge",
        orderNo,
        totalOre,
        message,
        payload,
        updatedAt: chargedAt.getTime(),
      };
      // What was sold, as named and priced right now: Klar saves this, so a
      // later rename or price change cannot rewrite the sales log. Kept out of
      // `current`, which goes to the customer display.
      const byId = new Map(products.map((p) => [p.id, p]));
      await storage.put("open-sale", {
        orderNo,
        date,
        totalOre,
        lines: items.map(({ id, qty }) => ({
          productId: id,
          name: byId.get(id).name,
          priceOre: byId.get(id).priceOre,
          qty,
        })),
        chargedAt: chargedAt.getTime(),
      });
      await this.#publish(roomState);
      const response = { orderNo, totalOre, message, payload, svg: render(roomState).svg };
      await storage.put(recordKey, {
        response,
        expiresAt: chargedAt.getTime() + CHARGE_RECORD_TTL_MS,
      });
      return json(response);
    }

    if (path === "/api/idle" && method === "POST") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      // `paid: true` (the operator's Klar) makes the display thank the customer
      // and saves the sale; Avbryt sends no body and drops it. A repeat finds
      // the screen idle and saves nothing.
      const body = await request.json().catch(() => null);
      const paid = body?.paid === true;
      const current = (await storage.get("current")) ?? { state: "idle" };
      if (current.state === "charge") {
        const sale = await storage.get("open-sale");
        if (sale && sale.orderNo === current.orderNo) {
          await storage.delete("open-sale");
          if (paid) {
            await storage.put(saleKey(sale.date, sale.orderNo), {
              ...sale,
              paidAt: this.now().getTime(),
            });
          }
        }
      }
      await this.#publish({ state: "idle" }, paid ? { thanks: true } : {});
      return json({ ok: true });
    }

    if (path === "/api/sales" && method === "GET") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const date = url.searchParams.get("date") ?? stockholmDate(this.now());
      if (!DATE.test(date)) return fail("invalid_date", 400);
      const oldest = this.now().getTime() - SALE_TTL_MS;
      const sales = [...(await storage.list({ prefix: `sale:${date}:` })).values()]
        .filter((sale) => sale.paidAt > oldest);
      return json({ date, sales });
    }

    if (path === "/api/sales" && method === "DELETE") {
      if (!await this.#authorize(request, "operator")) return fail("unauthorized", 401);
      const date = url.searchParams.get("date") ?? "";
      const orderNo = Number(url.searchParams.get("orderNo"));
      if (!DATE.test(date) || !Number.isInteger(orderNo) || orderNo < 1) {
        return fail("invalid_sale", 400);
      }
      const key = saleKey(date, orderNo);
      if (!await storage.get(key)) return fail("sale_not_found", 404);
      await storage.delete(key);
      return json({ ok: true });
    }
```

- [ ] **Step 6: Run to see them pass**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 7: Commit**

```bash
git add src/worker.js src/kassa.js tests/worker/helpers.js tests/worker/pairing.test.js tests/worker/charge.test.js tests/worker/sales.test.js
git commit -m "feat(worker): pairing, charging, Klar and the sales log in the Kassa object"
```

---

### Task 6: Live updates over hibernatable WebSockets

**Files:**
- Modify: `src/kassa.js`, `tests/worker/helpers.js`
- Create: `tests/worker/live.test.js`

**Interfaces:**
- Consumes: Task 5 `#publish`, storage keys, `#authorize`, `#serial`, `this.now`.
- Produces:
  - `POST /api/stream-ticket` → `{ ticket }` (operator or display token)
  - `GET /api/events?roomId=…&ticket=…` with `Upgrade: websocket` → 101
  - Client → server messages: `"hello"`, `"ping"` (runtime answers `"pong"`), `"presence"` (operator)
  - Server → client messages: `{"event":"state"|"room"|"presence","data":…}`
  - Test helper `openSocket(roomId, token) -> {ws, next(event) -> Promise<data>, nextRaw() -> Promise<string>}`

- [ ] **Step 1: Add `openSocket` to `tests/worker/helpers.js`**

```js
/**
 * Open a live socket as the page does: ticket, upgrade, then "hello".
 * `next(event)` resolves with the data of the next message of that event,
 * skipping (and keeping) others; it fails after two seconds.
 */
export async function openSocket(roomId, token) {
  const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
    token,
  })).json();
  const res = await call("GET", `/api/events?roomId=${roomId}&ticket=${ticket}`, {
    headers: { Upgrade: "websocket" },
  });
  if (res.status !== 101) throw new Error(`upgrade failed: ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  const inbox = [];
  let wake = () => {};
  ws.addEventListener("message", (e) => {
    inbox.push(e.data);
    wake();
  });
  const take = async (match) => {
    while (true) {
      const i = inbox.findIndex(match);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((resolve, reject) => {
        wake = resolve;
        setTimeout(() => reject(new Error("no matching message")), 2000);
      });
    }
  };
  ws.send("hello");
  return {
    ws,
    ticket,
    next: async (event) =>
      JSON.parse(await take((m) => m !== "pong" && JSON.parse(m).event === event)).data,
    nextRaw: (text) => take((m) => m === text),
    /** Messages received and not yet taken. */
    pending: () => inbox.length,
  };
}
```

- [ ] **Step 2: Write the failing tests** `tests/worker/live.test.js`

```js
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
  expect(state).toMatchObject({ state: "charge", orderNo, totalOre: 2000, amountText: "20,00" });
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
  await api("PUT", "/api/settings", { body: { storeName: "Nya kiosken", payeeNumber: "0701234567" } });
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
  const { ticket } = await (await call("POST", `/api/stream-ticket?roomId=${roomId}`, {
    token: operatorToken,
  })).json();
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
```

- [ ] **Step 3: Run to see them fail**

Run: `npm test -- live`
Expected: FAIL (`/api/stream-ticket` 404).

- [ ] **Step 4: Implement in `src/kassa.js`**

Add the constant next to the others:

```js
/** A display that has not pinged (or connected) this recently is gone. */
const PRESENCE_TIMEOUT_MS = 45_000;
```

Add a constructor at the top of the class body:

```js
  constructor(ctx, env) {
    super(ctx, env);
    // Answered by the runtime itself without waking the object, so displays
    // left connected all day cost no duration.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
```

Replace `fetch` with:

```js
  /** @param {Request} request */
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/events") return await this.#openSocket(request, url);
    return await this.#serial(() => this.#api(request, url));
  }
```

Replace `#publish` with:

```js
  /**
   * Store the new state and push it, rendered, to every open socket.
   * @param {object} state
   * @param {object} [live] fields for open sockets only, never stored, so a
   *   later replay cannot repeat them (the display's "Tack!")
   */
  async #publish(state, live = {}) {
    await this.ctx.storage.put("current", state);
    this.#send(this.ctx.getWebSockets(), "state", { ...render(state), ...live });
  }
```

In the `/api/settings` route, after `await storage.put("settings", …)` add:

```js
      // Open displays show the store name; let them update without a reconnect.
      this.#send(this.ctx.getWebSockets("display"), "room", { storeName });
```

Add the ticket route to `#api` (before the final 404):

```js
    if (path === "/api/stream-ticket" && method === "POST") {
      const auth = await this.#authorize(request, "any");
      if (!auth) return fail("unauthorized", 401);
      // A browser WebSocket cannot send an Authorization header, and a token
      // in the URL would land in logs: trade it for a single-use ticket.
      const ticket = randomToken();
      await storage.put(`ticket:${ticket}`, {
        role: auth.role,
        expiresAt: this.now().getTime() + TICKET_TTL_MS,
      });
      return json({ ticket });
    }
```

Add these methods to the class:

```js
  /** @param {Request} request @param {URL} url */
  async #openSocket(request, url) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return fail("expected_websocket", 426);
    }
    const key = `ticket:${url.searchParams.get("ticket") ?? ""}`;
    const ticket = await this.ctx.storage.get(key);
    if (!ticket) return fail("unauthorized", 401);
    await this.ctx.storage.delete(key);
    const now = this.now().getTime();
    if (ticket.expiresAt <= now) return fail("unauthorized", 401);

    const [client, server] = Object.values(new WebSocketPair());
    // Hibernatable: the object can sleep while sockets stay open.
    this.ctx.acceptWebSocket(server, [ticket.role]);
    server.serializeAttachment({ role: ticket.role, connectedAt: now });
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * "hello" replays everything a fresh page needs: this is what makes a
   * dropped connection invisible, since every reconnect says hello again.
   * @param {WebSocket} ws @param {string|ArrayBuffer} message
   */
  async webSocketMessage(ws, message) {
    const { role } = ws.deserializeAttachment();
    if (message === "hello") {
      if (role === "display") {
        const settings = await this.ctx.storage.get("settings");
        this.#send([ws], "room", { storeName: settings?.storeName ?? null });
      }
      const current = (await this.ctx.storage.get("current")) ?? { state: "idle" };
      this.#send([ws], "state", render(current));
      this.#sendPresence(role === "operator" ? [ws] : this.ctx.getWebSockets("operator"));
    } else if (message === "presence" && role === "operator") {
      this.#sendPresence([ws]);
    }
    // Anything else is ignored.
  }

  /** @param {WebSocket} ws @param {number} code @param {string} reason */
  webSocketClose(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {
      // 1005/1006 cannot be echoed; the socket is gone either way.
    }
    if (ws.deserializeAttachment().role === "display") {
      this.#sendPresence(this.ctx.getWebSockets("operator"));
    }
  }

  /** @param {WebSocket[]} sockets @param {string} event @param {object} data */
  #send(sockets, event, data) {
    const message = JSON.stringify({ event, data });
    for (const ws of sockets) {
      // One dead socket must not stop the others.
      try {
        ws.send(message);
      } catch {
        // Its close handler cleans up.
      }
    }
  }

  /**
   * Open displays whose last ping (or connect) is recent: a vanished phone
   * drops out. getWebSockets() can still list a socket that is closing (the
   * one webSocketClose just closed), so only OPEN ones count.
   */
  #sendPresence(operators) {
    const cutoff = this.now().getTime() - PRESENCE_TIMEOUT_MS;
    const displays = this.ctx.getWebSockets("display").filter((ws) => {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
      return Math.max(pinged, ws.deserializeAttachment().connectedAt) > cutoff;
    }).length;
    this.#send(operators, "presence", { displays });
  }
```

- [ ] **Step 5: Run to see them pass**

Run: `npm test`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add src/kassa.js tests/worker/helpers.js tests/worker/live.test.js
git commit -m "feat(worker): live updates over hibernatable WebSockets"
```

---

### Task 7: Pages switch from EventSource to WebSocket

**Files:**
- Modify: `public/app.js` (the `connect` function), `public/display.js` (the `connect` function)

**Interfaces:**
- Consumes: Task 6's protocol (`hello`, `ping`/`pong`, `presence`, `{event, data}` messages).

- [ ] **Step 1: Replace `connect` in `public/app.js`**

Replace the whole `async function connect() { … }` with:

```js
// A ping every 15 s: the server answers "pong" without waking, and the
// "presence" question keeps the display status current. No message at all
// between two pings means the connection is dead even if the socket never
// said so (a phone that lost its network), so close it and reconnect.
const PING_MS = 15_000;

async function connect() {
  let ws;
  try {
    // A browser WebSocket cannot send headers: the token buys a one-time ticket.
    const { ticket } = await api("POST", "/api/stream-ticket");
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(
      `${scheme}://${location.host}/api/events?roomId=${room.roomId}` +
        `&ticket=${encodeURIComponent(ticket)}`,
    );
  } catch {
    setStatus("offline");
    setTimeout(connect, 5000);
    return;
  }
  let alive = true;
  let timer = 0;
  let ended = false;
  // Reconnect at once rather than wait for onclose: on a dead network the
  // closing handshake cannot finish, and the browser may report the close
  // much later. The old socket's own close is then ignored.
  const restart = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    ws.onclose = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    setStatus("offline");
    // A ticket is single-use, so a reconnect goes through a fresh one.
    setTimeout(connect, 3000);
  };
  ws.onopen = () => {
    // "hello" replays the kassa's current state. The basket and the QR dialog
    // live only in page memory, so after a reload (or a mobile browser
    // discarding the backgrounded tab) this is what brings back an open charge
    // and its Klar/Avbryt. Without it the display keeps a payable QR that
    // nothing on this page can clear.
    ws.send("hello");
    timer = setInterval(() => {
      if (!alive) return restart();
      alive = false;
      ws.send("ping");
      ws.send("presence");
    }, PING_MS);
  };
  ws.onmessage = (e) => {
    alive = true;
    if (e.data === "pong") return;
    const { event, data } = JSON.parse(e.data);
    if (event === "state") {
      if (data.state === "charge") {
        if (!$("qrDlg").open) showCharge(data);
      } else if ($("qrDlg").open) {
        $("qrDlg").close("server");
      }
    } else if (event === "presence") {
      setStatus(data.displays > 0 ? "display" : "none");
    }
  };
  ws.onclose = restart;
}
```

- [ ] **Step 2: Replace `connect` in `public/display.js` (ES5)**

Replace the whole `function connect() { … }` with:

```js
  // See app.js: ping every 15 s; no message between two pings means the
  // connection is dead, so close it and reconnect.
  var PING_MS = 15000;

  function connect() {
    if (!creds) {
      setOnline(true);
      return;
    }
    fetch("/api/stream-ticket?roomId=" + encodeURIComponent(creds.roomId), {
      method: "POST",
      headers: { Authorization: "Bearer " + creds.displayToken },
    }).then(function (res) {
      if (res.status === 401 || res.status === 403) {
        // The server no longer accepts this pairing (the kassa is gone):
        // retrying cannot help, so go back to the pair screen.
        forgetPairing();
        setOnline(true);
        show("pair");
        return null;
      }
      if (!res.ok) throw new Error("ticket");
      return res.json();
    }).then(function (data) {
      if (!data) return;
      var scheme = location.protocol === "https:" ? "wss" : "ws";
      var ws = new WebSocket(
        scheme + "://" + location.host + "/api/events?roomId=" +
          encodeURIComponent(creds.roomId) + "&ticket=" + encodeURIComponent(data.ticket),
      );
      var alive = true;
      var timer = 0;
      var ended = false;
      // Reconnect at once (see app.js): a dead network may delay onclose.
      var restart = function () {
        if (ended) return;
        ended = true;
        clearInterval(timer);
        ws.onclose = null;
        try {
          ws.close();
        } catch (e) {
          // Already closed.
        }
        setOnline(false);
        // A ticket is single-use: reconnect through a fresh one.
        setTimeout(connect, 2000);
      };
      ws.onopen = function () {
        // The server replays the store name and current state on hello, so a
        // QR that was showing before a dropped connection reappears by itself.
        ws.send("hello");
        timer = setInterval(function () {
          if (!alive) {
            restart();
            return;
          }
          alive = false;
          ws.send("ping");
        }, PING_MS);
      };
      ws.onmessage = function (e) {
        alive = true;
        if (e.data === "pong") return;
        var msg = JSON.parse(e.data);
        // Whose stall this is: shown on the welcome, charge and thank-you screens.
        if (msg.event === "room") setStoreName(msg.data.storeName);
        else if (msg.event === "state") {
          setOnline(true);
          renderState(msg.data);
        }
      };
      ws.onclose = restart;
    }).catch(function () {
      setOnline(false);
      setTimeout(connect, 3000);
    });
  }
```

- [ ] **Step 3: Lint**

Run: `deno lint public/app.js public/display.js` and `deno fmt --check public/app.js public/display.js`
Expected: no problems.

- [ ] **Step 4: Verify by hand in the real runtime**

Run: `npm run dev` (serves `http://localhost:8787`).

Check, with the operator page and `display.html` in two browser windows (or the display on a phone on the same Wi-Fi at `http://<PC IP>:8787/display.html`):

1. A new kassa shows the 11 default products. Enter store name and a test Swish number in settings.
2. Pair the display via the status button's code. The operator header shows "Display ansluten".
3. Ta betalt: the QR appears on the display. Klar: the display says Tack, the sales view lists the sale.
4. Reload the operator page during a charge: the QR dialog comes back.
5. Turn off the display phone's Wi-Fi: within a minute the operator shows "Ingen display"; turn it back on: within about 30 s the display reconnects by itself and shows the current state.
6. Stop and restart `npm run dev`: both pages reconnect by themselves.

Expected: all six behave as described.

- [ ] **Step 5: Commit**

```bash
git add public/app.js public/display.js
git commit -m "feat(pages): live updates over WebSocket with hello replay and ping"
```

---

### Task 8: Remove the Deno server and update the docs

**Files:**
- Delete: `main.js`, `src/server.js`, `src/store.js`, `src/hub.js`, `tests/helpers.js`, `tests/server_test.js`, `tests/charge_test.js`, `tests/sse_test.js`, `tests/hub_test.js`, `tests/store_test.js`, `tests/sales_test.js`
- Create: `tests/sales_summary_test.js`, `tests/pages_test.js`
- Modify: `deno.json`, `README.md`, `docs/superpowers/specs/2026-09-13-swish-calculator-design.md`

- [ ] **Step 1: Keep the two pure tests that lived in deleted files**

`tests/sales_summary_test.js` (moved from `tests/sales_test.js`):

```js
import { assertEquals } from "@std/assert";
import { summarizeSales } from "../public/shared/sales.js";

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
```

`tests/pages_test.js` (replaces the server-based logo test):

```js
import { assertEquals } from "@std/assert";

Deno.test("the official Swish logo is shipped and shown on both pages", async () => {
  const logo = await Deno.readTextFile("public/brand/swish-logo.svg");
  assertEquals(logo.startsWith("<svg"), true);
  for (const page of ["public/display.html", "public/index.html"]) {
    const html = await Deno.readTextFile(page);
    assertEquals(html.includes('src="/brand/swish-logo.svg"'), true, page);
  }
});
```

- [ ] **Step 2: Delete the Deno server and its tests**

```bash
git rm main.js src/server.js src/store.js src/hub.js tests/helpers.js tests/server_test.js tests/charge_test.js tests/sse_test.js tests/hub_test.js tests/store_test.js tests/sales_test.js
```

- [ ] **Step 3: Slim `deno.json` to the test runner**

```json
{
  "tasks": {
    "test": "deno test -A"
  },
  "imports": {
    "qrcode-generator": "npm:qrcode-generator@1.4.4",
    "jsqr": "npm:jsqr@1.4.0",
    "@std/assert": "jsr:@std/assert@1"
  },
  "test": { "exclude": ["tests/worker/", "node_modules/"] },
  "lint": { "exclude": ["tests/worker/", "node_modules/", ".wrangler/"] },
  "fmt": {
    "indentWidth": 2,
    "lineWidth": 90,
    "exclude": ["docs/", "public/brand/", "node_modules/", ".wrangler/"]
  }
}
```

- [ ] **Step 4: Run both test suites**

Run: `deno task test` → PASS (money, swish, qr, tokens, dates, sales summary, pages).
Run: `npm test` → PASS (all Worker tests).
Run: `git grep -n -E "store\.js|hub\.js|server\.js|main\.js|Deno\.openKv" -- src public tests` → no matches.
Run: `deno lint src public tests` → no problems.
Run: `deno fmt --check src/worker.js src/kassa.js src/directory.js src/http.js src/dates.js src/defaults.js src/render.js public/app.js public/display.js tests/worker tests/dates_test.js tests/sales_summary_test.js tests/pages_test.js` → no problems. (Seven older files, e.g. `src/tokens.js`, were already unformatted before this plan; leave them.)

- [ ] **Step 5: Update `README.md`**

Replace the sections "Run locally", "Hosting on Deno Deploy" and "Self-hosting" with:

````markdown
## Run locally

Requires Node.js 22 or later (for Wrangler, Cloudflare's tool) and, for the
pure-module tests, Deno 2.

```bash
npm install
npm run dev       # http://localhost:8787, the real Workers runtime
npm test          # server tests, inside the Workers runtime
deno task test    # money, Swish payload, QR and other shared code
```

`package.json` already allows `workerd`'s install script (npm 11 blocks install
scripts by default). After upgrading Wrangler, allow the new version with
`npm approve-scripts workerd`.

`npm run dev` listens on all interfaces, so phones on the same Wi-Fi can open
`http://<this computer's IP>:8787/`. Local data lives in `.wrangler/state/`;
deleting that folder deletes every local kassa.

## Hosting on Cloudflare (free)

Runs on the Workers Free plan: a Worker plus SQLite-backed Durable Objects, one
per kassa. Design and limits: `docs/superpowers/specs/2026-10-11-cloudflare-workers-design.md`.

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. `npx wrangler login` (opens the browser once).
3. `npm run deploy`. The first deploy asks you to pick a `workers.dev`
   subdomain. The kassa is then at `https://swish-kassa.<subdomain>.workers.dev`.
4. Optional: a custom domain under the Worker's *Settings → Domains & Routes* in
   the Cloudflare dashboard.
5. Run the checks in [Before taking real money](#️-before-taking-real-money).

Redeploy after a change with `npm run deploy`. Free-plan headroom for one kassa:
100,000 requests a day (a device left connected all day pings about 5,800 times),
and the Durable Object sleeps between events, so it uses almost none of its
daily duration.

## Self-hosting

The same code runs on Cloudflare's open-source runtime, `workerd`, so the app is
not tied to Cloudflare's hosting. That setup is not documented here yet.
````

In "Where your kassa lives", the first sentence stays true (data on the server, key on the phone). In "Project layout", replace the table rows for `main.js`, `src/server.js`, `src/store.js` and `src/hub.js` with:

```markdown
| `src/worker.js` | Entry: routes `/api/*` to the Durable Objects |
| `src/kassa.js` | One kassa: settings, products, charges, sales log, live WebSockets |
| `src/directory.js` | Pair codes and rate limits, shared by all kassor |
```

and change the `tests/` row to `| tests/ | tests/worker/: npm test; the rest: deno task test |`.

- [ ] **Step 6: Point the old spec at the new design**

Insert directly under the title of `docs/superpowers/specs/2026-09-13-swish-calculator-design.md`:

```markdown
> **Hosting and live updates changed on 2026-10-11:** the app now runs on
> Cloudflare Workers with Durable Objects and WebSockets. See
> `2026-10-11-cloudflare-workers-design.md`, which replaces sections 5–7
> (Deno KV, SSE, `BroadcastChannel`, Deno Deploy) of this document.
```

- [ ] **Step 7: Commit**

```bash
git add -A tests deno.json README.md docs/superpowers/specs/2026-09-13-swish-calculator-design.md
git commit -m "refactor: remove the Deno server; docs for Cloudflare"
```

---

### Task 9: Deploy and check on real phones

**Files:** none (operational).

- [ ] **Step 1: Log in (the user does this; it opens a browser)**

Both this and the first deploy can ask questions in the terminal, so the user
runs them (in Claude Code: `! npx wrangler login`, `! npm run deploy`).

Run: `npx wrangler login`
Expected: "Successfully logged in".

- [ ] **Step 2: Deploy**

Run: `npm run deploy`
Expected: Wrangler prints the `https://swish-kassa.<subdomain>.workers.dev` URL and lists the `KASSA` and `DIRECTORY` Durable Object bindings.

- [ ] **Step 3: Check on the real devices**

On the operator phone open the URL, on the display phone pair via the QR, then go through the README's "Before taking real money" list, including the two-network test (operator on mobile data, display on Wi-Fi; kill and restore the display's connection mid-charge; the QR must come back by itself).

Expected: every row passes. Record any row that fails in the README checklist before taking real money.

- [ ] **Step 4: Watch the first match day's usage**

In the Cloudflare dashboard, *Workers & Pages → swish-kassa → Metrics*: requests and Durable Object duration should be far below 100,000 requests and 13,000 GB-s for the day.

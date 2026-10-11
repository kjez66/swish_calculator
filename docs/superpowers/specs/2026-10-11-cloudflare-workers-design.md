# Swish-kassa on Cloudflare Workers — design

Supersedes the hosting and live-update parts (sections 5–7: Deno KV, SSE,
`BroadcastChannel`, Deno Deploy) of `2026-09-13-swish-calculator-design.md`.
Everything about money, the Swish payload, products, the sales log and the pages
stays as specified there.

## Why

Deno Deploy shuts down about six months after 9 October 2026 (Deno's team is
joining Cloudflare). The app must run free of charge. Cloudflare Workers' free
plan includes SQLite-backed Durable Objects, which fit this app: one small
stateful server per kassa.

## Limits that shape the design (Workers Free plan)

| Limit | Value | Consequence |
|---|---|---|
| Worker CPU per HTTP request | 10 ms | The Worker only routes. A charge QR takes ~2.7 ms median and **21 ms cold** (measured), so it must not render in the Worker. |
| Durable Object CPU per request / WebSocket message | 30 s | All real work runs in the kassa's Durable Object. |
| Durable Object duration | 13,000 GB-s/day | An object holding an open SSE stream is active all the time (~10,800 GB-s/day for one kassa at 128 MB): too close. Hibernatable WebSockets cost nothing while idle. |
| Requests | 100,000/day | A match day is a few hundred charges plus a ping per device every 15 s (≈ 5,800/day per device left connected all day). |
| SQLite storage | 5 GB per account | Sales are small (hundreds of bytes) and kept 31 days. |

## Architecture

- **`src/worker.js`** — the Worker. Static files in `public/` are served by
  Workers Static Assets without invoking it. It handles `/api/rooms` and
  `/api/pair/claim` (the two routes a caller makes before it knows a kassa's
  token), and forwards every other `/api/*` request unchanged to the kassa's
  Durable Object, `env.KASSA.getByName(roomId)`. It rejects a `roomId` that is
  not a UUID, so guesses do not wake empty objects.
- **`Kassa` Durable Object (`src/kassa.js`)** — one per kassa. Holds the room's
  token hashes, settings, products, current state, open sale, order counters,
  charge records, stream tickets and the sales log in its SQLite-backed storage.
  Answers every kassa route. Handles API requests **one at a time** (an in-memory
  promise queue): a kassa sees a handful of requests a minute, and serial
  handling makes every read-then-write safe (order numbers, Klar, a repeated
  `chargeId`) without per-case locking.
- **`Directory` Durable Object (`src/directory.js`)** — a single instance named
  `global`. Pair codes (a display claims one before it knows its kassa) and
  per-client rate limits for room creation and pair claims.
- **Client IP** for rate limits is `CF-Connecting-IP`, which Cloudflare sets
  from the connection and overwrites if a client sends it.

## Live updates: WebSockets instead of SSE

Same events and same guarantees as the SSE contract in the original spec, over a
hibernatable WebSocket:

1. The client gets a single-use, 30-second ticket from
   `POST /api/stream-ticket` (a browser WebSocket cannot send an
   `Authorization` header either), then opens
   `GET /api/events?roomId=…&ticket=…` with `Upgrade: websocket`.
2. On open, the client sends `hello`. The kassa replies with the full current
   state (`{"event":"state","data":…}`), and for a display first the store name
   (`{"event":"room","data":{"storeName":…}}`). This is the replay-on-connect
   that makes a dropped connection invisible.
3. Every state change is pushed to every socket as a `state` event carrying the
   complete rendered state (`svg`, `amountText` for a charge). `thanks: true` is
   live-only, never stored.
4. The client sends `ping` every 15 s. The runtime answers `pong` itself
   (`setWebSocketAutoResponse`), without waking the object. A client that gets
   no message between two pings closes the socket and reconnects with a fresh
   ticket.
5. **Presence:** a display counts as connected while its socket is open and it
   pinged (or connected) within the last 45 s. The operator also sends
   `presence` every 15 s, and the kassa replies with
   `{"event":"presence","data":{"displays":n}}`; it also pushes presence to
   operators when a display says `hello` or closes.
6. Unknown messages are ignored.

## Retention

Durable Object storage has no per-key expiry, so each kassa runs a daily alarm
that deletes sales paid more than 31 days ago, expired tickets and charge
records, and order counters older than two days. Reads also skip anything
expired, so nothing outlives its limit while waiting for the alarm. The
`Directory` purges expired pair codes and rate-limit windows with an alarm
10 minutes after a write.

## Development and tests

- Node.js LTS and npm for Wrangler. `npm run dev` runs the real runtime locally
  (`http://localhost:8787`, storage in `.wrangler/state`).
- Server tests run in the Workers runtime with Vitest and
  `@cloudflare/vitest-plugin` (`npm test`, files in `tests/worker/`).
- Pure modules shared by browser and server (`public/shared/*`, `src/qr.js`,
  `src/tokens.js`, `src/dates.js`) keep their Deno tests (`deno task test`).
- The Deno server (`main.js`, `src/server.js`, `src/store.js`, `src/hub.js`) is
  removed once the Worker passes the same behaviours.

## Not carried over

No data moves from Deno KV. A kassa is created afresh the first time the
operator phone opens the new site.

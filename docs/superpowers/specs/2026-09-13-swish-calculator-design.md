# Swish Calculator — Design

Date: 2026-09-13
Revision: 2 (sync layer redesigned for Deno Deploy's multi-isolate runtime)
Status: Approved, ready for implementation planning

## 1. Purpose

A two-device point-of-sale for a small Swedish market stall. The operator taps
products into a basket on their own phone and presses Buy. A second, older phone
facing the customer displays the amount and a Swish QR code. Scanning it opens
the customer's Swish app with the payee, amount and note already filled in and
locked.

### Goals

- Define roughly 20 products with names and prices, editable at the stall.
- Tap products into a basket, see a running total.
- On Buy, show a scannable Swish QR on a customer-facing screen.
- The scanned code prefills payee, amount, and a note of the form `<store name> #<order number>`.

### Non-goals (v1)

Sales history and reporting; refunds; discounts; inventory counts; receipts;
multiple simultaneous operators; offline operation (see section 13).

### What this app cannot do

It cannot confirm that a payment was received. Swish provides no callback for a
private payee number. "Done" means the operator saw the payment land in their own
Swish app. The UI must state this so it is never mistaken for a system
confirmation.

## 2. Users and devices

| Role | Device | Assumptions |
|---|---|---|
| Operator | The user's own phone | Modern browser, ES modules, mobile data |
| Customer display | An old spare phone | Possibly dated browser, same network or its own data |
| Customer | Their own phone | Swish app installed, scans with the Swish app or camera |

Payee is a **private mobile number** (Swish privat). The payload format also
accepts a merchant number (10 digits beginning `123`), and the implementation
must not assume which.

Note: Swish's terms reserve commercial use for a merchant number. This is the
user's informed choice and does not change the design.

## 3. Architecture

A single Deno application deployed to Deno Deploy. It serves two static pages and
a small JSON + SSE API. No build step and no frontend framework, so what reaches
the old phone is plain HTML, CSS and JavaScript.

```
Operator phone ──POST /api/charge──▶ isolate A ──┐
                                                 │ BroadcastChannel("room-events")
Display phone  ◀────SSE stream───── isolate B ◀──┘
                                                 └─ Deno KV: durable room state
```

### The multi-isolate constraint

**Deno Deploy runs many isolates across regions, started and stopped at will.**
The operator's POST and the display's open SSE stream routinely land on different
isolates. Any design that keeps the subscriber registry only in process memory
delivers events to the wrong isolate and drops them silently. Two mechanisms
follow from this, and neither is optional:

- **Fan-out goes over `BroadcastChannel`.** Each isolate holds a local
  `Map<roomId, Set<subscriber>>` and exactly one `BroadcastChannel("room-events")`.
  Publishing means posting to the channel *and* fanning out locally, because a
  `BroadcastChannel` does not deliver a message back to the object that posted it.
- **Every cross-request fact lives in KV**, never in a module-level variable:
  room state, charge idempotency records, presence, and rate limits.

### Other rules

- **The server is the sole author of payment data.** Clients never construct a
  Swish payload or render a QR. There is exactly one implementation to test and
  one place a bug can live.
- **The display is deliberately dumb.** It receives rendered SVG and text and
  draws them. It runs no payment logic and needs no modern browser features.

Money logic lives in `public/shared/money.js`, a plain JavaScript module carrying
JSDoc types. It sits under `public/` so it is served to the browser by the same
static handler as everything else, with no special route; Deno imports the same
file directly for tests and for server-side use. The operator page needs a live
running total while tapping and the server needs the authoritative total at Buy —
sharing one module means those two numbers cannot drift apart.

`public/shared/swish.js` sits beside it and is written to the same
browser-compatible constraints, but in v1 it is **imported only by the server**,
per the rule above. It is positioned for Phase 2 (section 13), where the operator
page would import it too.

## 4. Swish payload

### Format

```
C<payee>;<amount>;<message>;<flags>
```

Example: `C0701234567;249.00;Kaffebaren #47;0`

- **payee** — 10 digits. Normalize by stripping spaces, dashes and a leading `+`;
  convert a leading `46` (11 digits total) to `0`. Valid forms after
  normalization: 10 digits beginning `07` (private) or `123` (merchant).
- **amount** — kronor with a `.` decimal separator, always two decimals.
- **message** — the note. See sanitizing below.
- **flags** — bitmask of editable fields: `1` payee, `2` amount, `4` message.
  We send **`0`**, locking all three.

### Message sanitizing

Applied in `swish.js`, in this order:

1. Remove `;` — it is the field separator, and an unescaped one in a store name
   like `Kalle; Bagare` silently corrupts the amount field.
2. Remove control characters and newlines; collapse runs of whitespace.
3. Truncate to `MESSAGE_MAX_CHARS`, counted by **Unicode code point** — not
   UTF-16 code units and not bytes, so `å ä ö` count as one character each.

`MESSAGE_MAX_CHARS` is a single named constant, default **50**. See the gate
below: this number is *not* verified for the QR payload. A shorter note is always
safe, so 50 is a conservative default and the constant exists so that raising or
lowering it after verification is a one-line change.

### Provenance and the verification gate

This payload format is documented by the community
(<https://github.com/lindskogen/swish-qr-format>), not published by Getswish. The
official rendering endpoint is
`POST https://mpc.getswish.net/qrg-swish/api/v1/prefilled`, which we do not use
because it requires a round trip we can avoid.

Automated tests can only prove we emit the string we intended. They cannot prove
Swish accepts it. **Before any real payment is taken**, a generated QR must be
scanned with a real Swish app and checked for correct payee, correct amount,
correct note, and all three fields locked against editing.

Three specifics to settle during that check, each currently an assumption:

| Assumption | Status |
|---|---|
| Payee accepted as `07…` (rather than requiring `46…`) | Unverified — community example uses `07…` |
| Whole amounts may be sent as `249.00` (rather than `249`) | Unverified — community example uses an integer |
| Message limit is 50 characters | **Unverified.** The community documentation states length is undocumented. 50 is carried over from the Swish *merchant API*, which is a different surface. |

This table goes in the README as a release checklist. Until every row is
confirmed against a real Swish app, the app must not be used to take money.

## 5. Data model (Deno KV)

```
["room", roomId]                          → { createdAt, operatorTokenHash, displayTokenHashes[] }
["room", roomId, "settings"]              → { storeName, payeeNumber }
["room", roomId, "products"]              → [{ id, name, priceOre, sortOrder }]
["room", roomId, "current"]               → RoomState        (section 6)
["room", roomId, "counter", "2026-09-13"] → n
["charge", roomId, chargeId]              → the original charge response, expireIn 120s
["presence", roomId, displayId]           → 1, expireIn 30s
["pair", code]                            → { roomId }, expireIn 5 minutes
["ratelimit", scope, ipHash, minute]      → n, expireIn 120s
```

- Prices are **integer öre** everywhere. `priceOre: 1990` is 19,90 kr. Floating
  point never touches a price or a total.
- Around 20 products fit comfortably in a single KV value, well inside the 64 KB
  limit. Stored as one array to keep edits atomic. Product `id` is a
  client-generated UUID and is never reused, so a deleted-and-recreated product
  cannot be confused with its predecessor by an in-flight basket.
- `current` stores the payload string, **not** the rendered SVG. QR rendering is
  deterministic, so any isolate re-renders identical output on demand. This keeps
  KV values and `BroadcastChannel` messages small.
- Tokens are stored as SHA-256 hashes so a leaked KV dump does not confer the
  ability to push a QR to someone's display.
- The counter key uses the **Europe/Stockholm** date. UTC rolls over at 01:00 or
  02:00 local time, which would reset order numbers to #1 mid-evening during a
  late market.

## 6. Room state and the SSE contract

There is **one** event type pushed to devices, carrying the room's complete
current state:

```js
// RoomState
{ state: "idle" }
{ state: "charge", orderNo, totalOre, message, payload, updatedAt }
```

The server renders `payload` to SVG and sends `{ ...roomState, svg }` as a
`state` event. The display replaces its screen with whatever the latest `state`
event describes and holds no history.

**On every SSE connect — including automatic reconnects — the server immediately
sends the current state as the first event, read from KV.** This is the
load-bearing detail of the whole sync design. SSE was chosen because browsers
reconnect for free, but a push-only server would deliver nothing on reconnect,
leaving a blank welcome screen in front of a customer who is mid-scan. Replaying
current state on connect makes a dropped stream invisible rather than fatal.

Because every event carries complete state rather than a delta, redelivery and
out-of-order arrival are both harmless. `updatedAt` lets a client discard an
event older than the one it is already showing.

A second event type, `presence`, goes to the operator only: `{ displays: n }`.

A comment heartbeat every 15 seconds keeps intermediate proxies from closing idle
streams, and doubles as the presence refresh tick.

## 7. API

All authenticated routes take `Authorization: Bearer <token>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/rooms` | none | Create a room. Returns `{ roomId, operatorToken }`. Rate limited. |
| GET | `/api/state` | operator | Returns `{ settings, products }`. |
| PUT | `/api/settings` | operator | Body `{ storeName, payeeNumber }`. Validates the payee. |
| PUT | `/api/products` | operator | Body: the full product array. Replaces atomically. |
| POST | `/api/pair` | operator | Issues a single-use 6-digit code, valid 5 minutes. Returns `{ code, pairUrl, pairQrSvg }`: `pairUrl` is `/display.html?code=<code>`, and scanning its QR pairs the display with no typing. |
| POST | `/api/pair/claim` | none | Body `{ code }`. Returns `{ roomId, displayToken }`. Rate limited. |
| POST | `/api/stream-ticket` | either | Returns `{ ticket }`, single-use, valid 30 seconds, carries the caller's role. |
| GET | `/api/events?ticket=…` | ticket | SSE stream. |
| POST | `/api/charge` | operator | Body `{ chargeId, items: [{ id, qty }], expectedTotalOre }`. |
| POST | `/api/idle` | operator | Sets room state to idle. Optional body `{ paid: true }` (the operator's Klar) adds `thanks: true` to the live event only, never to the stored state, so the display shows "Tack!" briefly and a replay cannot repeat it. |

`EventSource` cannot set request headers, which would force the token into the
query string where proxy and server logs capture it. The single-use 30-second
`stream-ticket` exists to avoid that: the long-lived token is exchanged over a
normal POST, and only the short-lived ticket appears in a URL. The ticket records
which role issued it, so the server knows whether to send `presence` events.

### POST /api/charge

Validated in this order, each a hard stop:

| Condition | Response |
|---|---|
| Settings missing a store name or payee number | 409 `{ error: "not_configured" }` |
| `items` empty | 400 `{ error: "empty_basket" }` |
| Any `id` not in the stored product list | 400 `{ error: "unknown_product", id }` |
| Any `qty` not a positive integer | 400 `{ error: "bad_quantity", id }` |
| Recomputed total below `MIN_CHARGE_ORE` (100) | 400 `{ error: "amount_too_low" }` |
| Recomputed total above `MAX_CHARGE_ORE` (2 000 000) | 400 `{ error: "amount_too_high" }` |
| Recomputed total ≠ `expectedTotalOre` | 409 `{ error: "stale_total", totalOre }` |

An unknown product id is rejected rather than skipped: dropping a line item would
undercharge silently. `MAX_CHARGE_ORE` (20 000 kr) is a fat-finger guard, not a
Swish limit — actual Swish ceilings are set per user by their bank and are not
knowable here.

The stale-total check keeps the server authoritative over money and costs almost
nothing, but note its scope honestly: with a single operator on a single device
it can only fire if the app is open in two places at once. It guards against
client-side arithmetic drift more than against a realistic price race. The 409
carries only the corrected total; the operator re-fetches `/api/state` itself.

**Idempotency.** `chargeId` is a client-generated UUID. The server claims
`["charge", roomId, chargeId]` with an atomic `check({ versionstamp: null })`. If
the claim fails, the charge is a retry: the server returns the **stored original
response** rather than issuing a new order number. Storing the response, not just
a marker, is what makes the retry safe — a bare marker would either error or mint
a second order number, which is the exact outcome the dedupe exists to prevent.
Records expire after 120 seconds.

On success it increments the daily counter atomically, builds the note
`<storeName> #<n>`, assembles the payload, writes `current` to KV, publishes over
`BroadcastChannel`, fans out locally, and returns `{ orderNo, totalOre, payload,
svg }` so the same QR appears on the operator's own screen.

**Cancelling a charge does not release its order number.** Sequences will have
gaps. This is accepted: decrementing the counter would race the atomic increment,
and a gap costs nothing.

### Rate limiting

`POST /api/rooms` and `POST /api/pair/claim` are limited per hashed client IP per
minute, counted in KV with `expireIn`. An in-memory counter would reset on every
isolate cycle and vary per region, which is to say it would not limit anything.
Pair-claim limiting also blunts brute-forcing a 6-digit code.

## 8. QR rendering

Rendered by `qr.js` from the payload string.

- **Error correction level Q** (25%). The payload is roughly 35–60 characters, so
  even at Q the symbol stays at a low version with large modules — the higher
  level is free here.
- **Quiet zone of 4 modules**, included inside the SVG's `viewBox`. QR codes
  drawn flush to a screen edge frequently fail to scan.
- **Opaque white background rectangle, always.** Not transparent. A transparent
  QR inheriting a dark page background is unscannable, and this is exactly the
  kind of thing that works in testing and fails outdoors.
- Emitted as one `<path>` of dark modules over that rectangle, with
  `shape-rendering="crispEdges"` and a `viewBox` in module units so it scales to
  any screen without resampling artifacts.

**Screen brightness has no web API.** The display page cannot raise it in code.
What it can do is render the QR on a full-bleed white background, which maximises
emitted light on both LCD and OLED. Setting the display phone to maximum
brightness with auto-brightness disabled is therefore a documented setup step in
the README, not something the app can do for the user.

## 9. Flows

**First run.** The operator page finds no room in `localStorage`, creates one, and
stores `roomId` and `operatorToken`. A setup screen collects store name and Swish
number, then presents an empty product grid.

**Pairing the display.** The operator taps "Pair display" and a 6-digit code
appears for 5 minutes. The old phone opens `/display.html`, enters the code once, and
receives its own `displayToken`. It reconnects unattended on every subsequent
load. Setup instructions cover adding it to the phone's home screen so it opens
fullscreen.

**A sale.** Tap a product to add it; tap again to increment; a `−` control
decrements. The running total updates locally via the shared money module. Buy is
disabled while the basket is empty, while a request is in flight, and while
settings are incomplete. Pressing **Buy** proceeds as described under
`/api/charge`.

**Ending a sale.** **Done** or **Cancel** sets room state to idle, returning the
display to a neutral welcome screen and clearing the basket. Neither records
anything: see "What this app cannot do".

## 10. Screens

**Operator** — product grid, basket with quantities and running total, Buy
button, a connection dot showing display presence, and a settings screen for
store name, Swish number and product editing.

**Display** — a welcome state, and a charge state showing the amount large, the
store name and order number, and the QR on white filling most of the screen.
Nothing else. It must be legible at arm's length across a market table.

### Keeping the display awake

The display page requests a Screen Wake Lock, with two details that decide
whether it actually works:

- It must be acquired **from a user gesture**, so it is taken on the tap that
  claims the pairing code and re-taken on any tap on the display page.
- It is **automatically released whenever the page is hidden**, so it must be
  re-acquired on `visibilitychange` when the page becomes visible again.

Written without those, a wake lock appears to work and then silently stops the
first time the phone is backgrounded. Older Safari lacks the API entirely, which
is why the manual screen-timeout setting stays in the README regardless.

## 11. Failure modes

The governing principle: **the old phone is an accessory, not a dependency.**
Nothing about completing a sale may require it to be alive.

| Condition | Behaviour |
|---|---|
| Display asleep, disconnected, or dead | Operator sees a red "display offline" dot. Buy still works and renders the QR fullscreen on the operator's own phone, to be turned toward the customer. |
| Display stream drops mid-charge | Browser reconnects on its own; the server replays current state as the first event, so the QR reappears. Section 6. |
| Operator's POST and display's stream on different isolates | Normal case, not an error. Handled by `BroadcastChannel`. Section 3. |
| Double-tap on Buy | Button disables while in flight; server returns the stored original response for a repeated `chargeId`. |
| Stale product list on operator | 409 with the corrected total; the operator refetches state. |
| Pair code expired, mistyped, or brute-forced | Explicit message and one-tap regenerate. Codes are single-use; claims are rate limited. |
| KV write fails during a product edit | The edit reports failure and stays on screen. It never displays a saved state it did not achieve. |
| Display screen times out | Wake lock per section 10, plus the documented manual setting. |
| Store name contains `;` or overruns the note limit | Sanitized and truncated per section 4. |
| Empty basket, unset payee, absurd total | Rejected before any payload is built. Section 7. |
| No network at Buy | v1 surfaces a clear error and cannot produce a QR. See section 13. |

## 12. Security

The threat that matters is not data theft but payment redirection: anyone able to
push to a display could show their own Swish QR and take the stall's money
silently, in a way neither operator nor customer would notice.

- Subscribing and pushing use separate tokens. A display token cannot charge.
- Tokens are random, high-entropy, and stored hashed.
- Pair codes are single-use, expire in 5 minutes, and claims are rate limited, so
  a 6-digit code is neither guessable in bulk nor reusable once claimed.
- Long-lived tokens never appear in a URL (section 7).
- Room creation and pair claims are rate limited in KV, per hashed IP.

## 13. Phase 2 — offline fallback

Deferred, not cancelled. If signal proves unreliable where the stall operates,
the operator page can build the payload locally using the same shared
`swish.js`, render the QR with a bundled encoder, and draw from a locally
persisted order counter. It is a genuinely separate code path with its own
reconciliation problem (local order numbers colliding with server-issued ones),
which is why it is not smuggled into v1. The decision should follow real
observation of signal quality rather than precede it.

## 14. Testing

Test-driven, using Deno's built-in test runner.

| File | Covers |
|---|---|
| `money_test.js` | öre arithmetic, SEK formatting, totals with quantities, absence of float drift |
| `swish_test.js` | Exact payload bytes; `07…`/`+46…`/`46…` normalization; merchant numbers; semicolon injection; code-point truncation over `å ä ö`; flag value |
| `qr_test.js` | **Decode round-trip** (below), quiet zone width, opaque background, SVG path matches the encoder's matrix |
| `store_test.js` | KV CRUD; atomic counter increment under concurrency; Stockholm-date key selection across a UTC rollover; idempotency claim and stored-response replay; rate-limit windows |
| `tokens_test.js` | Token length, URL-safety and uniqueness; six-digit pair codes over the whole range incl. leading zeros; SHA-256 hashing; constant-time compare |
| `hub_test.js` | Replay-on-subscribe from KV, local fan-out (a channel never echoes to its poster), rendered `svg` and `amountText` on charge events, room isolation, unsubscribe, a throwing subscriber not stopping others |
| `sse_test.js` | Stream tickets: first event is current state, single-use, a published charge reaches an open stream, a failing presence call unwinds the stream and hub subscription, and end to end: create room → pair → charge → display stream receives it |
| `server_test.js` | Integration: every rejection row in section 7; repeated `chargeId` yields the identical response and one order number |
| `charge_test.js` | `POST /api/charge` and `/api/idle`: order numbers, idempotent `chargeId`, every rejection row, stale total, amount limits, note truncation that preserves the order number, semicolon injection, malformed items |

`tests/helpers.js` is the shared `withServer` test harness (a handler over a temporary KV, without binding a port). It is not a test file: importing a `*_test.js` module would re-register its tests in the importer.

**The QR test decodes, it does not snapshot.** A snapshot of SVG markup proves
only that the renderer did not change; it says nothing about whether the code
scans, and it breaks on cosmetic edits. Instead `qr_test.js` builds an RGBA pixel
buffer directly from the module matrix at 8 pixels per module and runs it through
`npm:jsqr`, asserting the decoded string equals the payload exactly. No SVG
rasterization is needed, and the test fails for real encoder bugs rather than for
whitespace. `jsqr` is a test-only dependency.

`swish_test.js`, `money_test.js` and the `qr_test.js` round-trip carry the most
weight: they guard the things that cost real money when wrong.

Cross-isolate behaviour cannot be reproduced locally, where everything shares one
process. `hub_test.js` and `sse_test.js` therefore assert the *mechanism* — that publishing
posts to the channel and fans out locally, and that connecting replays state from
KV — rather than the topology. Deployed behaviour is confirmed by the manual
check below.

The manual Swish-app verification in section 4 is a required gate that no
automated test replaces. A second manual check after first deploy: open the
display on one device and the operator on another, confirm a charge arrives, then
kill and restore the display's connection mid-charge and confirm the QR returns.

## 15. File layout

```
deno.json
README.md            # includes the section 4 verification checklist and phone setup
src/
  tokens.js          # random tokens, SHA-256 hashing, constant-time compare
  store.js           # every Deno KV read and write, incl. pairing and presence
  hub.js             # SSE subscriber registry + BroadcastChannel fan-out
  qr.js              # payload → module matrix → SVG (npm:qrcode-generator, pinned)
  server.js          # routes
main.js              # entry point
public/
  shared/money.js    # öre arithmetic, SEK formatting          — browser + server
  shared/swish.js    # payload assembly, sanitizing, validation — server only in v1
  index.html
  app.js
  style.css
  display.html
  display.js
tests/
  helpers.js         # shared withServer harness; not a test file
  money_test.js  swish_test.js  qr_test.js  tokens_test.js
  store_test.js  hub_test.js  server_test.js  sse_test.js  charge_test.js
docs/superpowers/specs/
  2026-09-13-swish-calculator-design.md
```

*`rooms.js` was split into `tokens.js`, `store.js` and `hub.js` during implementation: four responsibilities in one file was too many. The QR encoder is a pinned npm specifier rather than a vendored file.*

# Swish Calculator — Design

Date: 2026-09-13
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
multiple simultaneous operators; offline operation (see section 12).

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
Operator phone  ──POST /api/charge──▶  Deno app  ──SSE event──▶  Display phone
   (user's phone)                     ├─ Deno KV (products, settings, tokens, counter)
                                      └─ in-memory Map of live SSE streams, keyed by room
```

Two rules govern the split:

- **The server is the sole author of payment data.** Clients never construct a
  Swish payload or render a QR. There is exactly one implementation to test and
  one place a bug can live.
- **The display is deliberately dumb.** It receives a rendered SVG and text and
  draws them. It runs no payment logic and needs no modern browser features.

Money logic lives in `src/shared/money.js`, a plain JavaScript module carrying
JSDoc types. Deno imports it directly for tests; the browser imports the
identical file over HTTP. The operator page needs a live running total while
tapping and the server needs the authoritative total at Buy — sharing one module
means those two numbers cannot drift apart.

`src/shared/swish.js` sits in the same directory and is written to the same
browser-compatible constraints, but in v1 it is **imported only by the server**,
per the rule above. It lives under `shared/` because Phase 2 (section 12) is the
point at which the operator page would import it too; keeping it portable now
costs nothing and avoids a rewrite then.

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
3. Truncate to **50 characters counted by Unicode code point**, not UTF-16 code
   units and not bytes, so `å ä ö` are counted the way Swish counts them.

### Provenance and the verification gate

This payload format is documented by the community
(<https://github.com/lindskogen/swish-qr-format>), not published by Getswish. The
official rendering endpoint is
`POST https://mpc.getswish.net/qrg-swish/api/v1/prefilled`, which we do not use
because it requires a round trip we can avoid.

Automated tests can only prove we emit the string we intended. They cannot prove
Swish accepts it. **Before any real payment is taken**, a generated QR must be
scanned with a real Swish app and checked for: correct payee, correct amount,
correct note, and all three fields locked against editing. Two details to confirm
specifically during that check, because the community documentation is silent on
them: whether the payee is preferred in `07…` or `46…` form, and whether whole
amounts must be `249` rather than `249.00`. This step goes in the README as a
release checklist item.

## 5. Data model (Deno KV)

```
["room", roomId]                          → { createdAt, operatorTokenHash, displayTokenHashes[] }
["room", roomId, "settings"]              → { storeName, payeeNumber }
["room", roomId, "products"]              → [{ id, name, priceOre, sortOrder }]
["room", roomId, "counter", "2026-09-13"] → n
["pair", code]                            → { roomId }        // KV expireIn 5 minutes
```

- Prices are **integer öre** everywhere. `priceOre: 1990` is 19,90 kr. Floating
  point never touches a price or a total.
- Around 20 products fit comfortably in a single KV value, well inside the 64 KB
  limit. Stored as one array to keep edits atomic. Product `id` is a
  client-generated UUID and is never reused, so a deleted-and-recreated product
  cannot be confused with its predecessor by an in-flight basket.
- Tokens are stored as SHA-256 hashes so a leaked KV dump does not confer the
  ability to push a QR to someone's display.
- The counter key uses the **Europe/Stockholm** date. UTC rolls over at 01:00 or
  02:00 local time, which would reset order numbers to #1 mid-evening during a
  late market.

## 6. API

All authenticated routes take `Authorization: Bearer <token>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/rooms` | none | Create a room. Returns `{ roomId, operatorToken }`. Rate limited. |
| GET | `/api/state` | operator | Returns `{ settings, products }`. |
| PUT | `/api/settings` | operator | Body `{ storeName, payeeNumber }`. Validates the payee. |
| PUT | `/api/products` | operator | Body: the full product array. Replaces atomically. |
| POST | `/api/pair` | operator | Issues a single-use 6-digit code, valid 5 minutes. |
| POST | `/api/pair/claim` | none | Body `{ code }`. Returns `{ roomId, displayToken }`. |
| POST | `/api/stream-ticket` | either | Returns `{ ticket }`, single-use, valid 30 seconds. |
| GET | `/api/events?ticket=…` | ticket | SSE stream. |
| POST | `/api/charge` | operator | Body `{ chargeId, items: [{ id, qty }], expectedTotalOre }`. |
| POST | `/api/idle` | operator | Returns the display to its welcome screen. |

`EventSource` cannot set request headers, which would force the token into the
query string where it can be captured by proxy and server logs. The single-use
30-second `stream-ticket` exists to avoid that: the long-lived token is exchanged
over a normal POST, and only the short-lived ticket appears in a URL.

### POST /api/charge

The server recomputes the total from its own stored prices. On disagreement with
`expectedTotalOre` it returns **409** with body
`{ error: "stale_total", totalOre, products }`, and the operator UI refreshes its
product list from that response and says "prices changed — check the total and
tap Buy again". It does not silently charge either figure. This catches the real
case where a price was edited on one device while another held a stale product
list.

An unknown product `id` in `items` is a **400**, not a silent skip: dropping a
line item would undercharge without anyone noticing.

On success it increments the daily counter atomically, builds the note
`<storeName> #<n>`, assembles the payload, renders the QR to SVG, emits a
`charge` event to the room, and returns `{ orderNo, totalOre, payload, svg }` to
the operator so the same QR appears on both screens.

`chargeId` is generated by the client and deduped by the server within a short
window, so a double-tap cannot consume two order numbers.

### SSE events

| Event | To | Payload |
|---|---|---|
| `charge` | display + operator | `{ orderNo, totalOre, message, svg }` |
| `idle` | display + operator | `{}` |
| `presence` | operator only | `{ displays: n }` |

A comment heartbeat every 20 seconds keeps intermediate proxies from closing idle
streams.

## 7. Flows

**First run.** The operator page finds no room in `localStorage`, creates one, and
stores `roomId` and `operatorToken`. A setup screen collects store name and Swish
number, then presents an empty product grid.

**Pairing the display.** The operator taps "Pair display" and a 6-digit code
appears for 5 minutes. The old phone opens `/display`, enters the code once, and
receives its own `displayToken`. It reconnects unattended on every subsequent
load. Setup instructions cover adding it to the phone's home screen so it opens
fullscreen.

**A sale.** Tap a product to add it; tap again to increment; a `−` control
decrements. The running total updates locally via the shared money module. **Buy**
posts the basket and proceeds as described under `/api/charge`.

**Ending a sale.** **Done** or **Cancel** emits `idle`, returning the display to a
neutral welcome screen and clearing the basket. Neither records anything: see
"What this app cannot do".

## 8. Screens

**Operator** — product grid, basket with quantities and running total, Buy
button, a connection dot showing display presence, and a settings screen for
store name, Swish number and product editing.

**Display** — a welcome state, and a charge state showing the amount large, the
store name and order number, and the QR filling most of the screen. Nothing else.
It must be legible at arm's length across a market table.

## 9. Failure modes

The governing principle: **the old phone is an accessory, not a dependency.**
Nothing about completing a sale may require it to be alive.

| Condition | Behaviour |
|---|---|
| Display asleep, disconnected, or dead | Operator sees a red "display offline" dot. Buy still works and renders the QR fullscreen on the operator's own phone, to be turned toward the customer. |
| Double-tap on Buy | Button disables while in flight; server dedupes on `chargeId`. |
| Stale product list on operator | 409 with the correct total (section 6). |
| Pair code expired or mistyped | Explicit message and a one-tap regenerate. Codes are single-use. |
| KV write fails during a product edit | The edit reports failure and stays on screen. It never displays a saved state it did not achieve. |
| Display screen times out | The display page takes a Screen Wake Lock where available. Older Safari lacks it, so setup instructions direct the user to set that phone's screen timeout to Never. A documented step beats a silent black screen. |
| Store name contains `;` or exceeds the note limit | Sanitized and truncated per section 4. |
| No network at Buy | v1 surfaces a clear error and cannot produce a QR. See section 12. |

## 10. Security

The threat that matters is not data theft but payment redirection: anyone able to
push to a display could show their own Swish QR and take the stall's money
silently, in a way neither operator nor customer would notice.

- Subscribing and pushing use separate tokens. A display token cannot charge.
- Tokens are random, high-entropy, and stored hashed.
- Pair codes are single-use and expire in 5 minutes, so a shoulder-surfed code is
  worth nothing after the display claims it.
- Long-lived tokens never appear in a URL (section 6).
- `POST /api/rooms` is rate limited to prevent trivial KV exhaustion.

## 11. Testing

Test-driven, using Deno's built-in test runner. No test dependencies.

| File | Covers |
|---|---|
| `money_test.js` | öre arithmetic, SEK formatting, totals with quantities, absence of float drift |
| `swish_test.js` | Exact payload bytes; `07…`/`+46…`/`46…` normalization; merchant numbers; semicolon injection; code-point truncation over `å ä ö`; flag value |
| `qr_test.js` | Payload to SVG: structural assertions plus a stable snapshot |
| `store_test.js` | KV product CRUD; atomic counter increment under concurrency; Stockholm-date key selection across a UTC rollover |
| `rooms_test.js` | Pairing handshake, code expiry and single use, token rejection, SSE fan-out to multiple displays |
| `server_test.js` | Integration: create room → pair → charge → display stream receives it; 401 on bad token; 409 on stale total; `chargeId` dedupe |

`swish_test.js` and `money_test.js` carry the most weight: they guard the two
things that cost real money when wrong.

The manual Swish-app verification in section 4 is a required gate that no
automated test replaces.

## 12. Phase 2 — offline fallback

Deferred, not cancelled. If signal proves unreliable where the stall operates,
the operator page can build the payload locally using the same shared
`swish.js`, render the QR with a bundled encoder, and draw from a locally
persisted order counter. It is a genuinely separate code path with its own
reconciliation problem (local order numbers colliding with server-issued ones),
which is why it is not smuggled into v1. The decision should follow real
observation of signal quality rather than precede it.

## 13. File layout

```
deno.json
README.md
src/
  shared/money.js     # öre arithmetic, SEK formatting          — browser + server
  shared/swish.js     # payload assembly, sanitizing, validation — server only in v1
  qr.js               # payload → SVG
  vendor/qrcode.js    # vendored MIT encoder, pinned
  store.js            # Deno KV access
  rooms.js            # pairing, tokens, SSE fan-out
  server.js           # routes
public/
  index.html
  app.js
  style.css
  display.html
  display.js
tests/
  money_test.js  swish_test.js  qr_test.js
  store_test.js  rooms_test.js  server_test.js
docs/superpowers/specs/
  2026-09-13-swish-calculator-design.md
```

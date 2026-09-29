# Swish-kassa

A two-device point-of-sale for a market stall. The operator taps products into a basket on
their phone; an old spare phone facing the customer shows a Swish QR code for the exact
total.

Design: `docs/superpowers/specs/2026-09-13-swish-calculator-design.md`

## Run locally

```bash
deno task dev     # http://localhost:8000
deno task test
```

## Deploy

Deno Deploy, entry point `main.js`. Deno KV needs no configuration.

## ⚠️ Before taking real money

**The QR payload format is community-documented, not published by Getswish.** The test
suite proves the app emits the string it intended to emit. It cannot prove Swish accepts
it. Scan a generated code with a real Swish app and confirm every row below before your
first real sale.

- [ ] The Swish app opens with the **correct payee**
- [ ] The **amount** is correct
- [ ] The **note** reads `<store name> #<order number>`
- [ ] Payee, amount and note are all **locked** against editing
- [ ] Payee is accepted in `07…` form (if not, switch `normalizePayee` to emit `46…`)
- [ ] A whole amount is accepted as `249.00` (if not, emit `249`)
- [ ] A 50-character note is accepted (if not, lower `MESSAGE_MAX_CHARS` in
      `public/shared/swish.js`)

Also confirm once after the first deploy, with the two devices on different networks: make
a charge, then kill and restore the display's connection mid-charge and check that the QR
comes back on its own.

## Where your room lives

The room (store name, Swish number, products and the display pairing) is stored in the
**operator phone's browser storage**, and nowhere you can log back into. If that storage
is lost (a new phone, cleared browser data, or iOS deleting a site's data after 7 days
without a visit), the room is lost with it and **cannot be recovered**. The operator page
then starts a fresh, empty room.

- **Add the operator page to the home screen.** It is harder to clear by accident, and on
  iOS it makes the 7-day storage eviction much less likely.
- **After a lost room, re-pair the display.** Enter settings and products again, then open
  `/display.html?pair` on the display phone (or tap the small "Koppla om" link on its
  welcome screen) and enter a new code from "Koppla display".

## Setting up the display phone

1. Open `/display.html`, enter the 6-digit code from the operator's "Koppla display"
   button. You only do this once.
2. Add the page to the home screen so it opens fullscreen.
3. **Set the screen timeout to Never** and **turn off auto-brightness, with brightness at
   maximum.** The page requests a wake lock where the browser supports one, but older
   Safari has no such API, and no web page can set screen brightness at all. A dim screen
   outdoors is the most common reason a QR will not scan.

## What this app does not do

It cannot tell whether a payment arrived. Swish provides no callback for a private payee
number. **"Klar" means you saw the money land in your own Swish app** — it is never a
confirmation from the system.

A private Swish number is what this is built for, per the design. Swish's own terms
reserve commercial use for a merchant number (`123…`); the app accepts either, so
switching later is a settings change.

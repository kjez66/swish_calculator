# Swish-kassa

A two-device point-of-sale for a market stall or a club kiosk. The operator taps products
into a basket on their phone; an old spare phone facing the customer shows a Swish QR code
for the exact total. The customer scans it, and their Swish app opens with the payee, the
amount and a note (`<store name> #<order number>`) already filled in.

**Live:** https://swish-kassa.kjez.workers.dev (operator) and
https://swish-kassa.kjez.workers.dev/display (customer display), on Cloudflare's free
plan.

Design: `docs/superpowers/specs/2026-09-13-swish-calculator-design.md` (the app), with
`docs/superpowers/specs/2026-10-11-cloudflare-workers-design.md` (hosting and live
updates, which replace that document's Deno sections).

## Features

- **Products** with name and price, in an order you choose. Each product has an **Aktiv**
  switch: switched off, it disappears from the till but keeps its name, price and place,
  for when something runs out.
- **Categories.** Each product can be Dryck, Mat, Fika, Godis or Övrigt, chosen in the
  product settings. The till tints a product's tile in its category's colour; a
  product with no category keeps a plain tile. The default menu comes with categories.
- **Default menu.** A new kassa starts with the HK Halmstad P13 kiosk menu (Loka, Capri
  Sun, Läsk, Kaffe, Hembakat, Delicatoboll, Korv med bröd, Wasa Knäcke, Corny, Chips,
  Kexchoklad), so it can sell right away. Change the list in `DEFAULT_PRODUCTS` in
  `src/defaults.js`. It only applies to kassor created afterwards.
- **Basket and running total**, with + and − per line, and a trash button that empties
  the whole basket (after asking) when a customer changes their mind.
- **Swish QR** on the paired customer display, and on the operator phone as a fallback
  when no display is paired.
- **Sales log** (the chart button in the header): per day, the number of sales, the
  total, the quantity and sum per product, and every sale with its time and contents.
  A sale is saved when the operator presses **Klar**. **Avbryt** saves nothing. A sale
  saved by mistake can be removed. **Sales are kept for 31 days**, then deleted
  automatically. The date list offers only the days with sales, newest first.
  **Ladda ner PDF** saves the day's totals and per-product table as a one-page A4
  report to hand in. Product names print in Helvetica, so a character it lacks (an
  emoji, say) prints as "?".
- **Installable as apps:** the till ("Kassa") and the customer display ("Display",
  fullscreen) each install on a phone's home screen with their own icon. See
  [Installing on the phones](#installing-on-the-phones).

## Installing on the phones

- **Android (Chrome):** open the page, then the menu (⋮) → **Installera app** (or accept
  the prompt). The app shares the browser's storage, so a kassa or pairing made in Chrome
  carries over.
- **iPhone (Safari):** open the page, then Dela (□↑) → **Lägg till på hemskärmen**.
  **An iPhone home-screen app has its own storage, separate from Safari.** So install
  first and set up inside the app:
  - Operator: the installed app starts a new kassa. A kassa made in Safari stays there
    with its sales log, and is not lost, but the app cannot see it.
  - Display: the app opens on "Koppla displayn"; type the 6-digit code shown in the
    kassa and press Koppla. Scanning the pairing QR opens Safari, not the app.

The app always loads the latest version when online (see `public/sw.js`), so a new
deploy reaches the phones at once; offline it only keeps the pages, never the data.

## Using it

1. **Settings** (the gear): store name (shown in the Swish note), Swish number, and the
   products. ↑ ↓ change the order, ✕ removes a product, **Aktiv** shows or hides it in the
   till. A price takes digits and one decimal comma, e.g. `19,90`.
2. **Selling:** tap products into the basket, press **Ta betalt**. The QR appears on the
   customer display.
3. **Check your own Swish app** that the money arrived, then press **Klar**. The display
   thanks the customer and the sale goes into the sales log. **Avbryt** closes the charge
   and keeps the basket, for "wait, add a bun".
4. **After the match:** open the sales log and compare the total with your Swish app.

## Run locally

Requires Node.js 22 or later.

```bash
npm install
npm run dev       # http://localhost:8787, the real Workers runtime
npm test          # every test, inside the Workers runtime
npm run check     # lint and formatting (Biome); npm run format fixes formatting
```

`package.json` already allows `workerd`'s install script (npm 11 blocks install
scripts by default). After upgrading Wrangler, allow the new version with
`npm approve-scripts workerd`.

`npm run dev` listens on all interfaces, so phones on the same Wi-Fi can open
`http://<this computer's IP>:8787/`. Local data lives in `.wrangler/state/`;
deleting that folder deletes every local kassa.

**On Windows PowerShell**, `npm` and `npx` may be blocked ("running scripts is disabled
on this system"). Use `npm.cmd` and `npx.cmd` instead, e.g. `npm.cmd run dev`; they do
the same without changing the execution policy.

## Hosting on Cloudflare (free)

Runs on the Workers Free plan: a Worker plus SQLite-backed Durable Objects, one
per kassa. Design and limits: `docs/superpowers/specs/2026-10-11-cloudflare-workers-design.md`.

Run these in an ordinary terminal window: logging in waits for you in the browser and
the first deploy asks questions, so they cannot run from a non-interactive shell.

1. Create a free account at [dash.cloudflare.com](https://dash.cloudflare.com).
2. `npx wrangler login`: the browser opens Cloudflare; click **Allow**. You stay logged
   in on this computer.
3. `npm run deploy`. The first deploy asks you to register a `workers.dev` subdomain
   (this account's is `kjez`). The kassa is then at
   `https://swish-kassa.<subdomain>.workers.dev`.
4. Optional: a custom domain under the Worker's *Settings → Domains & Routes* in
   the Cloudflare dashboard.
5. Run the checks in [Before taking real money](#️-before-taking-real-money).

**After a change:** run the tests, then `npm run deploy` (`npm.cmd run deploy` in
PowerShell). Installed apps pick up the new version the next time they load.

Free-plan headroom for one kassa: 100,000 requests a day. A device left connected all
day sends a heartbeat every 15 s (about 5,800 a day), and the Durable Object sleeps
between events, so it uses almost none of its daily duration. Usage is under *Workers &
Pages → swish-kassa → Metrics* in the dashboard.

## Self-hosting

The same code runs on Cloudflare's open-source runtime, `workerd`, so the app is
not tied to Cloudflare's hosting. That setup is not documented here yet.

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

## Where your kassa lives

The kassa (its settings, products, sales log and display pairing) lives on the server,
but the key to it is stored only in the **operator phone's browser storage**, and there is
no login to get it back. If that storage is lost (a new phone, cleared browser data, or
iOS deleting a site's data after 7 days without a visit), the kassa is lost with it and
**cannot be recovered**, sales log included. The operator page then starts a fresh kassa
with the default products.

- **Install the operator page as an app** ([how](#installing-on-the-phones)). It is
  harder to clear by accident, and on iOS it makes the 7-day storage eviction much less
  likely.
- **After a lost kassa, re-pair the display.** Enter the store name and Swish number
  again, then tap the status button in the operator's header and scan the pairing QR with
  the display phone's camera. That replaces the old pairing by itself. If the camera
  cannot open the QR, open `/display.html?pair` on the display phone instead and type the
  code.

## Setting up the display phone

1. On the operator phone, tap the status button in the header ("Ingen display"). Scan the
   pairing QR it shows with the display phone's camera: the display page opens and pairs
   itself. (Or open `/display.html` and type the 6-digit code shown under the QR.) You
   only do this once. If the display then asks for one tap, give it: that tap is what lets
   the browser keep the screen on.
2. Install it as the "Display" app so it opens fullscreen
   ([how](#installing-on-the-phones)). On an iPhone, install first and pair inside the
   app by typing the code.
3. **Set the screen timeout to Never** and **turn off auto-brightness, with brightness at
   maximum.** The page requests a wake lock where the browser supports one, but older
   Safari has no such API, and no web page can set screen brightness at all. A dim screen
   outdoors is the most common reason a QR will not scan.

## What this app does not do

It cannot tell whether a payment arrived. Swish provides no callback for a private payee
number. **"Klar" means you saw the money land in your own Swish app** — it is never a
confirmation from the system. The sales log therefore lists what was marked as paid, not
what Swish confirmed: reconcile it against your Swish app.

A private Swish number is what this is built for, per the design. Swish's own terms
reserve commercial use for a merchant number (`123…`); the app accepts either, so
switching later is a settings change.

## Project layout

| Path | What |
|---|---|
| `wrangler.jsonc` | Cloudflare config: entry, static files, Durable Objects |
| `src/worker.js` | Entry: routes `/api/*` to the Durable Objects |
| `src/kassa.js` | One kassa: settings, products, charges, sales log, live WebSockets |
| `src/directory.js` | Pair codes and rate limits, shared by all kassor |
| `src/defaults.js` | `DEFAULT_PRODUCTS`, the menu a new kassa starts with |
| `src/qr.js`, `src/render.js` | Swish payload → QR code SVG |
| `public/index.html`, `app.js`, `style.css` | The operator page |
| `public/display.html`, `display.js` | The customer display (ES5, for old phones) |
| `public/shared/` | Money, Swish payload, sales summary and PDF report code; the server shares money and Swish code |
| `public/*.webmanifest`, `sw.js`, `icons/` | Installing as apps (`icons/*.svg` are the sources of the PNGs) |
| `tests/worker/` | Server tests: `npm test` |
| `tests/*.test.js` | Shared code, pages, PWA files and display.js staying ES5: `npm test` |
| `biome.jsonc` | Lint and format settings: `npm run check` |
| `docs/superpowers/` | Design documents and implementation plans |

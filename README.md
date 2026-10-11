# Swish-kassa

A two-device point-of-sale for a market stall or a club kiosk. The operator taps products
into a basket on their phone; an old spare phone facing the customer shows a Swish QR code
for the exact total. The customer scans it, and their Swish app opens with the payee, the
amount and a note (`<store name> #<order number>`) already filled in.

Design: `docs/superpowers/specs/2026-09-13-swish-calculator-design.md`

## Features

- **Products** with name and price, in an order you choose. Each product has an **Aktiv**
  switch: switched off, it disappears from the till but keeps its name, price and place,
  for when something runs out.
- **Default menu.** A new kassa starts with the HK Halmstad P13 kiosk menu (Loka, Capri
  Sun, Läsk, Kaffe, Hembakat, Delicatoboll, Korv med bröd, Wasa Knäcke, Corny, Chips,
  Kexchoklad), so it can sell right away. Change the list in `DEFAULT_PRODUCTS` in
  `src/store.js`. It only applies to kassor created afterwards.
- **Basket and running total**, with + and − per line.
- **Swish QR** on the paired customer display, and on the operator phone as a fallback
  when no display is paired.
- **Sales log** (the chart button in the header): per day, the number of sales, the
  total, the quantity and sum per product, and every sale with its time and contents.
  A sale is saved when the operator presses **Klar**. **Avbryt** saves nothing. A sale
  saved by mistake can be removed. **Sales are kept for 31 days**, then deleted
  automatically.

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

Requires Deno 2 (developed on 2.9).

```bash
deno task dev     # http://localhost:8000, restarts on file changes
deno task start   # the same, without watching
deno task test
```

The server listens on port 8000 on all interfaces, so phones on the same Wi-Fi can open
`http://<this computer's IP>:8000/` (allow Deno through the firewall if they cannot).

Local data (kassor, products, sales) lives in a Deno KV SQLite file under Deno's data
directory, e.g. `%LOCALAPPDATA%\deno\location_data\<hash>\kv.sqlite3` on Windows. It
survives restarts. Deleting it deletes everything.

## Hosting on Deno Deploy

> ⚠️ **Deno Deploy is shutting down.** On 9 October 2026 Deno announced that its team is
> joining Cloudflare and that "Deno Deploy will continue operating for six months before
> shutting down", which puts the end around **April 2027**. No exact date has been given.
> The Deno runtime gets bug-fix and security releases for one more year. Deno Deploy
> works for this season, but plan for [self-hosting](#self-hosting) or another host after
> that. The old Deploy Classic (dash.deno.com) already closed on 20 July 2026. These steps
> are for the new Deno Deploy at console.deno.com.

1. **Push this repository to GitHub.**
2. **Sign in at [console.deno.com](https://console.deno.com)** with GitHub and create an
   organization.
3. **Create the app:** *New App*, then choose the repository. Under *Edit app config*:
   - **Framework preset:** none
   - **Install command** and **Build command:** empty
   - **Runtime configuration:** *Dynamic*, **Entrypoint** `main.js`
   - **Region:** if you are offered a choice (the `deno deploy create` CLI has a
     `--region` flag; Deploy has `us`, `eu` and `global`), pick `eu`. One region is
     enough for a kiosk in Sweden, and it keeps the operator phone and the display on the
     same servers (see the check below).
4. **Give it a database.** Deno KV is not automatic on the new Deploy. In the
   organization go to *Databases → Provision Database → Deno KV*, name it, then press
   *Assign* and select the app. Deploy keeps a separate database per timeline, so
   production and each branch preview have their own data. The code needs no change:
   `Deno.openKv()` without arguments connects to the assigned database.
5. **Deploy.** Every push to the default branch deploys to production. The app's page in
   the console shows its default address, which is based on the app's name. A custom
   domain can be added under the app's *Domains* settings.
6. **Run the checks** in [Before taking real money](#️-before-taking-real-money), including
   the two-network test. It matters more on Deploy: the operator phone and the display
   usually reach different server instances, and the app relies on Deploy's
   `BroadcastChannel` to pass a charge from one to the other. That works on Deploy
   Classic. Deno's docs for the new Deploy do not say either way. If the display does
   not show a charge made on the operator phone, this is why.

Nothing carries over from a local run or an older deployment. The operator phone simply
creates a new kassa (with the default products) the first time it opens the deployed
site. Enter the store name and Swish number, then pair the display.

## Self-hosting

Any always-on machine with Deno 2 can run it: a small VPS, a Raspberry Pi, a server at
the club. A single process needs no `BroadcastChannel` between machines, so the live
updates between operator and display just work.

```bash
deno task start
```

Put it behind HTTPS (phones need a secure site for the wake lock, and Swish users trust
it more). With [Caddy](https://caddyserver.com), the whole config is:

```
kassa.example.se {
    reverse_proxy localhost:8000
}
```

The data is the KV SQLite file described under [Run locally](#run-locally). Back it up if
the sales log matters to you. Keep the process running with systemd or similar.

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

- **Add the operator page to the home screen.** It is harder to clear by accident, and on
  iOS it makes the 7-day storage eviction much less likely.
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
2. Add the page to the home screen so it opens fullscreen.
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
| `main.js` | Entry point: opens KV and starts the server |
| `src/server.js` | HTTP API (see the design doc for every route) |
| `src/store.js` | Every Deno KV read and write, and `DEFAULT_PRODUCTS` |
| `src/hub.js` | Live updates to open pages (Server-Sent Events over `BroadcastChannel`) |
| `public/index.html`, `app.js` | The operator page |
| `public/display.html`, `display.js` | The customer display |
| `public/shared/` | Money, Swish payload and sales summary code, shared by browser and server |
| `tests/` | `deno task test` |

# Swish Calculator

[Svenska](README.md) · **English**

A simple tool for taking Swish payments at a club kiosk, a market stall or a café, using
your phone.

> **Note: this is not a certified cash register.** Swish Calculator is a simple aid for
> small associations (föreningar) and the like, such as a sports team's kiosk or a school
> class's bake sale. It has no control unit and does not meet the Swedish Tax Agency's
> requirements for cash registers. If your business must have a cash register, which can
> apply even when customers pay with Swish, this does not replace one. If you are
> unsure, read
> [Skatteverket's rules on cash registers](https://www.skatteverket.se/foretag/drivaforetag/kassaregister.4.121b82f011a74172e5880005263.html)
> (in Swedish). It comes without warranty; see the [license](LICENSE).

You tap what the customer buys on your own phone, and it makes a Swish QR code for the
exact amount. The customer scans it, and their Swish app opens with your number, the
amount and a note already filled in. If you have a second phone, it can face the
customer and show the QR code for you. No card reader, no subscription, no app to
install from a store.

<p align="center">
  <img src="docs/images/till.png" width="260" alt="The till on the seller's phone: product buttons in a grid, two coffees, a hot dog and a home-baked item in the basket, 75 kr in total, and a big Ta betalt button">
  &nbsp;&nbsp;
  <img src="docs/images/display-pay.png" width="260" alt="The customer's screen: the store name, 75,00 kr, a large QR code and the Swish logo, with the text Öppna Swish-appen och skanna QR-koden">
</p>
<p align="center"><sub>Left: your phone, the till. Right: the customer's screen. (Test data.)</sub></p>

The screens are in Swedish, since Swish is Swedish.

## What you need

- **A phone, tablet or laptop for you.** This is the till. Anything with a modern web
  browser works.
- **A second device for the customer, if you like (not required).** It shows the QR
  code facing the customer, so you don't have to turn your own screen around. It can be
  an old phone lying in a drawer, or a tablet or laptop. Without it, the QR code shows
  on your own screen instead.
- **Internet on every device you use**, through Wi-Fi or mobile data. This is required:
  the till does not work offline.
- **A Swish number** that can receive payments.
- **A free [GitHub](https://github.com/signup) account** and **a free
  [Cloudflare](https://dash.cloudflare.com/sign-up) account.** The till runs on
  Cloudflare, and GitHub keeps your copy of it. You don't need to know anything about
  either: you only click through the steps below once.

It costs nothing to run. Cloudflare's free plan is far more than a kiosk needs.

## Step 1: Get your own till

Click this button:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/kjez66/swish_calculator)

1. Log in to Cloudflare (or create the account) when asked.
2. Connect your GitHub account when asked. Cloudflare puts your own copy of the till in
   it.
3. Leave the suggested names as they are and click **Create and deploy**.
4. Wait a couple of minutes. When it's done, Cloudflare shows your till's address. It
   looks like `https://swish-kassa.your-name.workers.dev`. **Write it down.** This is
   your till.

Your till is yours alone: it runs in your Cloudflare account, and your sales are stored
there, not with anyone else. If other people open your address, they each get a
separate till of their own and can't see yours.

## Step 2: Set up your phone (the till)

These steps say "phone", but a tablet works the same way. On a laptop, open the address
in the browser and bookmark it.

1. Open your till's address on your phone.
2. **Add it to your home screen**, so it opens like an app:
   - **Android (Chrome):** the menu (⋮) → **Installera app** (or **Lägg till på
     startskärmen**).
   - **iPhone (Safari):** the Share button (□↑) → **Lägg till på hemskärmen**. Then open
     the till from the new icon and do the rest of the setup there. On an iPhone, the
     home-screen app and Safari don't share anything, so a till set up in Safari is not
     in the app.
3. Tap the gear (⚙) to open the settings:
   - **Butiksnamn:** the name of your kiosk, café or club. It is shown to the customer
     and goes into the note of every payment.
   - **Swish-nummer:** the number the money goes to.
   - **Produkter:** your products and prices. A new till comes with an example menu;
     change it, remove what you don't sell, and add your own. **Aktiv** hides a product
     from the till without deleting it, for when something runs out.
4. Press **Spara**.

## Step 3: Set up the customer's phone (the display, optional)

No second device? Skip this step. When you press **Ta betalt**, the QR code appears on
your own screen, and you turn it towards the customer.

1. On your phone, tap **Ingen display** at the top of the till. A QR code and a 6-digit
   code appear.
2. On the customer's phone, scan that QR code with the camera. The display opens and
   connects to your till by itself. (Or open your till's address followed by `/display`,
   for example `https://swish-kassa.your-name.workers.dev/display`, and type the code.)
3. Your phone now says **Display ansluten**. You only do this once.
4. If you like, add the display to the home screen too, the same way as the till, so it
   opens fullscreen. On an iPhone, do this before connecting, and type the code in the
   app.
5. On the customer's phone, **turn the brightness up to maximum, turn off automatic
   brightness, and set the screen to never turn off.** A dim screen outdoors is the
   most common reason a QR code won't scan.

<p align="center">
  <img src="docs/images/display-welcome.png" width="220" alt="The customer's screen while waiting: the store name, Välkommen, and Betala med Swish">
</p>
<p align="center"><sub>Between customers, the display shows your store name and "Betala med Swish".</sub></p>

## Selling

1. Tap the products the customer wants. Tap again for more of the same. The total is at
   the bottom; tap the number of items to see the list and change it.
2. Press **Ta betalt**. The QR code appears on your screen, and on the customer's
   screen if you have one.
3. The customer scans it with their Swish app and pays.
4. **Check in your own Swish app that the money has arrived.** Then press **Klar**. The
   sale is saved, and the customer's screen, if you have one, says thank you.

**Avbryt** closes the payment without saving anything and keeps the basket, for "wait,
I'll have a bun too". The trash can empties the whole basket.

## After the day

The chart button (📊) shows the sales log for each day: how many sales, the total,
how much of each product, and every sale with its time. **Ladda ner PDF** saves a
one-page report to hand in. Compare the total with your Swish app.

Sales are kept for 31 days, then deleted automatically.

## Good to know

- **The till cannot see whether a customer has paid.** Swish doesn't tell it. "Klar"
  means *you* saw the money arrive in your own Swish app. Always check before you press
  it.
- **Do a test purchase before your first real sale.** Make a small sale, scan the code
  with your own Swish app, and check that the number, the amount and the note are right.
  You can stop in the Swish app without paying.
- **Your till lives in your phone's browser.** There is no login. If you clear the
  browser's data or change phones, your phone forgets the till and starts over with a new,
  empty one, and the old sales log can't be brought back. An iPhone can also forget it if
  you don't open it for a week. Adding the till to your home screen makes this much less
  likely. If it happens, enter your settings again and connect the display again
  (Step 3).
- **Which Swish number?** The till accepts both a private Swish number (starting with
  07) and a Swish number for businesses and associations (starting with 123). Check that
  your Swish agreement allows the kind of selling you do.
- **New versions:** your copy doesn't change when this project changes, so nothing
  changes under you in the middle of a sale.

## For developers

Requires Node.js 24, the current LTS (22 also works).

```bash
npm install
npm run dev       # http://localhost:8787 in the real Workers runtime
npm test          # every test, inside the Workers runtime
npm run check     # lint and formatting (Biome); npm run format fixes formatting
npm run deploy    # deploy to your Cloudflare account (run npx wrangler login first)
```

It is plain HTML, CSS and JavaScript with no build step. A Cloudflare Worker routes
`/api/*` to Durable Objects: one per till (settings, products, sales, and the live
WebSocket connection to the display) and one shared directory for pairing codes and
rate limits. The customer display (`public/display.js`) is kept in ES5 so it runs on
old phones; a test enforces that.

| Path | What |
|---|---|
| `public/` | The two pages, served as static files: `index.html` and `app.js` (the till), `display.html` and `display.js` (the customer display) |
| `public/shared/` | Money, Swish QR payload, sales summary and PDF report code, shared with the server |
| `public/_headers` | Security headers for the static files |
| `src/` | The Worker and the Durable Objects |
| `src/defaults.js` | The example menu a new till starts with |
| `tests/` | Tests, run with `npm test` |
| `wrangler.jsonc` | Cloudflare configuration |

The QR payload format is community-documented, not published by Getswish. The tests
prove the app produces the string it intends to, but not that Swish accepts it; the test
purchase above is what proves that.

## License

MIT, see [`LICENSE`](LICENSE). The Swish name and logo belong to Getswish AB and are
not covered by it; the Lucide icons keep their own licence. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

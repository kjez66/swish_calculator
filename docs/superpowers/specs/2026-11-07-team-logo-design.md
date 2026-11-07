# Team logo — design

A kassa can have the team's (or club's) logo. Once one is uploaded, it shows on
the customer display, on the till's own payment view and on the PDF sales
report.

## Why

It looks nicer, and the customer can see at a glance who they are paying. A
crest is recognised faster than a name in small type.

## What was asked

- The logo is optional. A kassa without one looks exactly as it does today.
- It is uploaded in the till's Inställningar, on the shopkeeper's phone. The
  logo usually starts out on the club's website, so the shopkeeper saves it to
  the phone first and then picks that file.
- When a logo is set, it shows in three places:
  1. **Customer display**: on all three screens (welcome, paying, "Tack!").
  2. **The till's own payment view**, the QR dialog used when there is no
     customer display (kiosk use).
  3. **The PDF sales report.**
- On the customer display, the logo sits **above the store name**, which stays
  (option A in the mockups). It does not replace the name.

## Success criteria

- A logo picked and saved in Inställningar is still there after a reload, and
  shows on every phone using that kassa: the till, every paired display, and
  the PDF downloaded from any of them.
- A display that is already paired and connected shows a new or removed logo
  within a few seconds of Spara, without being paired again.
- Removing the logo puts every surface back exactly as it is today.
- Kassor that never upload a logo see no change, apart from the new field in
  settings.
- The QR code on the display and in the till's payment view keeps its current
  size. The logo must never push Klar off a 320×568 screen.
- The display keeps working on old phones (ES5, `tests/display_es5.test.js`).

## Where it shows

As agreed in the brainstorming mockups (not committed):

| Surface | Placement |
|---|---|
| Display, welcome | Large, centred above the store name. The name keeps its accent line below it. |
| Display, paying | Small, centred above the (small) store name, so the amount and QR keep their space. |
| Display, "Tack!" | Medium, below "Betalningen är mottagen", in place of the small grey store name. |
| Till payment view (`#qrDlg`) | Beside the Swish logo, above the amount. |
| PDF report | Top right, level with the "Försäljning" heading. |

With no logo, each surface is exactly as it is now. That includes "Tack!": the
small grey store name only gives way to the logo when there is one.

Sizing (builder's call, within these limits): the logo is fitted inside a box
and never stretched or cropped (`object-fit: contain` or equivalent). A wide
banner-shaped logo must look as deliberate as a square crest, so the box limits
both height and width. On the display it scales with the viewport the way
`.logo` does, with a fixed-px fallback before every `clamp()`/`min()` (rule
R28 in `display.css`).

In the till's payment view, the team logo and the Swish logo keep the clear
space Swish's logo rules ask for. The Swish logo itself stays unmodified.

## Uploading, in Inställningar

- A new **Logga (valfri)** section in the settings dialog, under Swish-nummer:
  - With no logo: a short note and a **Välj bild** button, a file input with
    `accept="image/png,image/jpeg,image/webp"`.
  - With a logo: a preview on a white plate (how the display shows it), plus
    **Byt bild** and **Ta bort**.
- Picking a file only changes the preview. Nothing is saved until **Spara**,
  and **Avbryt** throws the change away, like every other field in the dialog.
  Ta bort works the same way: it takes effect on Spara.
- On the phone, before upload, the till decodes the picked image and redraws
  it onto a canvas no larger than 512 × 512 px, keeping its aspect ratio. Any
  transparency is kept. It is exported as PNG, so the server only ever gets a
  small, re-encoded PNG and never the original file. Re-encoding also drops any
  metadata, such as location in a photo.
- SVG is not accepted. It cannot go into the PDF, and an uploaded SVG is a
  script risk if it is ever opened directly.
- Errors appear at the field, in the dialog's existing style:
  - "Bilden kunde inte läsas. Välj en PNG- eller JPEG-bild." when the file is
    unreadable or not an image.
  - "Bilden är för stor." if the PNG is still over the server's limit after
    shrinking, which can happen with a photo.
- Save order on Spara: settings, then products, then the logo (a `PUT`, or a
  `DELETE` if it was removed). If the logo request fails, the dialog stays open
  with the error, as it does now for other failures.

## Server

- Stored in the kassa's Durable Object under a new key `logo`:
  `{ png: ArrayBuffer, version: string }`. `version` is a short hash of the
  bytes, or a random id. Kept apart from `settings`, because
  `PUT /api/settings` overwrites `settings` whole. Not purged by the alarm,
  since it is not a dated record.
- `PUT /api/logo` (operator only): the body is the raw PNG bytes. Refused with
  `invalid_logo` (400) unless it starts with the PNG signature. Refused with
  `logo_too_large` (413) over **256 KB**. That is well under a Durable Object's
  value limit, and far more than a 512 px crest needs. It returns `{ version }`.
- `DELETE /api/logo` (operator only): removes it. Removing a missing logo is
  fine.
- `GET /api/logo?roomId=…&v=…`: serves the PNG with `Content-Type: image/png`,
  the API's security headers, and
  `Cache-Control: public, max-age=31536000, immutable`. It answers 404 when
  there is no logo, or when `v` is not the current version. **No token needed.**
  An `<img>` cannot send an Authorization header, and a team logo is not
  secret. The room id, a random UUID, is still required, so only phones that
  already know the kassa can find it. This deliberately departs from every
  other `/api/` route.
- `/api/logo` is added to `KASSA_ROUTES` in `src/worker.js`.
- The logo's URL (`/api/logo?roomId=…&v=<version>`), or `null`, reaches:
  - the till, as `logoUrl` in `GET /api/state` (beside `settings` and
    `products`);
  - every display, as `logoUrl` in the `room` event, both on hello and when it
    changes. A logo `PUT` or `DELETE` sends the `room` event to open displays,
    just as `PUT /api/settings` does today. The event carries the store name
    too, so the two never disagree.
- The URL changes with every new logo, so caching it for a year is safe, and a
  replaced logo never shows the old picture.

### Content-Security-Policy

`public/_headers` already allows `img-src 'self'` through `default-src 'self'`,
which covers `/api/logo` on the same origin. No CSP change is needed, and none
should be made: no `data:` or `blob:` for images.

## Display (`public/display.js`, ES5)

- Each of the three screens gets an `<img class="team-logo" alt="" hidden>`.
  The `alt` is empty because the store name next to it already says whose
  stall it is.
- On a `room` event, the display sets `src` on all three to `logoUrl` and
  unhides them, or hides them when it is `null`.
- If the image fails to load (`onerror`), it stays hidden. A broken-image icon
  must never show to a customer.
- Written in ES5, with no trailing commas, to pass `display_es5.test.js`.

## Till (`public/app.js`, `index.html`, `style.css`)

- The payment view's `.logo-plate` holds the team logo before the Swish logo
  when there is one. It is hidden otherwise, and fails safe as on the display.
- The plate is white in both themes already, so a logo drawn for a white
  background reads correctly in dark mode too.
- The till's header is unchanged (see Not included).

## PDF report (`public/shared/report-pdf.js`)

- `salesReportPdf` takes an optional
  `logo: { jpeg: Uint8Array, width, height }`. With it, the report draws the
  image top right, fitted inside 160 × 48 pt (wide enough for a banner, low
  enough to clear the total below) and aligned with the heading's top. The heading and the store-name line stay where they are, and
  the store name is never overlapped. Without it, the output is byte-for-byte
  what it is today.
- The image is embedded as a JPEG with `/Filter /DCTDecode`, an Image XObject
  on every page that draws it (only the first page, beside the heading), with
  `/Resources` gaining `/XObject`. A JPEG needs no decoding or compression code
  in the PDF writer, which stays library-free.
- `pdfFile` must cope with binary stream data. `/Length` is the byte count,
  and offsets stay byte offsets (they already are: one char per byte).
- In `app.js`, when Ladda ner PDF is pressed with a logo set: load the logo
  `<img>`, draw it onto a canvas filled white first (JPEG has no transparency,
  and the page is white), and export it with `canvas.toDataURL("image/jpeg",
  0.92)`. Decode that to bytes and pass them in. If the logo cannot be loaded,
  the report is made without it. A logo problem must never block the report.

## Calls made in this design (not discussed with the owner)

- A file upload only, with no "paste a URL" option.
- PNG, JPEG or WebP, shrunk on the phone to 512 px PNG; no SVG; 256 KB server
  limit.
- The logo is saved on Spara, like the rest of the dialog, not the moment it is
  picked.
- The logo is served without a token, found by room id and version.
- The PDF logo is flattened onto white and embedded as JPEG.
- On "Tack!", the logo takes the small grey store name's place.
- The till's header is not changed.

## Not included

- The logo in the till's header, or as the app or home-screen icon.
- More than one logo per kassa, or a separate logo per surface.
- Uploading from a URL. The till takes a file only.
- SVG logos.
- Any change to the Swish payment message or the QR content. Swish cannot carry
  a logo.
- Editing the logo in the app (cropping, background removal). The shopkeeper
  uploads what they have.
- Showing the logo while the display is offline. `sw.js` never caches `/api/`.

## Testing

- Server (`tests/worker/`, new `logo.test.js`):
  - A PNG is stored and served, with `image/png`, the security headers and the
    immutable cache header.
  - A non-PNG body is refused with `invalid_logo`, and over 256 KB with
    `logo_too_large`.
  - `PUT` and `DELETE` need the operator token, and a display token is refused.
  - `GET` with a wrong or old `v` is a 404, and so is one after `DELETE`.
  - `logoUrl` shows up in `/api/state`, and in the `room` event on hello and
    after a `PUT` or `DELETE`.
  - `PUT /api/settings` does not drop the logo.
- PDF (`tests/report_pdf.test.js`):
  - With a logo, the file still parses through the test's reader. There is one
    Image XObject with `/DCTDecode`, the right `/Width`/`/Height` and a
    `/Length` equal to the JPEG's byte count, and the first page draws it.
  - Without a logo, the output equals today's.
- Display: `display_es5.test.js` still passes, and `pages.test.js` and
  `headers.test.js` still pass (no inline styles or scripts).
- In the browser, against `npm run dev`, light and dark theme:
  - Upload a square crest and a wide banner, and check all five placements.
  - Remove the logo.
  - Check that an already-paired display updates without re-pairing.
  - Check that a 320×568 till still shows Klar in the payment view.
  - Download the PDF with and without a logo, and open it in a phone's viewer
    and in a desktop reader.
- README (Swedish and English): the settings step mentions the optional logo.

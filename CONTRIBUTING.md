# Contributing

Thanks for helping. Swish Calculator is small on purpose: a till for a club kiosk that
anyone can set up with one button and run for free. Changes that keep it that way are
the easiest to take.

Found a security problem? Please don't open an issue: see [`SECURITY.md`](SECURITY.md).

## Getting started

Requires Node.js 24 (22.12 or later also works).

```bash
npm install
npm run dev       # http://localhost:8787 in the real Workers runtime
npm test          # every test, inside the Workers runtime
npm run check     # lint and formatting (Biome); npm run format fixes formatting
```

`npm run dev` listens on your network too, so you can open the till and the display on
two real phones. The README's "For developers" section has a map of the code.

## Before you open a pull request

- `npm test` and `npm run check` pass. CI runs both, and `master` requires them.
- New behaviour comes with a test, and a fixed bug with a test that failed before the fix.
- Make a test purchase if you touched anything that ends up in the QR code: scan it with
  your own Swish app and check the number, the amount and the message. You can stop in the
  app without paying. The tests prove the app produces the string it intends to, not that
  Swish accepts it.

## Rules of the code

- **`public/display.js` is ES5.** The display runs on old spare phones. No `let`/`const`,
  arrow functions, template literals or trailing commas in calls;
  `tests/display_es5.test.js` checks this.
- **A display page stays open all day**, so it may be running an older `display.js` than
  the server. Keep what the server sends readable by the previous version.
- **Money is integer öre** (hundredths of a krona), never floating point. See
  `public/shared/money.js`.
- **No build step and few dependencies.** The pages are plain HTML, CSS and JavaScript,
  served as they are.
- **Mind the Cloudflare Free plan.** Displays stay connected all day; don't add work that
  wakes a Durable Object or makes extra requests without need.
- **Match the code around you**: its naming, its comments (they explain why, not what)
  and its idioms.

## Docs

The README comes in two languages: [`README.md`](README.md) (Swedish) and
[`README.en.md`](README.en.md) (English). Change both together. They are written for
people who are not developers, so keep the words plain.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`fix(display): …`, `feat(till): …`, `docs: …`. Use the body to say why. Keep each commit
to one change.

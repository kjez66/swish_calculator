# Dropping Deno from the toolchain — design

Follows `2026-10-11-cloudflare-workers-design.md`, whose "Development and tests"
section kept the pure-module tests on Deno. This replaces that part. The app, its
hosting on Cloudflare Workers and everything the phones see stay as they are.

## Why

Since the move to Cloudflare Workers, Deno is only a developer tool here: it runs
9 test files (`deno task test`) and lints and formats the code (`deno lint`,
`deno fmt`). That means two toolchains, npm with Wrangler and Vitest plus Deno,
and two test commands, and a fresh clone needs both installed. After this change,
a clone needs only Node.js and npm.

## Success criteria

- `npm test` runs every test (the 48 Worker tests and the 39 ported ones, 87 in
  all) inside workerd, and they pass.
- `npm run check` lints and checks formatting, and passes on a clean checkout,
  Windows included.
- `deno.json` and `deno.lock` are gone. Deno is not mentioned anywhere outside
  `docs/` and needs no installing.
- The ported tests check the same things as before, under the same names.

## Tests: all in workerd

The 9 files in `tests/*_test.js` move to `tests/*.test.js` and run in the
existing Vitest setup (`@cloudflare/vitest-plugin`), next to the Worker tests in
`tests/worker/`. `vitest.config.js` includes `tests/**/*.test.js`. One runner and
one runtime, the same runtime as production.

**Syntax.** `Deno.test(name, fn)` becomes `test(name, fn)`, and `@std/assert`
becomes Vitest's `expect`, the style the Worker tests already use:

| `@std/assert` | Vitest |
|---|---|
| `assertEquals(a, b)` | `expect(a).toEqual(b)` |
| `assertNotEquals(a, b)` | `expect(a).not.toEqual(b)` |
| `assert(x)` | `expect(x).toBeTruthy()` |
| `assertMatch(s, re)` | `expect(s).toMatch(re)` |
| `assertStringIncludes(s, t)` | `expect(s).toContain(t)` |
| `assertThrows(fn, …)` | `expect(fn).toThrow(…)` |

An `assertEquals` message argument (for example, the page name in
`pages_test.js`) becomes `expect(value, message)`.

**Reading `public/` files.** Code inside workerd cannot read the host's disk, and
3 files (`pages_test.js`, `pwa_test.js` and `display_es5_test.js`) use
`Deno.readTextFile` or `Deno.readFile`. `wrangler.jsonc` gets
`"binding": "ASSETS"` under `assets`. The tests then read files with
`env.ASSETS.fetch("https://kassa.test/<path>")` (`env` from `cloudflare:workers`),
as `.text()` or, for PNGs, as bytes from `.arrayBuffer()`. They therefore check
the files as they are served to the phones. The binding changes nothing for the
live site: static files are still served before the Worker runs, and the Worker
does not use the binding.

This is unproven in this setup, so it is the first thing the implementation
proves. If it does not work, the fallback is Vite imports: `?raw` for text files
and `?inline` (a base64 data URL, decoded in the test) for PNGs.

**Packages.** `jsqr@1.4.0` and `acorn@8.14.0`, which the QR and ES5 tests use,
become npm devDependencies, at the versions `deno.json` pins today.

## Lint and format: Biome

`@biomejs/biome` replaces `deno lint` and `deno fmt`: one dev dependency, pinned
to an exact version, that does both.

- **`biome.json`:** 2-space indent and 90-character lines, as `deno.json` has
  now; double quotes, which `deno fmt` also uses; the recommended lint rules.
  Excluded: `docs/`, `public/brand/`, `node_modules/` and `.wrangler/`.
- **Line endings:** LF everywhere. A Windows checkout mixes CRLF (files from git,
  with `core.autocrlf`) and LF (files written by tools), so no single Biome setting
  passes; that mix is what made `deno fmt --check` flag every file. A
  `.gitattributes` with `* text=auto eol=lf` checks every file out as LF, and
  Biome expects LF.
- **Scripts:** `npm run check` lints and checks formatting without changing
  files; `npm run format` rewrites formatting.
- **Code comments:** the two Deno lint markers become their Biome equivalents:
  `deno-lint-ignore-file no-var` in `public/display.js` (the display stays ES5,
  so it must use `var`) and `deno-lint-ignore no-control-regex` in
  `public/shared/swish.js`. The comment near line 198 of `display.js` that names
  `deno fmt` is reworded for Biome.
- **Rule changes:** where a recommended Biome rule flags code that is correct on
  purpose, the rule is turned off in `biome.json` with a one-line reason, rather
  than the code being changed to please it.
- **One-time reformat:** Biome's first run restyles some lines where its style
  differs from `deno fmt`. That goes in its own commit with no other changes, so
  the real changes stay easy to review.

## Removing Deno and updating the docs

- **Deleted:** `deno.json`, `deno.lock` and the old `tests/*_test.js` files.
- **README:** "Run locally" asks for Node.js only and lists `npm test` and
  `npm run check`. The Windows notes and the project layout table drop
  `deno task test`, and the layout lists `tests/*.test.js`.
- **`docs/`:** earlier specs and plans keep their Deno mentions; they record what
  was decided at the time.
- **Deploying:** nothing to deploy for this change alone. The next deploy carries
  the `ASSETS` binding, which has no visible effect.

## Not included

- Self-hosting on open-source workerd (the README's "Self-hosting" section).
- A CI pipeline.
- Any change to the app's behaviour, pages or server.

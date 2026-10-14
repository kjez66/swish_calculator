# Product Categories Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each product can have one of five categories (Dryck, Mat, Fika, Godis, Övrigt),
chosen in the product settings, and the till tints a product's tile in its category's
colour.

**Architecture:** A shared module, `public/shared/categories.js`, lists the five
categories. The server validates an optional `category` on each product in
`PUT /api/products` and stores it with the products; the default menu for new kassor
carries categories. The till's settings dialog gets a Kategori list per product, and
`renderProducts` puts `data-category` on each tile, which CSS custom properties per
category tint, with separate values for the dark (default) and light themes.

**Tech Stack:** Plain ES modules served from `public/`, Cloudflare Workers + Durable
Objects (`src/`), Vitest 4 in workerd, Biome 2.5.15.

**Spec:** `docs/superpowers/specs/2026-10-14-product-categories-design.md`

## Global Constraints

- Category ids, in this order: `dryck`, `mat`, `fika`, `godis`, `ovrigt`. Names shown:
  Dryck, Mat, Fika, Godis, Övrigt. No other values.
- `category` is optional. Missing means no category; there is no `null` or `""` value
  on the wire, and the server refuses both.
- Existing kassor are not migrated.
- Sales lines, the sales report and the PDF do not change.
- Tile name and price contrast against every tint: at least 4.5:1, in both themes.
- The dark theme is the default (`:root`); the light theme redefines tokens inside
  `@media (prefers-color-scheme: light) { :root { … } }` in `public/style.css`.
- Run commands from the repo root. In PowerShell use `npm.cmd` and `npx.cmd`.
- Before each commit: `npm run format`, then `npm run check` must exit 0.
- Every commit message ends with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`

## Review Focus

1. **A pressed tinted tile shows no pressed state.** `.product[data-category]` and
   `.product:active` have the same specificity, so the later rule wins. Expected: a
   tinted tile still changes colour while pressed. Covered by an explicit
   `.product[data-category]:active` rule and a check in Task 4, Step 6.
2. **The light theme gets the dark tints, or the reverse.** Expected: pale tints on
   the light theme, deep tints on the dark one. Covered by checking both themes in
   Task 4, Step 6.
3. **Saving the settings drops categories.** For example, the save code forgets the
   field, or a reordered row loses its selection. Expected: categories survive save,
   reload and reordering. Covered in Task 3, Step 5.
4. **`null` or `""` reaches the server as "no category" and is stored.** Expected:
   refused; the till only ever omits the field. Covered by the validation test in
   Task 1.
5. **A product with a category cannot be sold.** Expected: charging works as before;
   the category does not reach the sale lines. Covered by the charge test in Task 1.

## Files

| Path | Change |
|---|---|
| `public/shared/categories.js` | Create: the five categories, `categoryName`, `isCategory` |
| `tests/categories.test.js` | Create: the list and helpers |
| `src/kassa.js` | Validate `category` in `PUT /api/products` |
| `tests/worker/rooms.test.js` | Category round-trip and validation tests |
| `tests/worker/charge.test.js` | A product with a category charges, and its sale line has no category |
| `src/defaults.js`, `tests/worker/runtime.test.js` | Default menu categories |
| `public/app.js` | Kategori list in settings rows; `data-category` and accessible name on tiles |
| `public/style.css` | Category tokens (both themes), tile tint, swatch, settings row layout |
| `README.md` | Features: categories |

---

### Task 1: Categories on the server

**Files:**
- Create: `public/shared/categories.js`, `tests/categories.test.js`
- Modify: `src/kassa.js` (the `PUT /api/products` handler), `tests/worker/rooms.test.js`,
  `tests/worker/charge.test.js`

**Interfaces:**
- Produces: `public/shared/categories.js` exporting
  `CATEGORIES: {id: string, name: string}[]` (5 entries, in the order above),
  `categoryName(id: string | undefined): string | undefined` and
  `isCategory(id: unknown): boolean`. Tasks 2–4 use these.
- Produces: products in storage and in `GET /api/state` carry `category` exactly as
  sent, or no `category` key.

- [ ] **Step 1: Write the failing test for the shared list**

Create `tests/categories.test.js`:

```js
import { expect, test } from "vitest";
import { CATEGORIES, categoryName, isCategory } from "../public/shared/categories.js";

test("the five categories, in order, with their Swedish names", () => {
  expect(CATEGORIES).toEqual([
    { id: "dryck", name: "Dryck" },
    { id: "mat", name: "Mat" },
    { id: "fika", name: "Fika" },
    { id: "godis", name: "Godis" },
    { id: "ovrigt", name: "Övrigt" },
  ]);
});

test("categoryName and isCategory know only the five ids", () => {
  expect(categoryName("ovrigt")).toBe("Övrigt");
  expect(categoryName(undefined)).toBe(undefined);
  expect(categoryName("Dryck")).toBe(undefined);
  for (const id of ["dryck", "mat", "fika", "godis", "ovrigt"]) {
    expect(isCategory(id), id).toBe(true);
  }
  for (const bad of ["", "Dryck", "drinks", null, undefined, 1, {}]) {
    expect(isCategory(bad), String(bad)).toBe(false);
  }
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/categories.test.js`
Expected: FAIL, `Cannot find module '../public/shared/categories.js'`.

- [ ] **Step 3: Write the module**

Create `public/shared/categories.js`:

```js
/**
 * The categories a product can belong to. Shared by the server, which accepts
 * only these ids, and the till, which tints a product's tile by its category.
 * Ids are stored and never shown; names are shown.
 * @module
 */

export const CATEGORIES = [
  { id: "dryck", name: "Dryck" },
  { id: "mat", name: "Mat" },
  { id: "fika", name: "Fika" },
  { id: "godis", name: "Godis" },
  { id: "ovrigt", name: "Övrigt" },
];

/**
 * The name shown for a category id; undefined for no category.
 * @param {string | undefined} id
 */
export const categoryName = (id) => CATEGORIES.find((c) => c.id === id)?.name;

/** @param {unknown} id */
export const isCategory = (id) => CATEGORIES.some((c) => c.id === id);
```

Run: `npx vitest run tests/categories.test.js`
Expected: `Tests  2 passed (2)`.

- [ ] **Step 4: Write the failing server tests**

In `tests/worker/rooms.test.js`, add after the test
`PUT /api/products validates its input`:

```js
test("a product's category is saved and returned; none means no key", async () => {
  const { api } = await newRoom();
  const products = [
    { id: "a", name: "Kaffe", priceOre: 2000, sortOrder: 0, category: "dryck" },
    { id: "b", name: "Bulle", priceOre: 1500, sortOrder: 1, category: "ovrigt" },
    { id: "c", name: "Present", priceOre: 500, sortOrder: 2 },
  ];
  expect((await api("PUT", "/api/products", { body: products })).status).toBe(200);
  const state = await (await api("GET", "/api/state")).json();
  expect(state.products).toEqual(products);
  expect("category" in state.products[2]).toBe(false);
});

test("PUT /api/products refuses a category that is not one of the five", async () => {
  const { api } = await newRoom();
  for (const category of ["Dryck", "drinks", "", null, 3, ["mat"]]) {
    const body = [{ id: "a", name: "Kaffe", priceOre: 100, sortOrder: 0, category }];
    const res = await api("PUT", "/api/products", { body });
    expect(res.status, JSON.stringify(category)).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_products" });
  }
});
```

In `tests/worker/charge.test.js`, read the top of the file for its imports (it uses
`configuredRoom` from `./helpers.js`), then add at the end:

```js
test("a product with a category charges, and its sale line has no category", async () => {
  const { api, products, charge, idle, sales } = await configuredRoom();
  await api("PUT", "/api/products", {
    body: products.map((p) => ({ ...p, category: "dryck" })),
  });
  const res = await charge([{ id: "kaffe", qty: 1 }], 2000);
  expect(res.orderNo).toBeGreaterThan(0);
  await idle(true);
  const [sale] = (await sales()).sales;
  expect(sale.lines).toEqual([
    { productId: "kaffe", name: "Kaffe", priceOre: 2000, qty: 1 },
  ]);
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `npx vitest run tests/worker/rooms.test.js tests/worker/charge.test.js`
Expected: FAIL, only `PUT /api/products refuses a category that is not one of the
five` (the server accepts anything today). The round-trip and charge tests pass
already: the server stores whatever it gets. That is expected; they guard against a
later change dropping the field.

- [ ] **Step 6: Validate the category**

In `src/kassa.js`, add to the imports at the top:

```js
import { isCategory } from "../public/shared/categories.js";
```

In the `PUT /api/products` handler, after the `enabled` check:

```js
        // Optional: products saved before the flag existed have none, and are on.
        if (p.enabled !== undefined && typeof p.enabled !== "boolean") {
          return fail("invalid_products", 400);
        }
```

add:

```js
        // Optional too: no category is told by leaving the key out, never null.
        if (p.category !== undefined && !isCategory(p.category)) {
          return fail("invalid_products", 400);
        }
```

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: every test passes; the total is 101 + 2 (categories) + 3 (worker) = 106.

- [ ] **Step 8: Commit**

```bash
npm run format && npm run check
git add public/shared/categories.js tests/categories.test.js src/kassa.js \
  tests/worker/rooms.test.js tests/worker/charge.test.js
git commit -F - <<'EOF'
feat(products): an optional category, one of five

public/shared/categories.js lists Dryck, Mat, Fika, Godis and Övrigt.
PUT /api/products accepts a product's category when it is one of them, or
missing, and refuses anything else.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: The default menu comes with categories

**Files:**
- Modify: `src/defaults.js`, `tests/worker/runtime.test.js`

**Interfaces:**
- Consumes: category ids from Task 1.
- Produces: `defaultProducts()` items gain `category`.

- [ ] **Step 1: Write the failing test**

In `tests/worker/runtime.test.js`, in the test `defaultProducts is the kiosk menu with
fresh ids`, add after the `expect(a.every(...))` line:

```js
  expect(a.map((p) => [p.name, p.category])).toEqual([
    ["Loka", "dryck"],
    ["Capri Sun", "dryck"],
    ["Läsk Cola/Fanta", "dryck"],
    ["Kaffe", "dryck"],
    ["Hembakat", "fika"],
    ["Delicatoboll", "fika"],
    ["Korv med bröd", "mat"],
    ["Wasa Knäcke", "mat"],
    ["Corny", "godis"],
    ["Chips", "godis"],
    ["Kexchoklad", "godis"],
  ]);
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/worker/runtime.test.js`
Expected: FAIL in `defaultProducts is the kiosk menu with fresh ids`: every category is
`undefined`.

- [ ] **Step 3: Add the categories**

Replace `DEFAULT_PRODUCTS` and `defaultProducts` in `src/defaults.js` with:

```js
/**
 * HK Halmstad P13's kiosk menu, in menu order: a new kassa starts with it, so
 * the kiosk can sell right away. Prices in whole kronor; categories as in
 * public/shared/categories.js.
 */
export const DEFAULT_PRODUCTS = [
  ["Loka", 15, "dryck"],
  ["Capri Sun", 15, "dryck"],
  ["Läsk Cola/Fanta", 20, "dryck"],
  ["Kaffe", 20, "dryck"],
  ["Hembakat", 15, "fika"],
  ["Delicatoboll", 15, "fika"],
  ["Korv med bröd", 20, "mat"],
  ["Wasa Knäcke", 15, "mat"],
  ["Corny", 15, "godis"],
  ["Chips", 15, "godis"],
  ["Kexchoklad", 15, "godis"],
];

/** Fresh ids per kassa: a product id is never reused (see the spec). */
export function defaultProducts() {
  return DEFAULT_PRODUCTS.map(([name, kronor, category], i) => ({
    id: crypto.randomUUID(),
    name,
    priceOre: kronor * 100,
    sortOrder: i,
    enabled: true,
    category,
  }));
}
```

Run: `grep -rn DEFAULT_PRODUCTS src public tests`
Expected: only `src/defaults.js`. If anything else destructures the tuples, update it
for the third element.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: 106 passed.

- [ ] **Step 5: Commit**

```bash
npm run format && npm run check
git add src/defaults.js tests/worker/runtime.test.js
git commit -F - <<'EOF'
feat(products): the default menu comes with categories

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: Choose the category in the product settings

**Files:**
- Modify: `public/app.js` (`productRow`, the `saveSettings` handler, imports),
  `public/style.css` (settings row, swatch, category tokens)

**Interfaces:**
- Consumes: `CATEGORIES` from Task 1.
- Produces: the CSS tokens `--cat-<id>` and `--cat-<id>-edge` for the five ids, in both
  themes, and the rule `[data-category="<id>"] { --tint; --tint-edge }`, which Task 4
  uses for the tiles.

This task has no automated test: the till has no browser test setup. It is verified
in the browser in Step 5.

- [ ] **Step 1: Add the category tokens**

In `public/style.css`, at the end of the first `:root { … }` block (dark, the
default), before its closing brace, add:

```css
  /* Product categories: a tile's tint and, a step stronger in the same hue, its
     edge. Text and price stay at 4.5:1 or more on every tint. */
  --cat-dryck: #1b2a3e;
  --cat-dryck-edge: #2c4566;
  --cat-mat: #382a1e;
  --cat-mat-edge: #5a412b;
  --cat-fika: #382231;
  --cat-fika-edge: #5a354c;
  --cat-godis: #2a2443;
  --cat-godis-edge: #463b69;
  --cat-ovrigt: #34301b;
  --cat-ovrigt-edge: #554c28;
```

In the `@media (prefers-color-scheme: light) { :root { … } }` block, before
`color-scheme: light;`, add:

```css
    --cat-dryck: #e7f0fc;
    --cat-dryck-edge: #c4d9f5;
    --cat-mat: #fdeee1;
    --cat-mat-edge: #f5d3b5;
    --cat-fika: #fbe8f0;
    --cat-fika-edge: #f1c9da;
    --cat-godis: #efe9fc;
    --cat-godis-edge: #d6cbf4;
    --cat-ovrigt: #faf3d6;
    --cat-ovrigt-edge: #ecdc9c;
```

After the `.empty { … }` rule (end of the product grid section), add:

```css
/* Each category sets the tint its tiles and its settings swatch use. */
[data-category="dryck"] {
  --tint: var(--cat-dryck);
  --tint-edge: var(--cat-dryck-edge);
}
[data-category="mat"] {
  --tint: var(--cat-mat);
  --tint-edge: var(--cat-mat-edge);
}
[data-category="fika"] {
  --tint: var(--cat-fika);
  --tint-edge: var(--cat-fika-edge);
}
[data-category="godis"] {
  --tint: var(--cat-godis);
  --tint-edge: var(--cat-godis-edge);
}
[data-category="ovrigt"] {
  --tint: var(--cat-ovrigt);
  --tint-edge: var(--cat-ovrigt-edge);
}
```

- [ ] **Step 2: Lay out the settings row**

In `public/style.css`, replace

```css
/* "Namn" and "Pris" share a width so both inputs start in line. */
.product-row .row > .unit:first-child {
  flex: none;
  width: 40px;
}
.product-row input.name,
.product-row input.price {
  flex: 1;
  min-width: 0;
}
```

with

```css
/* "Namn", "Pris" and "Kategori" share a width so the fields start in line. */
.product-row .row > .unit:first-child {
  flex: none;
  width: 60px;
}
.product-row input.name,
.product-row input.price,
.product-row select.category {
  flex: 1;
  min-width: 0;
}
/* The chosen category's colour beside its list; a dashed ring for Ingen. */
.swatch {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px dashed var(--field-border);
}
.swatch[data-category] {
  background: var(--tint);
  border: 2px solid var(--tint-edge);
}
```

- [ ] **Step 3: Add the Kategori line to each product row**

In `public/app.js`, add to the imports:

```js
import { CATEGORIES } from "/shared/categories.js";
```

Above `function productRow`, add:

```js
/** The Kategori list's options, with the product's category selected. */
const categoryOptions = (selected) =>
  `<option value="">Ingen</option>` +
  CATEGORIES.map(
    ({ id, name }) =>
      `<option value="${id}"${id === selected ? " selected" : ""}>${name}</option>`,
  ).join("");
```

In `productRow`, the row's HTML ends with

```js
    `<button class="icon-btn del" aria-label="Ta bort produkt" title="Ta bort produkt">` +
    `✕</button>` +
    `</div>`;
```

Replace those three lines with:

```js
    `<button class="icon-btn del" aria-label="Ta bort produkt" title="Ta bort produkt">` +
    `✕</button>` +
    `</div>` +
    `<div class="row"><span class="unit" aria-hidden="true">Kategori</span>` +
    `<select class="category" aria-label="Kategori">${categoryOptions(p.category)}</select>` +
    `<span class="swatch" aria-hidden="true"></span></div>`;
```

Change the comment above `productRow` from "Two lines per product" to "Three lines per
product", and add a line: "The third picks the category that tints the product's
tile."

In `productRow`, after `syncOff();`, add:

```js
  const category = row.querySelector(".category");
  const swatch = row.querySelector(".swatch");
  const syncSwatch = () => {
    if (category.value) swatch.dataset.category = category.value;
    else swatch.removeAttribute("data-category");
  };
  category.onchange = syncSwatch;
  syncSwatch();
```

- [ ] **Step 4: Save the category**

In the `saveSettings` handler, replace

```js
      next.push({
        id: row.dataset.id,
        name,
        priceOre: parseKronorToOre(priceRaw),
        sortOrder: i,
        enabled: row.querySelector(".enabled").checked,
      });
```

with

```js
      const category = row.querySelector(".category").value;
      next.push({
        id: row.dataset.id,
        name,
        priceOre: parseKronorToOre(priceRaw),
        sortOrder: i,
        enabled: row.querySelector(".enabled").checked,
        // Ingen is told by leaving the key out; the server refuses "".
        ...(category ? { category } : {}),
      });
```

- [ ] **Step 5: Check it in the browser**

Start the dev server: `npx wrangler dev --port 8787` (in the background).

Use a new kassa, so a real kassa's products are not changed: in the browser at
`http://localhost:8787/`, save `localStorage["swish-kassa-room"]` elsewhere in
localStorage, remove it, and reload. Afterwards, put it back and reload.

On the new kassa, open the settings (gear button).
Expected: every product row has a third line, `Kategori`, with the list showing the
default menu's categories (Loka: Dryck, Korv med bröd: Mat, Hembakat: Fika, Chips:
Godis) and a filled swatch in that category's colour.

- Set Wasa Knäcke to Övrigt and Corny to Ingen. Expected: Wasa Knäcke's swatch turns
  yellow; Corny's becomes a dashed ring.
- Move Corny up twice with ↑. Expected: its list still says Ingen.
- Save, reload the page, reopen the settings. Expected: Wasa Knäcke is Övrigt, Corny is
  Ingen and in its new place, and the others are unchanged.
- In the page, run
  `(await (await fetch("/api/state?roomId=" + JSON.parse(localStorage["swish-kassa-room"]).roomId, {headers: {Authorization: "Bearer " + JSON.parse(localStorage["swish-kassa-room"]).operatorToken}})).json()).products.map(p => [p.name, p.category])`.
  Expected: Corny has `undefined`, Wasa Knäcke `"ovrigt"`.
- The three labels Namn, Pris and Kategori line up, and the Kategori line fits on a
  360 px wide window without wrapping.

Stop the dev server, including its `workerd` child process.

- [ ] **Step 6: Run the tests and commit**

Run: `npm test`
Expected: 106 passed.

```bash
npm run format && npm run check
git add public/app.js public/style.css
git commit -F - <<'EOF'
feat(settings): choose each product's category

A Kategori list on each product row, with a swatch in the chosen category's
colour. Ingen saves no category.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: Tint the till's tiles

**Files:**
- Modify: `public/app.js` (`renderProducts`, imports), `public/style.css` (tiles),
  `README.md`

**Interfaces:**
- Consumes: `categoryName` from Task 1; the `[data-category]` tint rules from Task 3.

This task's look is tuned in the browser (Step 6), against the spec's criteria.

- [ ] **Step 1: Put the category on the tile**

In `public/app.js`, extend the categories import:

```js
import { CATEGORIES, categoryName } from "/shared/categories.js";
```

In `renderProducts`, replace

```js
    btn.setAttribute(
      "aria-label",
      `${p.name}, ${formatOre(p.priceOre)} kr${qty ? `, ${qty} i korgen` : ""}`,
    );
```

with

```js
    // The category tints the tile, and is said too, so colour is not the only cue.
    const category = categoryName(p.category);
    if (category) btn.dataset.category = p.category;
    btn.setAttribute(
      "aria-label",
      `${p.name}${category ? `, ${category}` : ""}, ${formatOre(p.priceOre)} kr${
        qty ? `, ${qty} i korgen` : ""
      }`,
    );
```

- [ ] **Step 2: Tint the tile**

In `public/style.css`, after the `.product:active { … }` rule, add:

```css
/* A category tints the tile; its edge, a step stronger in the same hue, keeps a
   pale tile crisp against the page. Pressed still shows, as on a plain tile. */
.product[data-category] {
  background: var(--tint);
  border: 1px solid var(--tint-edge);
}
.product[data-category]:active {
  background: var(--accent-soft);
}
```

- [ ] **Step 3: Run the tests**

Run: `npm test`
Expected: 106 passed.

- [ ] **Step 4: Update the README**

In `README.md`, under "## Features", after the "Products" item, add:

```markdown
- **Categories.** Each product can be Dryck, Mat, Fika, Godis or Övrigt, chosen in the
  product settings. The till tints a product's tile in its category's colour; a
  product with no category keeps a plain tile. The default menu comes sorted.
```

- [ ] **Step 5: Measure contrast on the rendered page**

Start the dev server and use a new kassa as in Task 3, Step 5. In settings, give one
product each category, including Övrigt, and leave one on Ingen; save.

In the page, run:

```js
const lum = (rgb) => {
  const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return +((x + 0.05) / (y + 0.05)).toFixed(2);
};
[...document.querySelectorAll(".product")].map((t) => {
  const bg = getComputedStyle(t).backgroundColor;
  return [t.dataset.category ?? "-", ratio(getComputedStyle(t).color, bg),
    ratio(getComputedStyle(t.querySelector(".price")).color, bg)];
});
```

Expected: every name ratio and every price ratio is 4.5 or more.

To see the dark theme without changing the computer's setting, run:

```js
const dark = [...document.styleSheets[0].cssRules].find((r) => r.selectorText === ":root");
document.documentElement.style.cssText = dark.style.cssText;
```

and run the measurement again. Expected: 4.5 or more everywhere. Reload to return to
the light theme.

- [ ] **Step 6: Tune the look, in both themes**

Take a screenshot of the full grid in the light theme and in the dark theme (as in
Step 5). Judge against the spec:

- The five tints are easy to tell apart at a glance, and none is louder than the
  others: same lightness, similar saturation.
- Tinted tiles sit well next to a plain tile and against the page; the edge is crisp
  but quiet.
- The green quantity badge stands out on every tint: tap a product of each category
  once and look.
- A pressed tile changes visibly: hold the mouse down on a tinted tile, or check that
  `.product[data-category]:active` sets `--accent-soft`.

Where a tint fails, adjust its `--cat-<id>` and `--cat-<id>-edge` values in
`public/style.css`, keeping the hue, then re-run Step 5. Record the final values and
the measured ratios in the commit message.

Put the original kassa back in localStorage and reload. Stop the dev server, including
`workerd`.

- [ ] **Step 7: Commit**

```bash
npm run format && npm run check
npm test
git add public/app.js public/style.css README.md
git commit -F - <<'EOF'
feat(till): tint each product's tile in its category's colour

A product with a category gets a pale tint (deep in the dark theme) with a
slightly stronger edge; its name and price stay at 4.5:1 or more. The category
is part of the tile's accessible name.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

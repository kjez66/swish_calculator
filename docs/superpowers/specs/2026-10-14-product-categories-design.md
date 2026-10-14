# Product categories — design

Each product can belong to one of five categories, and the till tints a
product's tile in its category's colour, so the operator finds things faster in
a full grid.

## What was asked

- Five categories: **Dryck, Mat, Fika, Godis, Övrigt**. A product has one of
  them or none.
- On the till's product grid, a product's tile is tinted in its category's
  colour. A product with no category looks as it does today.
- The tiles keep the order set in the product settings; the category only
  colours them.
- The category is chosen in the product settings.
- The tinting must look polished and professional, in both themes.

## Success criteria

- A category chosen in the settings is saved, survives a reload and colours the
  tile on every phone showing that kassa.
- Products saved before this change, and products left on "Ingen", show plain
  tiles and save without error.
- In both themes, a tile's name and price are at least 4.5:1 against its tint,
  and the five tints are easy to tell apart at arm's length on a phone.
- A new kassa's default menu arrives with categories.

## Data and server

- A product gets an optional `category`: one of `dryck`, `mat`, `fika`,
  `godis`, `ovrigt`. A missing field means no category. Ids are ASCII and
  never shown; the names are.
- `public/shared/categories.js` lists the five, in that order, with their
  Swedish names. The server and the till both import it, like `money.js`.
- `PUT /api/products` accepts `category` when it is missing or one of the five,
  and refuses anything else with `invalid_products`, as it does for `enabled`.
- Existing kassor are not migrated: their products have no category until the
  operator sets one.
- The default menu for new kassor (`src/defaults.js`): Loka, Capri Sun, Läsk
  Cola/Fanta, Kaffe → Dryck; Korv med bröd, Wasa Knäcke → Mat; Hembakat,
  Delicatoboll → Fika; Corny, Chips, Kexchoklad → Godis.
- Sales lines do not record the category: the sales report and the PDF are
  unchanged.

## Product settings

Each product row gets a third line: a visible **Kategori** label, a native
`<select>` (Ingen, Dryck, Mat, Fika, Godis, Övrigt) and a small round swatch
showing the chosen category's colour, empty for Ingen. A line of its own,
because the price line already holds the price and the ↑ ↓ ✕ buttons. Moving a
row moves its category with it; saving sends `category` only when one is
chosen.

## Till tiles

- A tile with a category gets that category's tint as its background and a
  1 px border in a slightly stronger tint of the same hue, which gives the edge
  definition a pale fill otherwise lacks. The shadow stays.
- Hues: Dryck blue, Mat orange, Fika pink, Godis purple, Övrigt yellow.
- Colours are CSS custom properties per category, defined for the light theme
  and redefined for the dark theme in the same places the other tokens are.
  Starting values, measured (text and price contrast against the tint):

  | | Light tint / border | Dark tint / border | Text, price (light · dark) |
  |---|---|---|---|
  | Dryck | `#e7f0fc` / `#c4d9f5` | `#1b2a3e` / `#2c4566` | 15.6, 5.3 · 13.2, 5.6 |
  | Mat | `#fdeee1` / `#f5d3b5` | `#382a1e` / `#5a412b` | 15.8, 5.4 · 12.6, 5.3 |
  | Fika | `#fbe8f0` / `#f1c9da` | `#382231` / `#5a354c` | 15.3, 5.2 · 13.2, 5.6 |
  | Godis | `#efe9fc` / `#d6cbf4` | `#2a2443` / `#463b69` | 15.1, 5.2 · 13.3, 5.7 |
  | Övrigt | `#faf3d6` / `#ecdc9c` | `#34301b` / `#554c28` | 16.1, 5.5 · 12.0, 5.1 |

  These are tuned in the browser against a real grid, in both themes, until the
  five read as distinct but quiet: same lightness and saturation family, no
  tint louder than another. Any change keeps text and price at 4.5:1 or more.
- The green quantity badge and the pressed state are unchanged and must still
  stand out on every tint.
- The tile's accessible name includes the category: "Loka, Dryck, 15,00 kr".
  Colour is then not the only way the category is told.

## Not included

- Colour or totals per category in the sales report or the PDF.
- Grouping or sorting the tiles by category.
- The customer display.
- Renaming categories or adding new ones.

## Testing

- Server (`tests/worker/`): a category is saved and returned; a missing
  category is accepted; an unknown one, or a non-string, is refused; a new
  kassa's default products carry the categories above.
- `tests/categories.test.js`: the shared list has the five ids and names, in
  order.
- Till and settings: checked in the browser against `npm run dev`, light and
  dark theme — choosing, saving and reloading a category; the tints on a full
  grid; contrast measured from the rendered page.

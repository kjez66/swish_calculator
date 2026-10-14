import { expect, test } from "vitest";
import { CATEGORIES } from "../public/shared/categories.js";
import { assetText } from "./assets.js";

// The till tints a product's tile by its category (style.css). Two promises are
// checked here for both themes: the tile's name and price stay readable on every
// tint, and no two tints are so close that the operator cannot tell them apart.

const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (hex) => [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));

/** WCAG contrast ratio of two #rrggbb colours. */
function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = rgb(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** CIE76 colour difference (ΔE) of two #rrggbb colours, through CIELAB (D65). */
function deltaE(a, b) {
  const toLab = (hex) => {
    const [r, g, bl] = rgb(hex);
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883;
    const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
  };
  const [p, q] = [toLab(a), toLab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** The custom properties a CSS block sets, as { name: value }. */
const tokens = (block) =>
  Object.fromEntries(
    [...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );

/** The dark theme's tokens (the first :root block) and the light theme's. */
async function themes() {
  const css = await assetText("/style.css");
  const dark = /:root\s*\{([^}]*)\}/.exec(css)[1];
  const light = /prefers-color-scheme:\s*light\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)[1];
  return { dark: tokens(dark), light: tokens(light) };
}

test("a tile's name and price stay at 4.5:1 or more on every category tint", async () => {
  for (const [theme, t] of Object.entries(await themes())) {
    for (const { id } of CATEGORIES) {
      const tint = t[`cat-${id}`];
      expect(tint, `${theme} --cat-${id}`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(contrast(t.text, tint), `${theme} ${id} name`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.muted, tint), `${theme} ${id} price`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("no two category tints are too close to tell apart", async () => {
  for (const [theme, t] of Object.entries(await themes())) {
    const ids = CATEGORIES.map((c) => c.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const d = deltaE(t[`cat-${ids[i]}`], t[`cat-${ids[j]}`]);
        expect(
          d,
          `${theme} ${ids[i]} vs ${ids[j]}: ΔE ${d.toFixed(1)}`,
        ).toBeGreaterThanOrEqual(10);
      }
    }
  }
});

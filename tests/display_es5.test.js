import { parse } from "acorn";
import { expect, test } from "vitest";
import { assetText } from "./assets.js";

// The display runs on an old spare phone, so display.js must stay ES5. A formatter
// that adds trailing commas to multi-line calls (ES2017) would turn the whole page
// into a SyntaxError there; this catches that and anything newer.
test("public/display.js parses as ECMAScript 5", async () => {
  const source = await assetText("/display.js");
  let error = null;
  try {
    parse(source, { ecmaVersion: 5 });
  } catch (err) {
    error = err.message;
  }
  expect(error).toBe(null);
});

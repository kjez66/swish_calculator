import { assertEquals } from "@std/assert";
import { parse } from "acorn";

// The display runs on an old spare phone, so display.js must stay ES5. deno fmt
// adds trailing commas to multi-line calls (ES2017), which would turn the
// whole page into a SyntaxError there; this catches that and anything newer.
Deno.test("public/display.js parses as ECMAScript 5", async () => {
  const source = await Deno.readTextFile("public/display.js");
  let error = null;
  try {
    parse(source, { ecmaVersion: 5 });
  } catch (err) {
    error = err.message;
  }
  assertEquals(error, null);
});

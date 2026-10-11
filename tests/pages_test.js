import { assertEquals } from "@std/assert";

Deno.test("the official Swish logo is shipped and shown on both pages", async () => {
  const logo = await Deno.readTextFile("public/brand/swish-logo.svg");
  assertEquals(logo.startsWith("<svg"), true);
  for (const page of ["public/display.html", "public/index.html"]) {
    const html = await Deno.readTextFile(page);
    assertEquals(html.includes('src="/brand/swish-logo.svg"'), true, page);
  }
});

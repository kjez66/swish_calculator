import { expect, test } from "vitest";
import { asset, assetText } from "./assets.js";
import { call } from "./worker/helpers.js";

// Every file in public/ is served with these (public/_headers), so a page can
// load nothing from elsewhere and cannot be framed by another site.
const PAGES = ["/", "/display"];
const FILES = [...PAGES, "/app.js", "/display.js", "/style.css", "/sw.js"];

for (const path of FILES) {
  test(`${path} is served with the security headers`, async () => {
    const { headers } = await asset(path);
    expect(headers.get("Strict-Transport-Security")).toMatch(/max-age=\d{8}/);
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Permissions-Policy")).toContain("camera=()");
    expect(headers.get("Permissions-Policy")).toContain("screen-wake-lock=(self)");
    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    const csp = headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    // Any wss:// host, not just this one: old Safari does not count wss:// as
    // 'self', and a copy deployed elsewhere has a different hostname.
    expect(csp).toContain("connect-src 'self' wss:;");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain("unsafe");
  });
}

// The policy allows no inline code or styles, so the pages must not have any.
for (const path of PAGES) {
  test(`${path} has no inline script, style or event handler`, async () => {
    const html = await assetText(path);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });
}

test("API responses are served with the security headers", async () => {
  const { headers } = await call("GET", "/api/nope");
  expect(headers.get("Strict-Transport-Security")).toMatch(/max-age=\d{8}/);
  expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(headers.get("Referrer-Policy")).toBe("no-referrer");
  expect(headers.get("Content-Security-Policy")).toBe(
    "default-src 'none'; frame-ancestors 'none'",
  );
});

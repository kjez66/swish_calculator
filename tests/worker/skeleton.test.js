import { exports } from "cloudflare:workers";
import { expect, test } from "vitest";

test("unknown API routes 404", async () => {
  const res = await exports.default.fetch("https://kassa.test/api/nope");
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_found" });
});

import { expect, test } from "vitest";
import { stockholmDate } from "../src/dates.js";

test("stockholmDate uses Stockholm local time, not UTC", () => {
  // 22:30 UTC on 12 Sep is already 00:30 on 13 Sep in Stockholm (CEST, UTC+2).
  // Using UTC here would reset order numbers mid-evening during a late market.
  expect(stockholmDate(new Date("2026-09-12T22:30:00Z"))).toBe("2026-09-13");
  expect(stockholmDate(new Date("2026-09-12T21:30:00Z"))).toBe("2026-09-12");
  // Winter is UTC+1.
  expect(stockholmDate(new Date("2026-01-12T23:30:00Z"))).toBe("2026-01-13");
});

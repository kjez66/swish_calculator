import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

const directory = () => env.DIRECTORY.getByName("global");

test("rate limiting counts per scope, per client, per minute", async () => {
  const d = directory();
  const t = Date.now();
  for (let i = 0; i < 3; i++) expect(await d.allow("rooms", "ipA", 3, t)).toBe(true);
  expect(await d.allow("rooms", "ipA", 3, t)).toBe(false);
  expect(await d.allow("rooms", "ipB", 3, t)).toBe(true);
  expect(await d.allow("pair", "ipA", 3, t)).toBe(true);
  expect(await d.allow("rooms", "ipA", 3, t + 60_000)).toBe(true);
});

test("pair codes are six digits, single-use and expire after 5 minutes", async () => {
  const d = directory();
  const t = Date.now();
  const code = await d.createPairCode("room-1", t);
  expect(code).toMatch(/^\d{6}$/);
  expect(await d.claimPairCode(code, t + 1000)).toBe("room-1");
  expect(await d.claimPairCode(code, t + 2000)).toBe(null);

  const late = await d.createPairCode("room-2", t);
  expect(await d.claimPairCode(late, t + 5 * 60_000 + 1)).toBe(null);
  expect(await d.claimPairCode("12ab56", t)).toBe(null);
});

test("createPairCode never overwrites a live code from another kassa", async () => {
  const d = directory();
  const t = Date.now();
  const draws = ["111111", "111111", "222222"];
  let original;
  await runInDurableObject(d, (instance) => {
    original = instance.drawPairCode;
    instance.drawPairCode = () => draws.shift();
  });
  try {
    expect(await d.createPairCode("room-a", t)).toBe("111111");
    expect(await d.createPairCode("room-b", t)).toBe("222222");
    expect(await d.claimPairCode("111111", t)).toBe("room-a");
  } finally {
    // The instance outlives this test: an empty draw list would make the next
    // createPairCode loop forever.
    await runInDurableObject(d, (instance) => {
      instance.drawPairCode = original;
    });
  }
});

test("the purge alarm removes expired codes and windows only", async () => {
  const d = directory();
  const now = Date.now();
  const stale = await d.createPairCode("room-old", now - 10 * 60_000);
  const fresh = await d.createPairCode("room-new", now);
  await d.allow("rooms", "ipOld", 5, now - 5 * 60_000);
  expect(await runDurableObjectAlarm(d)).toBe(true);
  await runInDurableObject(d, async (_, state) => {
    const keys = [...(await state.storage.list()).keys()];
    expect(keys).toContain(`pair:${fresh}`);
    expect(keys).not.toContain(`pair:${stale}`);
    expect(keys.some((k) => k.includes("ipOld"))).toBe(false);
  });
});

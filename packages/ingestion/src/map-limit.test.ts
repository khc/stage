import { expect, test } from "bun:test";

import { mapLimit } from "./map-limit";

test("results keep the input order and no more than `limit` calls run at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const results = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(n % 2 === 0 ? 1 : 5);
    inFlight -= 1;
    return n * 10;
  });
  expect(results).toEqual([10, 20, 30, 40, 50, 60]);
  expect(peak).toBe(2);
});

test("an empty list makes no call, and a limit above the length is fine", async () => {
  expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  expect(await mapLimit([1], 5, async (n) => n + 1)).toEqual([2]);
});

test("a failing call rejects the whole map", async () => {
  await expect(
    mapLimit([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }),
  ).rejects.toThrow("boom");
});

test("after a call rejects, no further call is started", async () => {
  const started: number[] = [];
  await expect(
    mapLimit([1, 2, 3, 4, 5, 6, 7, 8], 2, async (n) => {
      started.push(n);
      await Bun.sleep(10);
      if (n === 1) throw new Error("boom");
      return n;
    }),
  ).rejects.toThrow("boom");
  await Bun.sleep(60);
  expect(started).toEqual([1, 2]);
});

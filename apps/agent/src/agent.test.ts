import { expect, test } from "bun:test";
import { getCurrentTime, rootAgent } from "./agent";

test("getCurrentTime returns the city and an ISO time", async () => {
  const result = (await getCurrentTime.runAsync({
    args: { city: "Warsaw" },
    toolContext: undefined as never,
  })) as { city: string; time: string };

  expect(result.city).toBe("Warsaw");
  expect(new Date(result.time).toISOString()).toBe(result.time);
});

test("rootAgent exposes getCurrentTime", () => {
  expect(rootAgent.tools).toContain(getCurrentTime);
});

import { expect, test } from "bun:test";

import { A2A_MODE_KEY, runModeSchema } from "./run-mode";

test("runModeSchema accepts quick and workflow and rejects the rest", () => {
  expect(runModeSchema.safeParse("quick").success).toBe(true);
  expect(runModeSchema.safeParse("workflow").success).toBe(true);
  expect(runModeSchema.safeParse("slow").success).toBe(false);
  expect(runModeSchema.safeParse(undefined).success).toBe(false);
});

test("the A2A metadata key is namespaced like the parent key", () => {
  expect(A2A_MODE_KEY).toBe("stage:mode");
});

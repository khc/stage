import { expect, test } from "bun:test";

import { A2A_PARENT_KEY, parentRefSchema } from "./parent-ref";

const taskId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";

test("the A2A metadata key is namespaced", () => {
  expect(A2A_PARENT_KEY).toBe("stage:parent");
});

test("accepts a task id and a session id", () => {
  expect(parentRefSchema.safeParse({ taskId, sessionId: "s-1" })).toMatchObject({
    success: true,
    data: { taskId, sessionId: "s-1" },
  });
});

test.each([
  ["a task id that is not a UUID", { taskId: "not-a-uuid", sessionId: "s-1" }],
  ["an empty session id", { taskId, sessionId: "" }],
  ["a session id over 1500 characters", { taskId, sessionId: "s".repeat(1501) }],
  ["a missing session id", { taskId }],
  ["something that is not an object", "x"],
])("rejects %s", (_case, value) => {
  expect(parentRefSchema.safeParse(value).success).toBe(false);
});

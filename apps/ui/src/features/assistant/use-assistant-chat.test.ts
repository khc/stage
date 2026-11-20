import { expect, mock, test } from "bun:test";

import type { SessionSummary } from "@/lib/api";

import {
  executeNewChatSend,
  isAwaitingRunStart,
  pickActiveSessionId,
  shouldPollSessions,
  type PendingTask,
} from "./use-assistant-chat";

const summary = (id: string, lastUpdateTime: number): SessionSummary => ({
  id,
  taskId: "t1",
  appName: "app",
  userId: "u1",
  lastUpdateTime,
});

test("pickActiveSessionId prefers starting session across initial transition, then preferred, then latest", () => {
  const list = [summary("old", 10), summary("new", 20)];
  expect(pickActiveSessionId([], null, "starting-1")).toBe("starting-1");
  expect(pickActiveSessionId(list, "old", "starting-missing")).toBe("old");
  expect(pickActiveSessionId(list, null, null)).toBe("new");
  expect(pickActiveSessionId(list, "deleted", null)).toBe("new");
  expect(pickActiveSessionId([], null, null)).toBeNull();
});

test("isAwaitingRunStart stays true across /assistant -> /assistant/$chatId until run settles", () => {
  const starting = { taskId: "t-new", sessionId: "s-new" };
  expect(isAwaitingRunStart(starting, "t-new", "s-new", undefined)).toBe(true);
  expect(isAwaitingRunStart(starting, "t-new", "s-new", { run: { status: "running", startedAt: 1 } })).toBe(
    false,
  );
  expect(isAwaitingRunStart(starting, "other-task", "s-new", undefined)).toBe(false);
  expect(isAwaitingRunStart(starting, undefined, null, undefined)).toBe(false);
});

test("shouldPollSessions stops polling once a starting session settles", () => {
  const starting = { taskId: "t-new", sessionId: "s-new" };
  expect(shouldPollSessions([], starting, "t-new", undefined)).toBe(5000);
  expect(
    shouldPollSessions([], starting, "t-new", { run: { status: "running", startedAt: 1 } }),
  ).toBe(5000);
  expect(
    shouldPollSessions([], starting, "t-new", { run: { status: "succeeded", startedAt: 1 } }),
  ).toBe(false);
  expect(
    shouldPollSessions(
      [{ ...summary("s-new", 20), run: { status: "failed", startedAt: 1 } }],
      starting,
      "t-new",
      undefined,
    ),
  ).toBe(false);
  expect(
    shouldPollSessions(
      [{ ...summary("s-old", 10), run: { status: "running", startedAt: 1 } }],
      null,
      "t-old",
      undefined,
    ),
  ).toBe(5000);
  expect(shouldPollSessions([summary("s-old", 10)], null, "t-old", undefined)).toBe(false);
});

test("executeNewChatSend reuses created task and skips already-uploaded files on retry", async () => {
  let uploadAttempts = 0;
  let pending: PendingTask | null = null;
  const create = mock(async () => ({ taskId: "task-123", name: "Hello", prompt: "Hello" }));
  const uploadDocument = mock(async (_taskId: string, file: File) => {
    uploadAttempts += 1;
    if (file.name === "b.txt" && uploadAttempts === 2) {
      throw new Error("temporary upload error");
    }
    return {
      documentId: `doc-${file.name}`,
      filename: file.name,
      checksum: "c",
      contentType: "text/plain",
    };
  });
  const startSession = mock(async () => ({ operation: "op-1", sessionId: "sess-1" }));

  const fileA = new File(["a"], "a.txt", { type: "text/plain" });
  const fileB = new File(["b"], "b.txt", { type: "text/plain" });

  await expect(
    executeNewChatSend({
      client: { create, uploadDocument, startSession } as never,
      pending,
      setPending: (next) => {
        pending = next;
      },
      target: { jobName: "orchestrator", agentName: "orchestrator" },
      message: "Hello",
      files: [fileA, fileB],
    }),
  ).rejects.toThrow("temporary upload error");

  expect(create).toHaveBeenCalledTimes(1);
  expect(uploadDocument).toHaveBeenCalledTimes(2);
  expect(startSession).toHaveBeenCalledTimes(0);
  expect(pending).not.toBeNull();

  const result = await executeNewChatSend({
    client: { create, uploadDocument, startSession } as never,
    pending,
    setPending: (next) => {
      pending = next;
    },
    target: { jobName: "orchestrator", agentName: "orchestrator" },
    message: "Hello",
    files: [fileA, fileB],
  });

  expect(result).toEqual({ taskId: "task-123", sessionId: "sess-1" });
  expect(create).toHaveBeenCalledTimes(1);
  expect(uploadDocument).toHaveBeenCalledTimes(3);
  expect(startSession).toHaveBeenCalledTimes(1);
  expect(pending).toBeNull();
});

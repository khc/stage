import { createEvent } from "@google/adk";
import { expect, mock, test } from "bun:test";
import { createRunAgent } from "./index";

const reply = (text: string) =>
  createEvent({ content: { role: "model", parts: [{ text }] } });

const setup = (
  runAsync: () => AsyncGenerator<ReturnType<typeof createEvent>>,
) => {
  const sessionService = {
    createSession: mock(async () => ({ id: "s1" })),
  };
  const run = createRunAgent({ sessionService, runAsync } as never);
  return { run, sessionService };
};

test("creates a session, returns the final response text and keeps the session", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("hello ");
  });

  expect(await run("hi")).toBe("hello");
  expect(sessionService.createSession).toHaveBeenCalledWith({
    appName: "agent-jobs",
    userId: "user",
  });
});

test("throws when no final response is produced", async () => {
  const { run } = setup(async function* () {});

  await expect(run("hi")).rejects.toThrow("no final response");
});

test("propagates a failed run", async () => {
  const { run } = setup(async function* () {
    throw new Error("boom");
  });

  await expect(run("hi")).rejects.toThrow("boom");
});

test("passes runId as session metadata for a job invocation", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("hello");
  });
  const runId = crypto.randomUUID();
  await run("hi", runId);
  expect(sessionService.createSession).toHaveBeenCalledWith({
    appName: "agent-jobs",
    userId: "user",
    runId,
  });
});

import { createEvent } from "@google/adk";
import { expect, mock, test } from "bun:test";
import { createRunAgent } from "./index";

const reply = (text: string) =>
  createEvent({ content: { role: "model", parts: [{ text }] } });

const setup = (runAsync: () => AsyncGenerator<ReturnType<typeof createEvent>>) => {
  const sessionService = {
    createSession: mock(async () => ({ id: "s1" })),
    deleteSession: mock(async () => {}),
  };
  const run = createRunAgent({ sessionService, runAsync } as never);
  return { run, sessionService };
};

test("returns the final response text and deletes the session", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("hello ");
  });

  expect(await run("hi")).toBe("hello");
  expect(sessionService.deleteSession).toHaveBeenCalledWith({
    appName: "agent-jobs",
    userId: "user",
    sessionId: "s1",
  });
});

test("throws when no final response is produced, still deleting the session", async () => {
  const { run, sessionService } = setup(async function* () {});

  await expect(run("hi")).rejects.toThrow("no final response");
  expect(sessionService.deleteSession).toHaveBeenCalledTimes(1);
});

test("deletes the session when the run fails", async () => {
  const { run, sessionService } = setup(async function* () {
    throw new Error("boom");
  });

  await expect(run("hi")).rejects.toThrow("boom");
  expect(sessionService.deleteSession).toHaveBeenCalledTimes(1);
});

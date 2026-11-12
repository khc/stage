import { expect, mock, spyOn, test } from "bun:test";

import { createEvent, LlmAgent } from "@google/adk";
import { z } from "zod";

import { createRunAgent, createTaskAgent } from "./runtime";
import type { AgentSet } from "./spec";

const reply = (text: string) => createEvent({ content: { role: "model", parts: [{ text }] } });

const setup = (runAsync: () => AsyncGenerator<ReturnType<typeof createEvent>>) => {
  const sessionService = {
    createSession: mock(async () => ({ id: "s1" })),
  };
  const run = createTaskAgent({ sessionService, runAsync } as never);
  return { run, sessionService };
};

test("creates a session, returns the final response text and keeps the session", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("hello ");
  });

  expect(await run("hi")).toBe("hello");
  expect(sessionService.createSession).toHaveBeenCalledWith({
    appName: "stage",
    userId: "user",
  });
});

test("throws when no final response is produced", async () => {
  const { run } = setup(async function* () {});

  await expect(run("hi")).rejects.toThrow("no final response");
});

test("propagates a run that fails midway", async () => {
  const { run } = setup(async function* () {
    yield reply("partial");
    throw new Error("boom");
  });

  await expect(run("hi")).rejects.toThrow("boom");
});

test("passes taskId as session metadata for a job invocation", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("hello");
  });
  const taskId = crypto.randomUUID();
  await run("hi", taskId);
  expect(sessionService.createSession).toHaveBeenCalledWith({
    appName: "stage",
    userId: "user",
    taskId,
  });
});

test("resumes an existing session of the same task without creating one", async () => {
  const taskId = crypto.randomUUID();
  const getSession = mock(async () => ({ id: "s9", taskId }));
  const sessionService = {
    createSession: mock(async () => ({ id: "x" })),
    getSession,
  };
  const runAsync = mock(async function* () {
    yield reply("again");
  });
  const run = createTaskAgent({ sessionService, runAsync } as never);

  expect(await run("more", taskId, "s9")).toBe("again");
  expect(sessionService.createSession).not.toHaveBeenCalled();
  expect(runAsync).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "s9" }));
});

test("refuses to resume a missing session or one linked to another task", async () => {
  for (const found of [undefined, { id: "s9", taskId: "other" }]) {
    const sessionService = {
      createSession: mock(async () => ({ id: "x" })),
      getSession: mock(async () => found),
    };
    const runAsync = mock(async function* () {
      yield reply("no");
    });
    const run = createTaskAgent({ sessionService, runAsync } as never);
    await expect(run("more", "task-1", "s9")).rejects.toThrow("Session not found");
    expect(runAsync).not.toHaveBeenCalled();
  }
});

test("publishes every yielded event and survives a publish failure", async () => {
  const sessionService = { createSession: mock(async () => ({ id: "s1" })) };
  const runAsync = async function* () {
    yield reply("a");
    yield reply("b");
  };
  const publish = mock(async () => {
    throw new Error("pubsub down");
  });
  const spy = spyOn(console, "error").mockImplementation(() => {});
  const run = createTaskAgent({ sessionService, runAsync } as never, publish);

  expect(await run("hi", "t1")).toBe("b");
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenCalledWith(expect.anything(), {
    sessionId: "s1",
    taskId: "t1",
  });
  spy.mockRestore();
});

const fake = new LlmAgent({ name: "fake", model: "fake-model" });
const set: AgentSet = {
  defaultAgent: "text",
  agents: {
    text: { agent: fake, inputSchema: z.string(), outputSchema: z.string() },
    structured: {
      agent: fake,
      inputSchema: z.object({ topic: z.string() }),
      outputSchema: z.object({ poem: z.string() }),
    },
  },
};
const runner = () => createRunAgent(set, { db: {} as never, publish: undefined });

test("createRunAgent rejects an agent name the set does not hold", async () => {
  await expect(runner()("hi", undefined, undefined, "nope")).rejects.toThrow("Unknown agent: nope");
});

test("createRunAgent rejects a message that does not match a structured agent's input", async () => {
  await expect(runner()("not json", undefined, undefined, "structured")).rejects.toThrow(
    "must be JSON",
  );
  await expect(runner()("{}", undefined, undefined, "structured")).rejects.toThrow(
    "does not match",
  );
});

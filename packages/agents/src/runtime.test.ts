import { expect, mock, spyOn, test } from "bun:test";

import {
  BaseLlm,
  createEvent,
  LlmAgent,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
} from "@google/adk";
import { z } from "zod";

import { createRoutedLlm } from "./model";
import { createRunAgent, createTaskAgent } from "./runtime";
import type { AgentSet } from "./spec";

const reply = (text: string) => createEvent({ content: { role: "model", parts: [{ text }] } });

const runs = () => ({ startRun: mock(async () => {}), finishRun: mock(async () => {}) });

const setup = (runAsync: () => AsyncGenerator<ReturnType<typeof createEvent>>) => {
  const sessionService = {
    createSession: mock(async () => ({ id: "s1" })),
    ...runs(),
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
    name: "hi",
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
    name: "hi",
  });
});

test("resumes an existing session of the same task without creating one", async () => {
  const taskId = crypto.randomUUID();
  const getSession = mock(async () => ({ id: "s9", taskId }));
  const sessionService = {
    createSession: mock(async () => ({ id: "x" })),
    getSession,
    ...runs(),
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
      ...runs(),
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
  const sessionService = { createSession: mock(async () => ({ id: "s1" })), ...runs() };
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

test("a resumed session takes a free-text message even for a structured agent", async () => {
  const noSession = {
    collection: () => ({
      where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
      doc: () => ({ get: async () => ({ exists: false }) }),
    }),
  };
  const run = createRunAgent(set, { db: noSession as never, publish: undefined });
  // It gets past the input check and fails only because the session does not exist.
  await expect(run("winter", crypto.randomUUID(), "s1", "structured")).rejects.toThrow(
    "Session not found for this task",
  );
});

test("records a succeeded run around a successful execution", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("done");
  });
  await run("hi");
  const key = { appName: "stage", userId: "user", sessionId: "s1" };
  expect(sessionService.startRun).toHaveBeenCalledWith(key);
  expect(sessionService.finishRun).toHaveBeenCalledWith(key);
});

test("a failed success write is logged and does not fail the run", async () => {
  const { run, sessionService } = setup(async function* () {
    yield reply("done");
  });
  sessionService.finishRun.mockRejectedValue(new Error("firestore down"));
  const spy = spyOn(console, "error").mockImplementation(() => {});
  expect(await run("hi")).toBe("done");
  expect(sessionService.finishRun).toHaveBeenCalledTimes(1);
  expect(spy).toHaveBeenCalledWith("Failed to record run success", expect.any(Error));
  spy.mockRestore();
});

test("records a failed run with the error and rethrows it", async () => {
  // oxlint-disable-next-line require-yield
  const { run, sessionService } = setup(async function* () {
    throw new Error("boom");
  });
  await expect(run("hi")).rejects.toThrow("boom");
  expect(sessionService.finishRun).toHaveBeenCalledWith(expect.anything(), "boom");
});

test("does not run the agent when the session is already running", async () => {
  const runAsync = mock(async function* () {
    yield reply("never");
  });
  const sessionService = {
    createSession: mock(async () => ({ id: "s1" })),
    startRun: mock(async () => {
      throw new Error("A run is already in progress for this session");
    }),
    finishRun: mock(async () => {}),
  };
  const run = createTaskAgent({ sessionService, runAsync } as never);
  await expect(run("hi")).rejects.toThrow("already in progress");
  expect(runAsync).not.toHaveBeenCalled();
  expect(sessionService.finishRun).not.toHaveBeenCalled();
});

test("resumes a session under the app and user it was created with", async () => {
  const taskId = crypto.randomUUID();
  const getSession = mock(async (_key: unknown) => ({ id: "s9", taskId }));
  const sessionService = { createSession: mock(), getSession, ...runs() };
  const runAsync = mock(async function* (_request: unknown) {
    yield reply("again");
  });
  const owner = { appName: "agent-jobs", userId: "legacy" };
  const run = createTaskAgent({ sessionService, runAsync } as never, undefined, owner);

  expect(await run("more", taskId, "s9")).toBe("again");
  expect(getSession).toHaveBeenCalledWith({ ...owner, sessionId: "s9" });
  expect(sessionService.startRun).toHaveBeenCalledWith({ ...owner, sessionId: "s9" });
  expect(runAsync).toHaveBeenCalledWith(expect.objectContaining({ userId: "legacy" }));
});

test("createRunAgent enforces inputSchema on a pre-created empty session, while follow-ups allow free text", async () => {
  const taskId = crypto.randomUUID();
  const docSnap = {
    exists: true,
    get: (field: string) =>
      ({
        sessionId: "s-pre",
        taskId,
        appName: "stage",
        userId: "user",
        state: {},
        lastUpdateTime: 1,
      })[field],
  };
  const dbWithEvents = (eventJsons: string[]) => ({
    collection: () => ({
      where: () => ({
        limit: () => ({
          get: async () => ({
            docs: [{ get: (f: string) => (f === "appName" ? "stage" : "user") }],
          }),
        }),
      }),
      doc: () => ({
        get: async () => docSnap,
        collection: () => ({
          orderBy: () => ({
            get: async () => ({ docs: eventJsons.map((json) => ({ get: () => json })) }),
          }),
        }),
      }),
    }),
  });

  const emptyRun = createRunAgent(set, { db: dbWithEvents([]) as never, publish: undefined });
  await expect(emptyRun("not json", taskId, "s-pre", "structured")).rejects.toThrow("must be JSON");

  const resumedRun = createRunAgent(set, {
    db: dbWithEvents([JSON.stringify(reply("previous"))]) as never,
    publish: undefined,
  });
  await expect(resumedRun("free text follow-up", taskId, "s-pre", "structured")).rejects.toThrow(
    "runTransaction is not a function",
  );

  const taskAgentReject = createTaskAgent(
    {
      sessionService: {
        createSession: mock(),
        getSession: async () => ({ id: "s-pre", taskId, events: [] }),
        ...runs(),
      },
      runAsync: mock(async function* () {
        yield reply("never");
      }),
    } as never,
    undefined,
    undefined,
    () => {
      throw new Error("Input must be JSON");
    },
  );
  await expect(taskAgentReject("not json", taskId, "s-pre")).rejects.toThrow("must be JSON");
});

class AnsweringLlm extends BaseLlm {
  // oxlint-disable-next-line require-yield
  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield { content: { role: "model", parts: [{ text: this.model }] } } as LlmResponse;
  }
  async connect(): Promise<BaseLlmConnection> {
    return {} as BaseLlmConnection;
  }
}

// An agent run whose only LLM call goes through the routing model and is answered by its model name.
const askingRun = () => {
  const routed = createRoutedLlm(
    "default-model",
    () => new AnsweringLlm({ model: "default-model" }),
  );
  const runAsync = mock(async function* () {
    for await (const response of routed.generateContentAsync({} as LlmRequest))
      yield reply(response.content?.parts?.[0]?.text ?? "");
  });
  const sessionService = { createSession: mock(async () => ({ id: "s1" })), ...runs() };
  return { run: createTaskAgent({ sessionService, runAsync } as never), sessionService, runAsync };
};

test("every LLM call of the run goes to the model that was resolved for it", async () => {
  const { run } = askingRun();
  const chosen = new AnsweringLlm({ model: "chosen-model" });
  expect(await run("hi", undefined, undefined, undefined, async () => chosen)).toBe("chosen-model");
});

test("without a resolved model the run uses the default model, as before", async () => {
  const { run } = askingRun();
  expect(await run("hi")).toBe("default-model");
  expect(await run("hi", undefined, undefined, undefined, async () => undefined)).toBe(
    "default-model",
  );
});

test("a model that cannot be resolved fails the run on the session, before any LLM call", async () => {
  const { run, sessionService, runAsync } = askingRun();
  const failure = new Error('Model m is not available on provider "P"');
  await expect(
    run("hi", undefined, undefined, undefined, async () => {
      throw failure;
    }),
  ).rejects.toThrow("not available");
  expect(runAsync).not.toHaveBeenCalled();
  expect(sessionService.finishRun).toHaveBeenCalledWith(expect.anything(), failure.message);
});

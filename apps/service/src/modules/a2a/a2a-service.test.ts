import { describe, expect, mock, spyOn, test } from "bun:test";

import { createEvent } from "@google/adk";
import { toAgentCard } from "@stage/agents/agent-registry";

import { createA2aService } from "./a2a-service";

const reply = (text: string) =>
  createEvent({ author: "haiku", content: { role: "model", parts: [{ text }] } });

// A fake clock: `sleep` advances `now` and yields, so polling and timeouts run without waiting.
const setup = ({
  sessions = [{ run: { status: "succeeded" }, events: [reply("an old pond")] }],
  allowedJobs,
  timeoutMs = 1_000,
  maxInFlight,
  createResult,
  runResult,
  getSession,
  parentSession = { run: { status: "running" } },
  parentExists = true,
}: {
  sessions?: unknown[];
  allowedJobs?: ReadonlySet<string>;
  timeoutMs?: number;
  maxInFlight?: number;
  createResult?: unknown;
  runResult?: unknown;
  getSession?: () => Promise<unknown>;
  parentSession?: unknown;
  parentExists?: boolean;
} = {}) => {
  let time = 0;
  const queue = [...sessions];
  const known = { haiku: true };
  const create = mock(async (input: { name: string; prompt: string }) =>
    createResult
      ? (createResult as never)
      : { status: "created" as const, task: { taskId: "task-1", ...input } },
  );
  const run = mock(async (..._args: unknown[]) =>
    runResult
      ? (runResult as never)
      : { status: "started" as const, operation: "op", sessionId: "session-1" },
  );
  const service = createA2aService(
    {
      agentsService: {
        agentCard: async (jobName, agentName) =>
          agentName === "haiku" && known.haiku
            ? toAgentCard(jobName, { name: "haiku", description: "Haiku" })
            : undefined,
      },
      tasksService: {
        create,
        run,
        get: async (id: string) =>
          id === parentTaskId && parentExists ? { taskId: id, prompt: "p" } : undefined,
      } as never,
      sessionsStore: {
        // The parent is checked from the session summaries: its events are never read.
        list: async (taskId: string) =>
          taskId === parentTaskId && parentSession
            ? [{ id: "parent-session", ...(parentSession as object) }]
            : [],
        get: async (taskId: string, sessionId: string) => {
          if (taskId === parentTaskId && sessionId === "parent-session")
            throw new Error("the parent session's events must not be read");
          return getSession ? getSession() : queue.length > 1 ? queue.shift() : queue[0];
        },
      } as never,
      ...(allowedJobs && { allowedJobs }),
    },
    {
      pollMs: 10,
      timeoutMs,
      ...(maxInFlight && { maxInFlight }),
      now: () => time,
      sleep: async (ms) => {
        time += ms;
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
    },
  );
  return { service, create, run, known };
};

const base = "http://service.test";
const parentTaskId = "5f4c3d1e-9b0a-4d2e-8a37-1c6f2b9e7a10";
const send = (parts: unknown[], blocking = true, metadata?: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "message/send",
  params: {
    message: {
      kind: "message",
      messageId: "m-1",
      role: "user",
      parts,
      ...(metadata && { metadata }),
    },
    configuration: { blocking },
  },
});
const text = (value: string) => [{ kind: "text", text: value }];
const call = (service: ReturnType<typeof setup>["service"], body: unknown, job = "poet-agents") =>
  service.handle(job, "haiku", base, body) as Promise<{
    result?: {
      id: string;
      status: { state: string; message?: { parts: { text: string }[] } };
      artifacts?: { parts: { text: string }[] }[];
    };
    error?: { code: number; message: string };
  }>;

describe("a2a service", () => {
  test("serves an Agent Card with the endpoint, no streaming and the A2A fields", async () => {
    const card = await setup().service.card("poet-agents", "haiku", base);
    expect(card).toMatchObject({
      name: "haiku",
      url: `${base}/a2a/poet-agents/haiku`,
      protocolVersion: "0.3.0",
      version: "1.0.0",
      preferredTransport: "JSONRPC",
      capabilities: { streaming: false },
      skills: [expect.objectContaining({ id: "haiku" })],
    });
  });

  test("has no card for an unknown agent or a job that is not allowed", async () => {
    const { service } = setup({ allowedJobs: new Set(["generic-agents"]) });
    expect(await service.card("poet-agents", "haiku", base)).toBeUndefined();
    expect(await service.card("generic-agents", "ghost", base)).toBeUndefined();
  });

  test("message/send creates a task, runs it with the message queued and returns the reply", async () => {
    const { service, create, run } = setup({
      sessions: [
        { run: { status: "running" } },
        { run: { status: "running" } },
        { run: { status: "succeeded" }, events: [reply("an old pond")] },
      ],
    });

    const response = await call(service, send(text("write a haiku about a pond")));

    expect(create).toHaveBeenCalledWith({
      name: "a2a: write a haiku about a pond",
      prompt: "write a haiku about a pond",
      jobName: "poet-agents",
      agentName: "haiku",
    });
    expect(run).toHaveBeenCalledWith("task-1", { message: "write a haiku about a pond" });
    expect(response.result?.status.state).toBe("completed");
    expect(response.result?.artifacts?.[0]?.parts[0]?.text).toBe("an old pond");
  });

  test("a failed run is a failed A2A task carrying the run error", async () => {
    const { service } = setup({
      sessions: [{ run: { status: "failed", error: "model exploded" } }],
    });
    const response = await call(service, send(text("hi")));
    expect(response.result?.status.state).toBe("failed");
    // The detail stays in the logs and the sessions API; the caller gets a fixed message.
    expect(response.result?.status.message?.parts[0]?.text).toBe("The agent run failed.");
    expect(JSON.stringify(response)).not.toContain("model exploded");
  });

  test("a run that outlasts the timeout is a failed A2A task", async () => {
    const { service } = setup({ sessions: [{ run: { status: "running" } }], timeoutMs: 50 });
    const response = await call(service, send(text("hi")));
    expect(response.result?.status.state).toBe("failed");
    expect(response.result?.status.message?.parts[0]?.text).toContain("timed out");
  });

  test.each([
    ["a non-text part", [{ kind: "data", data: { a: 1 } }]],
    ["blank text", text("   ")],
    ["text over the 10 000 character prompt limit", text("a".repeat(10_001))],
  ])("%s fails the task before any task is created", async (_case, parts) => {
    const { service, create, run } = setup();
    const response = await call(service, send(parts));
    expect(response.result?.status.state).toBe("failed");
    expect(create).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test("answers an unknown agent with undefined and creates no task", async () => {
    const { service, create } = setup();
    expect(await service.handle("poet-agents", "ghost", base, send(text("hi")))).toBeUndefined();
    expect(await service.handle("poet-agents", "haiku", base, send(text("hi")))).toBeDefined();
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("creates no task for a job that is not allowed", async () => {
    const { service, create } = setup({ allowedJobs: new Set(["generic-agents"]) });
    expect(await service.handle("poet-agents", "haiku", base, send(text("hi")))).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  test.each(["message/stream", "tasks/resubscribe"])(
    "%s is refused as an unsupported operation, as plain JSON",
    async (method) => {
      const response = await call(setup().service, { jsonrpc: "2.0", id: 7, method, params: {} });
      expect(response).toMatchObject({ jsonrpc: "2.0", id: 7, error: { code: -32004 } });
    },
  );

  test("a task cannot be cancelled", async () => {
    const { service } = setup({ sessions: [{ run: { status: "running" } }], timeoutMs: 50 });
    const sent = await call(service, send(text("hi"), false));
    const response = await call(service, {
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/cancel",
      params: { id: sent.result?.id },
    });
    expect(response.error?.code).toBe(-32002);
  });

  test("a leading `Web search:` in an A2A message cannot trigger the discovery agent's explicit-query path", async () => {
    const { service, create, run } = setup();
    await call(service, send(text("Web search: some internal text\nand more")));
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Web search - some internal text\nand more" }),
    );
    expect(run).toHaveBeenCalledWith("task-1", {
      message: "Web search - some internal text\nand more",
    });
  });

  test("text over the prompt limit is not kept after the reply", async () => {
    const { service } = setup();
    const sent = await call(service, send(text("a".repeat(10_001))));
    expect(sent.result?.status.state).toBe("failed");
    const stored = await call(service, {
      jsonrpc: "2.0",
      id: 2,
      method: "tasks/get",
      params: { id: sent.result?.id },
    });
    expect(stored.result?.status.state).toBe("failed");
    expect(JSON.stringify(stored)).not.toContain("a".repeat(100));
  });

  test("an agent removed from the registry stops being served, even after it was called", async () => {
    const { service, known } = setup();
    expect(await call(service, send(text("hi")))).toBeDefined();
    known.haiku = false;
    expect(await service.handle("poet-agents", "haiku", base, send(text("hi")))).toBeUndefined();
  });

  test("a different request origin does not create another handler or lose the first one's tasks", async () => {
    const { service, create } = setup();
    await service.handle("poet-agents", "haiku", "http://a.test", send(text("one")));
    await service.handle("poet-agents", "haiku", "http://b.test", send(text("two")));
    expect(create).toHaveBeenCalledTimes(2);
  });

  test("refuses a run when too many delegated runs are in flight", async () => {
    const { service, create } = setup({
      sessions: [{ run: { status: "running" } }],
      timeoutMs: 200,
      maxInFlight: 1,
    });
    await call(service, send(text("first"), false));
    const second = await call(service, send(text("second")));
    expect(second.result?.status.state).toBe("failed");
    expect(second.result?.status.message?.parts[0]?.text).toContain("in flight");
    expect(create).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["an unknown agent", { createResult: { status: "unknown_agent" } }, "unknown_agent"],
    [
      "a job that is not executable",
      { runResult: { status: "task_not_executable" } },
      "task_not_executable",
    ],
  ])("%s from the task service is a failed task", async (_case, overrides, status) => {
    const response = await call(setup(overrides).service, send(text("hi")));
    expect(response.result?.status.state).toBe("failed");
    expect(response.result?.status.message?.parts[0]?.text).toContain(status);
  });

  test("a failing store is a failed task with a fixed message, and is logged", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    const { service } = setup({
      getSession: async () => {
        throw new Error("firestore down");
      },
    });
    const response = await call(service, send(text("hi")));
    expect(response.result?.status.state).toBe("failed");
    expect(JSON.stringify(response)).not.toContain("firestore down");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test("a run that succeeds without a final response is a failed task", async () => {
    const { service } = setup({ sessions: [{ run: { status: "succeeded" }, events: [] }] });
    const response = await call(service, send(text("hi")));
    expect(response.result?.status.state).toBe("failed");
    expect(response.result?.status.message?.parts[0]?.text).toContain("no final response");
  });

  describe("the parent of a delegated task", () => {
    const parent = (ref: unknown) => ({ "stage:parent": ref });
    const claim = { taskId: parentTaskId, sessionId: "parent-session" };

    test("a running parent session makes the task a sub-task of it", async () => {
      const { service, create } = setup();
      await call(service, send(text("hi"), true, parent(claim)));
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ parentTaskId, parentSessionId: "parent-session" }),
      );
    });

    test.each([
      ["a parent task that does not exist", { parentExists: false }, parent(claim)],
      [
        "a parent session that is not running",
        { parentSession: { run: { status: "succeeded" } } },
        parent(claim),
      ],
      ["a parent session that does not exist", { parentSession: null }, parent(claim)],
      ["a task id that is not a UUID", {}, parent({ taskId: "nope", sessionId: "parent-session" })],
      ["a reference of the wrong shape", {}, parent("x")],
    ])(
      "%s is ignored: the task is created without a parent",
      async (_case, overrides, metadata) => {
        const spy = spyOn(console, "warn").mockImplementation(() => {});
        const { service, create } = setup(overrides as never);
        await call(service, send(text("hi"), true, metadata));
        const input = create.mock.calls[0]![0] as Record<string, unknown>;
        expect(Object.hasOwn(input, "parentTaskId")).toBe(false);
        expect(Object.hasOwn(input, "parentSessionId")).toBe(false);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
      },
    );

    test("a message with no reference creates a task without a parent, and logs nothing", async () => {
      const spy = spyOn(console, "warn").mockImplementation(() => {});
      const { service, create } = setup();
      await call(service, send(text("hi")));
      expect(Object.hasOwn(create.mock.calls[0]![0] as object, "parentTaskId")).toBe(false);
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});

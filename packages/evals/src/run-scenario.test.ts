import { expect, test } from "bun:test";

import { toSessionView, type EvalApi, type RunMode } from "./api-client";
import { jobNameFor, runScenario, type RunOptions, type Scenario } from "./run-scenario";
import type { EvalEvent, RunSummary } from "./trace";

const options: RunOptions = { timeoutMs: 2000, pollMs: 1, drainMs: 50, keep: false, env: "lcl" };

const ev = (id: string, role: "user" | "model", text: string): EvalEvent => ({
  id,
  author: role === "user" ? "user" : "agent",
  content: { role, parts: [{ text }] },
});

type Step = {
  events: EvalEvent[];
  run?: Partial<RunSummary>;
  // Polls that still show the previous state after the run call (the job needs time to start).
  polls?: number;
  // Event ids the stream never delivers.
  skipStream?: string[];
  // Deliver a batch in reverse order, as live events may arrive out of stored order.
  reverseStream?: boolean;
};

const scenario = (turns: number, extra: Partial<Scenario> = {}): Scenario => ({
  name: "demo",
  app: "knowledge",
  agent: "discovery-assistant",
  turns: Array.from({ length: turns }, (_, i) => ({ say: `message ${i + 1}`, expect: {} })),
  ...extra,
});

// A fake service: each `run` call plays the next step, which lands in the session after `polls` reads.
const fakeApi = (steps: Step[], busyRuns = 0) => {
  const log = {
    created: [] as Parameters<EvalApi["createTask"]>[0][],
    runs: [] as { message: string; sessionId?: string; mode?: RunMode }[],
    deleted: [] as string[],
  };
  const stored: EvalEvent[] = [];
  let run: RunSummary | undefined;
  let current: Step | undefined;
  let pollsLeft = 0;
  let next = 0;
  let busy = busyRuns;

  const api: EvalApi = {
    health: async () => {},
    createTask: async (input) => {
      log.created.push(input);
      return { taskId: "t1" };
    },
    listTasks: async () => [],
    run: async (_taskId, input) => {
      log.runs.push(input);
      if (busy > 0) {
        busy--;
        return { status: 409, error: "run_in_progress" };
      }
      current = steps[next++];
      pollsLeft = current?.polls ?? 1;
      return input.sessionId ? { status: 202 } : { status: 202, sessionId: "s1" };
    },
    getSession: async () => {
      if (current && pollsLeft-- <= 0) {
        stored.push(...current.events);
        run = { status: "succeeded", startedAt: next * 1000, ...current.run };
        current = undefined;
      }
      return { events: [...stored], ...(run && { run }) };
    },
    async *streamEvents(_taskId, _sessionId, signal) {
      const sent = new Set<string>();
      const skip = new Set(steps.flatMap((step) => step.skipStream ?? []));
      while (!signal.aborted) {
        const batch = stored.filter((e) => e.id && !sent.has(e.id) && !skip.has(e.id));
        const reverse = steps.some(
          (step) => step.reverseStream && step.events.some((e) => batch.includes(e)),
        );
        for (const event of reverse ? batch.toReversed() : batch) {
          sent.add(event.id!);
          yield event;
        }
        await Bun.sleep(1);
      }
    },
    deleteTask: async (taskId) => {
      log.deleted.push(taskId);
    },
  };
  return { api, log };
};

test("builds the job name from the app and the environment", () => {
  expect(jobNameFor("knowledge", "lcl")).toBe("stage--knowledge-agents--job-lcl");
});

test("creates an eval: task on the agent, prompted with the first message", async () => {
  const { api, log } = fakeApi([{ events: [ev("e1", "user", "m"), ev("e2", "model", "a")] }]);
  await runScenario(api, scenario(1), options);
  expect(log.created[0]!.name.startsWith("eval: demo (")).toBe(true);
  expect(log.created[0]).toMatchObject({
    prompt: "message 1",
    jobName: "stage--knowledge-agents--job-lcl",
    agentName: "discovery-assistant",
  });
});

test("runs in quick mode unless the scenario sets one", async () => {
  const quick = fakeApi([{ events: [ev("e1", "model", "a")] }]);
  await runScenario(quick.api, scenario(1), options);
  expect(quick.log.runs[0]!.mode).toBe("quick");
  const workflow = fakeApi([{ events: [ev("e1", "model", "a")] }]);
  await runScenario(workflow.api, scenario(1, { mode: "workflow" }), options);
  expect(workflow.log.runs[0]!.mode).toBe("workflow");
});

test("turn 2 resumes the turn-1 session and gets only its own events", async () => {
  const { api, log } = fakeApi([
    { events: [ev("e1", "user", "m1"), ev("e2", "model", "first answer")] },
    // The session shows the previous run for 3 more polls before the new one starts.
    { events: [ev("e3", "user", "m2"), ev("e4", "model", "second answer")], polls: 3 },
  ]);
  const trace = await runScenario(api, scenario(2), options);
  expect(log.runs.map((r) => r.sessionId)).toEqual([undefined, "s1"]);
  expect(trace.sessionId).toBe("s1");
  expect(trace.turns.map((t) => t.answer)).toEqual(["first answer", "second answer"]);
  // The stream replayed e1 and e2 on turn 2; they belong to turn 1.
  expect(trace.turns[1]!.events.map((e) => e.id)).toEqual(["e3", "e4"]);
});

test("the turn follows the stored order when live events arrive out of order", async () => {
  const { api } = fakeApi([
    {
      events: [ev("e1", "user", "m"), ev("e2", "model", "early"), ev("e3", "model", "final")],
      reverseStream: true,
    },
  ]);
  const trace = await runScenario(api, scenario(1), options);
  expect(trace.turns[0]!.events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
  expect(trace.turns[0]!.answer).toBe("final");
});

test("retries a 409 run_in_progress until the run is accepted", async () => {
  const { api, log } = fakeApi([{ events: [ev("e1", "model", "a")] }], 2);
  await runScenario(api, scenario(1), options);
  expect(log.runs).toHaveLength(3);
});

test("a failed run is recorded on the turn and later turns are not run", async () => {
  const { api, log } = fakeApi([
    { events: [ev("e1", "user", "m")], run: { status: "failed", error: "boom" } },
    { events: [ev("e2", "model", "never")] },
  ]);
  const trace = await runScenario(api, scenario(2), options);
  expect(trace.turns).toHaveLength(1);
  expect(trace.turns[0]!.run).toMatchObject({ status: "failed", error: "boom" });
  expect(log.runs).toHaveLength(1);
});

test("fails with sse_incomplete when the stream misses a stored event", async () => {
  const { api } = fakeApi([
    { events: [ev("e1", "user", "m"), ev("e2", "model", "a")], skipStream: ["e2"] },
  ]);
  await expect(runScenario(api, scenario(1), options)).rejects.toThrow("sse_incomplete");
});

test("deletes the task after success and after failure, but not with keep", async () => {
  const done = fakeApi([{ events: [ev("e1", "model", "a")] }]);
  await runScenario(done.api, scenario(1), options);
  expect(done.log.deleted).toEqual(["t1"]);

  const broken = fakeApi([{ events: [ev("e1", "model", "a")], skipStream: ["e1"] }]);
  await expect(runScenario(broken.api, scenario(1), options)).rejects.toThrow();
  expect(broken.log.deleted).toEqual(["t1"]);

  const kept = fakeApi([{ events: [ev("e1", "model", "a")] }]);
  await runScenario(kept.api, scenario(1), { ...options, keep: true });
  expect(kept.log.deleted).toEqual([]);
});

test("the session guard rejects a body without an events array", () => {
  expect(() => toSessionView({})).toThrow("events");
  expect(() => toSessionView({ events: [], run: { status: "weird", startedAt: 1 } })).toThrow(
    "run",
  );
  expect(toSessionView({ events: [], run: { status: "running", startedAt: 1 } }).run?.status).toBe(
    "running",
  );
});

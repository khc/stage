import { expect, test } from "bun:test";

import type { AgentInfo, Job, SessionEvent, Task } from "@/lib/api";

import {
  buildTargetOptions,
  childTaskCountMap,
  groupChatTurns,
  parseDelegation,
  parseTargetKey,
  resolveDefaultTarget,
  rootChatTasks,
  targetKey,
  toChatTitle,
  turnCopyText,
} from "./assistant-model";

const job = (shortName: string): Job => ({
  name: `projects/p/locations/l/jobs/${shortName}`,
});

test("resolveDefaultTarget prioritizes exact orchestrator job and agent", () => {
  expect(
    resolveDefaultTarget([job("worker"), job("orchestrator")], {
      worker: [{ name: "orchestrator" }],
      orchestrator: [{ name: "helper" }, { name: "Orchestrator" }],
    }),
  ).toEqual({ jobName: "orchestrator", agentName: "Orchestrator" });

  expect(resolveDefaultTarget([job("worker"), job("orchestrator")], {})).toEqual({
    jobName: "orchestrator",
  });
});

test("resolveDefaultTarget falls back to orchestrator agent, then orchestrator-like job, then first job", () => {
  expect(
    resolveDefaultTarget([job("alpha"), job("beta")], {
      beta: [{ name: "my-orchestrator" }],
    }),
  ).toEqual({ jobName: "beta", agentName: "my-orchestrator" });

  expect(
    resolveDefaultTarget([job("alpha"), job("beta")], {
      alpha: [{ name: "my-orchestrator" }],
      beta: [{ name: "orchestrator" }],
    }),
  ).toEqual({ jobName: "beta", agentName: "orchestrator" });

  expect(resolveDefaultTarget([job("alpha"), job("stage-orchestrator")], {})).toEqual({
    jobName: "stage-orchestrator",
  });

  expect(resolveDefaultTarget([job("alpha"), job("beta")], {})).toEqual({
    jobName: "alpha",
  });

  expect(resolveDefaultTarget([], {})).toBeUndefined();
});

test("buildTargetOptions places the orchestrator default first and marks structured-input agents", () => {
  const agentsByJob: Record<string, AgentInfo[]> = {
    worker: [
      {
        name: "structured-agent",
        inputSchema: { type: "object", properties: { query: { type: "string" } } },
      },
    ],
    orchestrator: [{ name: "orchestrator", description: "Main coordinator" }],
  };

  const options = buildTargetOptions([job("worker"), job("orchestrator")], agentsByJob);
  expect(options[0]).toMatchObject({
    jobName: "orchestrator",
    agentName: "orchestrator",
    isOrchestrator: true,
  });
  const structured = options.find((o) => o.agentName === "structured-agent");
  expect(structured?.unsupportedHint).toContain("structured input");
});

test("targetKey and parseTargetKey round-trip job and agent names containing slashes or colons", () => {
  const t1 = { jobName: "team/a:job", agentName: "sub:agent/1" };
  const t2 = { jobName: "plain-job" };
  expect(parseTargetKey(targetKey(t1))).toEqual(t1);
  expect(parseTargetKey(targetKey(t2))).toEqual(t2);
  expect(parseTargetKey("not-json")).toBeUndefined();
});

test("rootChatTasks filters out delegated subtasks and childTaskCountMap counts descendants", () => {
  const tasks: Task[] = [
    { taskId: "root-1", name: "Main", prompt: "hi", jobName: "orchestrator" },
    {
      taskId: "child-1",
      name: "Sub 1",
      prompt: "sub",
      jobName: "worker",
      parentTaskId: "root-1",
    },
    {
      taskId: "grand-1",
      name: "Sub 2",
      prompt: "sub2",
      jobName: "worker",
      parentTaskId: "child-1",
    },
    { taskId: "root-2", name: "Second", prompt: "hey", jobName: "orchestrator" },
  ];

  expect(rootChatTasks(tasks).map((t) => t.taskId)).toEqual(["root-1", "root-2"]);
  const counts = childTaskCountMap(tasks);
  expect(counts.get("root-1")).toBe(2);
  expect(counts.get("root-2")).toBeUndefined();
});

test("toChatTitle formats the first non-empty line and truncates long prompts", () => {
  expect(toChatTitle("\n   Summarize   quarterly   report  \nMore details")).toBe(
    "Summarize quarterly report",
  );
  expect(toChatTitle("   ")).toBe("New chat");
  const long = "a".repeat(70);
  expect(toChatTitle(long)).toBe(`${"a".repeat(59)}…`);
});

test("groupChatTurns merges consecutive assistant events, pairs tool calls, and keeps segments discrete", () => {
  const events: SessionEvent[] = [
    { id: "e1", author: "user", content: { role: "user", parts: [{ text: "Analyze this" }] } },
    {
      id: "e2",
      author: "orchestrator",
      content: {
        role: "model",
        parts: [
          { text: "Checking documents first.", thought: true },
          { functionCall: { name: "search_docs", args: { q: "revenue" } } },
        ],
      },
    },
    {
      id: "e3",
      author: "user",
      content: {
        role: "user",
        parts: [{ functionResponse: { name: "search_docs", response: { hits: 2 } } }],
      },
    },
    {
      id: "e4",
      author: "orchestrator",
      timestamp: 1234,
      content: {
        role: "model",
        parts: [{ text: JSON.stringify({ answer: "Revenue grew 20%." }) }],
      },
    },
    {
      id: "e5",
      author: "orchestrator",
      errorMessage: "Rate limit warning",
      content: { role: "model", parts: [{ text: "Follow-up summary." }] },
    },
  ];

  const turns = groupChatTurns(events);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toEqual({
    id: "e1",
    kind: "user",
    text: "Analyze this",
    timestamp: undefined,
  });

  const assistant = turns[1]!;
  expect(assistant.kind).toBe("assistant");
  if (assistant.kind === "assistant") {
    expect(assistant.thoughts).toEqual(["Checking documents first."]);
    expect(assistant.tools).toEqual([
      {
        id: "e2-tool-0",
        name: "search_docs",
        args: { q: "revenue" },
        response: { hits: 2 },
        pending: false,
      },
    ]);
    expect(assistant.textSegments).toEqual([
      '{"answer":"Revenue grew 20%."}',
      "Follow-up summary.",
    ]);
    expect(assistant.errorMessage).toBe("Rate limit warning");
    expect(turnCopyText(assistant)).toBe("Revenue grew 20%.\n\nFollow-up summary.");
  }
});

test("a tool named <job>__<agent> is a delegation to that agent", () => {
  expect(parseDelegation("knowledge-agents__imdb-assistant")).toEqual({
    job: "knowledge-agents",
    agent: "imdb-assistant",
  });
  expect(parseDelegation("search_docs")).toBeUndefined();
  expect(parseDelegation("__agent")).toBeUndefined();
  expect(parseDelegation("job__")).toBeUndefined();
});

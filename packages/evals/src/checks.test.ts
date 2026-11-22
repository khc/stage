import { expect, test } from "bun:test";

import { checkTurn } from "./checks";
import type { ToolCall, Turn } from "./trace";

const turn = (toolCalls: ToolCall[] = [], answer = "", run: Turn["run"] = ok()): Turn => ({
  message: "m",
  events: [],
  toolCalls,
  answer,
  run,
});
function ok(): Turn["run"] {
  return { status: "succeeded", startedAt: 1 };
}
const call = (name: string, args: unknown = {}, response?: unknown): ToolCall => ({
  name,
  args,
  response,
});

test("no expectations pass", () => {
  expect(checkTurn(turn([call("a")]), {})).toEqual([]);
});

test("tools compares the ordered names exactly", () => {
  const t = turn([call("a"), call("b")]);
  expect(checkTurn(t, { tools: ["a", "b"] })).toEqual([]);
  const failures = checkTurn(t, { tools: ["b", "a"] });
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("b, a");
  expect(failures[0]).toContain("a, b");
});

test("toolsInclude requires every listed tool", () => {
  const t = turn([call("a")]);
  expect(checkTurn(t, { toolsInclude: ["a"] })).toEqual([]);
  expect(checkTurn(t, { toolsInclude: ["a", "b"] })[0]).toContain("b");
});

test("toolsExclude rejects a listed tool", () => {
  const t = turn([call("search_web")]);
  expect(checkTurn(t, { toolsExclude: ["query_imdb"] })).toEqual([]);
  expect(checkTurn(t, { toolsExclude: ["search_web"] })[0]).toContain("search_web");
});

test("delegatedTo reads the agent name after the job name and needs every listed agent", () => {
  const t = turn([call("stage--knowledge-agents--job-lcl__imdb-assistant")]);
  expect(checkTurn(t, { delegatedTo: ["imdb-assistant"] })).toEqual([]);
  const failures = checkTurn(t, { delegatedTo: ["imdb-assistant", "discovery-assistant"] });
  expect(failures[0]).toContain("discovery-assistant");
  expect(failures[0]).toContain("imdb-assistant");
});

test("delegatedTo ignores tools that are not agents", () => {
  const t = turn([call("search_web")]);
  expect(checkTurn(t, { delegatedTo: ["imdb-assistant"] })[0]).toContain("none");
});

test("delegatedToOneOf needs at least one listed agent", () => {
  const t = turn([call("job__discovery-assistant")]);
  expect(checkTurn(t, { delegatedToOneOf: ["imdb-assistant", "discovery-assistant"] })).toEqual([]);
  expect(checkTurn(t, { delegatedToOneOf: ["imdb-assistant"] })).toHaveLength(1);
});

test("calls matches on the whole call, response included", () => {
  const refused = call("search_web", { query: "x" }, { error: "web_search_query_required" });
  const t = turn([refused]);
  const isRefusal = {
    tool: "search_web",
    description: "was refused",
    match: (c: ToolCall) =>
      (c.response as { error?: string } | undefined)?.error === "web_search_query_required",
  };
  expect(checkTurn(t, { calls: [isRefusal] })).toEqual([]);
  const ok = turn([call("search_web", { query: "x" }, { results: [] })]);
  const failures = checkTurn(ok, { calls: [isRefusal] });
  expect(failures[0]).toContain("search_web");
  expect(failures[0]).toContain("was refused");
});

test("calls fails when the tool was never called", () => {
  const failures = checkTurn(turn(), {
    calls: [{ tool: "search_web", description: "has a query", match: () => true }],
  });
  expect(failures).toHaveLength(1);
});

test("custom failures are reported as returned", () => {
  expect(checkTurn(turn(), { custom: () => ["rule broken"] })).toEqual(["rule broken"]);
  expect(checkTurn(turn(), { custom: () => [] })).toEqual([]);
});

test("maxCalls limits the calls of a tool", () => {
  const t = turn([call("search_web"), call("search_web")]);
  expect(checkTurn(t, { maxCalls: { search_web: 2 } })).toEqual([]);
  const failures = checkTurn(t, { maxCalls: { search_web: 1 } });
  expect(failures[0]).toContain("search_web");
  expect(failures[0]).toContain("2");
});

test("answerIncludes is case-insensitive", () => {
  const t = turn([], "Directed by Michael Mann");
  expect(checkTurn(t, { answerIncludes: ["michael mann"] })).toEqual([]);
  expect(checkTurn(t, { answerIncludes: ["Scorsese"] })[0]).toContain("Scorsese");
});

test("answerMatches tests the answer against the pattern", () => {
  const t = turn([], "born in 1943");
  expect(checkTurn(t, { answerMatches: /\b1943\b/ })).toEqual([]);
  expect(checkTurn(t, { answerMatches: /\b1999\b/ })[0]).toContain("1999");
});

test("a failed run is reported with its error", () => {
  const failed: Turn["run"] = {
    status: "failed",
    startedAt: 1,
    error: "The run stopped responding",
  };
  const failures = checkTurn(turn([], "", failed), {});
  expect(failures[0]).toContain("The run stopped responding");
});

test("a failed run also reports the error an event carries", () => {
  const failed: Turn["run"] = {
    status: "failed",
    startedAt: 1,
    error: "Agent returned no final response",
  };
  const t = {
    ...turn([], "", failed),
    events: [{ errorCode: "429", errorMessage: "Resource exhausted" }],
  };
  const failures = checkTurn(t, {});
  expect(failures[0]).toContain("Agent returned no final response");
  expect(failures[0]).toContain("429");
  expect(failures[0]).toContain("Resource exhausted");
});

test("every failed check is reported", () => {
  const failures = checkTurn(turn([call("a")], "x"), {
    toolsInclude: ["b"],
    answerIncludes: ["y"],
  });
  expect(failures).toHaveLength(2);
});

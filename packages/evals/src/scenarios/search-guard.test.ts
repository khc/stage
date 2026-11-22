import { expect, test } from "bun:test";

import type { ToolCall, Turn } from "../trace";
import { prefixedSearchRules, searchGuardRules } from "./search-guard";

const turn = (toolCalls: ToolCall[], answer = ""): Turn => ({
  message: "m",
  events: [],
  toolCalls,
  answer,
  run: { status: "succeeded", startedAt: 1 },
});
const imdb: ToolCall = { name: "query_imdb", args: {}, response: { rows: [] } };
const refused: ToolCall = {
  name: "search_web",
  args: { query: "news" },
  response: { error: "web_search_query_required" },
};
const searched: ToolCall = {
  name: "search_web",
  args: { query: "news" },
  response: { results: [] },
};

test("a turn without a web search passes", () => {
  expect(searchGuardRules(turn([imdb], "The director is Michael Mann."))).toEqual([]);
});

test("a search before any internal tool is allowed", () => {
  expect(searchGuardRules(turn([searched, imdb]))).toEqual([]);
});

test("a search that ran after an internal tool returned data breaks the guard", () => {
  expect(searchGuardRules(turn([imdb, searched]))).toHaveLength(1);
});

test("a refused search after an internal tool is the guard working, and needs the prefixed-line ask", () => {
  expect(
    searchGuardRules(turn([imdb, refused], "Send 'Web search: <query>' in a new message.")),
  ).toEqual([]);
  const failures = searchGuardRules(turn([imdb, refused], "I could not find that."));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toContain("Web search:");
});

test("set_model_response is not an internal data source", () => {
  const structured: ToolCall = { name: "set_model_response", args: {}, response: {} };
  expect(searchGuardRules(turn([structured, searched]))).toEqual([]);
});

test("an internal tool whose response is an error is not asserted on, the rule covers data only", () => {
  const failed: ToolCall = { name: "query_imdb", args: {}, response: { error: "bad sql" } };
  expect(searchGuardRules(turn([failed, searched]))).toEqual([]);
});

test("prefixed line: a search that ran after an internal tool is fine", () => {
  expect(prefixedSearchRules(turn([imdb, searched]))).toEqual([]);
});

test("prefixed line: a search that failed for another reason is not a refusal", () => {
  const unavailable: ToolCall = {
    name: "search_web",
    args: {},
    response: { error: "web_search_unavailable" },
  };
  const unconfigured: ToolCall = {
    name: "search_web",
    args: {},
    response: { error: "web_search_not_configured" },
  };
  expect(prefixedSearchRules(turn([imdb, unavailable, unconfigured]))).toEqual([]);
});

test("prefixed line: a turn without a search has nothing to refuse", () => {
  expect(prefixedSearchRules(turn([imdb]))).toEqual([]);
});

test("prefixed line: every refused search is reported", () => {
  const failures = prefixedSearchRules(turn([imdb, refused, refused]));
  expect(failures).toHaveLength(2);
  expect(failures[0]).toContain("Web search:");
});

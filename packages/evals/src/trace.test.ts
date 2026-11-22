import { expect, test } from "bun:test";

import { finalAnswer, toolCalls, toTurn, type EvalEvent } from "./trace";

const call = (name: string, args: unknown = {}): EvalEvent => ({
  content: { role: "model", parts: [{ functionCall: { name, args } }] },
});
const result = (name: string, response: unknown = {}): EvalEvent => ({
  content: { role: "user", parts: [{ functionResponse: { name, response } }] },
});
const text = (value: string, extra: object = {}): EvalEvent => ({
  author: "agent",
  content: { role: "model", parts: [{ text: value, ...extra }] },
});

test("pairs each call with its response in order", () => {
  const events = [call("a", { x: 1 }), result("a", { ok: true }), call("b"), result("b", { n: 2 })];
  expect(toolCalls(events)).toEqual([
    { name: "a", args: { x: 1 }, response: { ok: true } },
    { name: "b", args: {}, response: { n: 2 } },
  ]);
});

test("pairs two calls of one tool in order", () => {
  const events = [
    call("s", { q: 1 }),
    result("s", { r: 1 }),
    call("s", { q: 2 }),
    result("s", { r: 2 }),
  ];
  expect(toolCalls(events).map((c) => c.response)).toEqual([{ r: 1 }, { r: 2 }]);
});

test("a call without a response has none", () => {
  expect(toolCalls([call("a")])).toEqual([{ name: "a", args: {} }]);
});

test("a turn with no tool calls has none", () => {
  expect(toolCalls([text("hi")])).toEqual([]);
});

test("thought parts are not the answer", () => {
  expect(finalAnswer([text("the answer"), text("thinking", { thought: true })])).toBe("the answer");
});

test("a JSON answer is unwrapped", () => {
  const json = JSON.stringify({ answer: "Michael Mann", sources: [] });
  expect(finalAnswer([text(json)])).toBe("Michael Mann");
});

test("plain text is returned as is", () => {
  expect(finalAnswer([text("plain {not json")])).toBe("plain {not json");
  expect(finalAnswer([text('{"other":1}')])).toBe('{"other":1}');
});

test("the answer is the last model text, not a user event", () => {
  const user: EvalEvent = {
    author: "user",
    content: { role: "user", parts: [{ text: "question" }] },
  };
  expect(finalAnswer([user, text("first"), text("last")])).toBe("last");
});

test("no events give an empty answer", () => {
  expect(finalAnswer([])).toBe("");
});

test("toTurn assembles the turn", () => {
  const run = { status: "succeeded" as const, startedAt: 1 };
  const events = [call("a"), result("a"), text("done")];
  expect(toTurn("hello", events, run)).toEqual({
    message: "hello",
    events,
    toolCalls: [{ name: "a", args: {}, response: {} }],
    answer: "done",
    run,
  });
});

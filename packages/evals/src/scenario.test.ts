import { expect, test } from "bun:test";

import type { Scenario } from "./run-scenario";
import { evaluate, isEvalLeftover, passRate, readSettings } from "./scenario";
import type { Trace, Turn } from "./trace";

test("passRate counts passes against the minimum", () => {
  expect(passRate([true, true, false, true, true], 0.8)).toEqual({ passes: 4, total: 5, ok: true });
  expect(passRate([true, false, false], 0.8)).toEqual({ passes: 1, total: 3, ok: false });
  expect(passRate([true, true], 1)).toEqual({ passes: 2, total: 2, ok: true });
  expect(passRate([true, false], 1).ok).toBe(false);
});

test("passRate of no runs is not a pass", () => {
  expect(passRate([], 0).ok).toBe(false);
});

test("isEvalLeftover keeps tasks that are not top-level eval tasks", () => {
  expect(isEvalLeftover({ taskId: "1", name: "eval: demo (1234)" })).toBe(true);
  expect(isEvalLeftover({ taskId: "2", name: "eval: demo (1234)", parentTaskId: "1" })).toBe(false);
  expect(isEvalLeftover({ taskId: "3", name: "other" })).toBe(false);
  expect(isEvalLeftover({ taskId: "4" })).toBe(false);
});

const turn = (answer: string): Turn => ({
  message: "m",
  events: [],
  toolCalls: [],
  answer,
  run: { status: "succeeded", startedAt: 1 },
});
const scenario: Scenario = {
  name: "demo",
  app: "knowledge",
  agent: "a",
  turns: [
    { say: "one", expect: { answerIncludes: ["alpha"] } },
    { say: "two", expect: { answerIncludes: ["beta"] } },
  ],
};
const trace = (...turns: Turn[]): Trace => ({ taskId: "t1", sessionId: "s1", turns });

test("evaluate passes when every turn passes", () => {
  expect(evaluate(scenario, trace(turn("alpha"), turn("beta")))).toEqual([]);
});

test("evaluate prefixes a failure with its turn", () => {
  const failures = evaluate(scenario, trace(turn("alpha"), turn("gamma")));
  expect(failures).toHaveLength(1);
  expect(failures[0]).toStartWith("turn 2: ");
});

test("evaluate fails the turns a failed run never reached", () => {
  const failures = evaluate(scenario, trace(turn("alpha")));
  expect(failures).toEqual(["turn 2: not run"]);
});

test("readSettings reads the environment with defaults", () => {
  expect(readSettings({})).toEqual({
    serviceUrl: "http://localhost:3000",
    env: "lcl",
    keep: false,
    clean: false,
    repeat: undefined,
    model: undefined,
  });
  expect(
    readSettings({
      SERVICE_URL: "http://x:1",
      EVAL_ENV: "dev",
      EVAL_KEEP: "1",
      EVAL_CLEAN: "1",
      EVAL_REPEAT: "3",
      EVAL_MODEL: "Inception Labs/mercury-3",
    }),
  ).toEqual({
    serviceUrl: "http://x:1",
    env: "dev",
    keep: true,
    clean: true,
    repeat: 3,
    model: { provider: "Inception Labs", model: "mercury-3" },
  });
});

test("readSettings rejects an EVAL_REPEAT that is not a positive integer", () => {
  expect(() => readSettings({ EVAL_REPEAT: "0" })).toThrow("EVAL_REPEAT");
  expect(() => readSettings({ EVAL_REPEAT: "two" })).toThrow("EVAL_REPEAT");
});

test("readSettings splits EVAL_MODEL at the first slash, so a model id may hold one", () => {
  expect(readSettings({ EVAL_MODEL: "Together/meta/llama-4" }).model).toEqual({
    provider: "Together",
    model: "meta/llama-4",
  });
});

test("readSettings rejects an EVAL_MODEL without a provider and a model", () => {
  expect(() => readSettings({ EVAL_MODEL: "mercury-3" })).toThrow("EVAL_MODEL");
  expect(() => readSettings({ EVAL_MODEL: "/mercury-3" })).toThrow("EVAL_MODEL");
  expect(() => readSettings({ EVAL_MODEL: "Inception Labs/" })).toThrow("EVAL_MODEL");
});

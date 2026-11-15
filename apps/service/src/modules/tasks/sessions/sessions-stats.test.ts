import { expect, test } from "bun:test";

import { createEvent } from "@google/adk";

import { sessionStats } from "./sessions-stats";

const usage = (usageMetadata: Record<string, number>) => createEvent({ usageMetadata });

test("sums token usage across events and counts model calls", () => {
  const events = [
    createEvent({ content: { role: "user", parts: [{ text: "hi" }] } }),
    usage({
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 5,
      cachedContentTokenCount: 40,
      totalTokenCount: 125,
    }),
    usage({
      promptTokenCount: 150,
      candidatesTokenCount: 30,
      toolUsePromptTokenCount: 10,
      totalTokenCount: 190,
    }),
  ];

  expect(sessionStats({ events })).toEqual({
    events: 3,
    llmCalls: 2,
    tokens: {
      prompt: 250,
      candidates: 50,
      thoughts: 5,
      toolUsePrompt: 10,
      cached: 40,
      total: 315,
    },
  });
});

test("an empty session has zero usage", () => {
  expect(sessionStats({ events: [] })).toEqual({
    events: 0,
    llmCalls: 0,
    tokens: {
      prompt: 0,
      candidates: 0,
      thoughts: 0,
      toolUsePrompt: 0,
      cached: 0,
      total: 0,
    },
  });
});

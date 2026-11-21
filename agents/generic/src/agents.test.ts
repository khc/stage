import { expect, test } from "bun:test";

import { describeAgents } from "@stage/agents/spec";

import { agentSet, assistantAgent, getCurrentTime } from "./agents";

test("getCurrentTime returns the city and an ISO time", async () => {
  const result = (await getCurrentTime.runAsync({
    args: { city: "Warsaw" },
    toolContext: undefined as never,
  })) as { city: string; time: string };

  expect(result.city).toBe("Warsaw");
  expect(new Date(result.time).toISOString()).toBe(result.time);
});

test("the assistant exposes getCurrentTime and is the default agent", () => {
  expect(assistantAgent.tools).toContain(getCurrentTime);
  expect(agentSet.defaultAgent).toBe("assistant");
  expect(agentSet.agents.assistant?.agent).toBe(assistantAgent);
});

test("the assistant is free-text: string input and output schemas", () => {
  const [info] = describeAgents(agentSet.agents);
  expect(info).toMatchObject({
    name: "assistant",
    description: "A simple assistant that can tell the current time.",
    inputSchema: { type: "string" },
    outputSchema: { type: "string" },
  });
  expect(info?.inputSchema).not.toHaveProperty("$schema");
});

test("the assistant supports both run modes and the document analyser stays job only", () => {
  const infos = describeAgents(agentSet.agents);
  expect(infos.find((info) => info.name === "assistant")?.modes).toEqual(["quick", "workflow"]);
  expect(infos.find((info) => info.name === "document_analyser")).not.toHaveProperty("modes");
});

import { expect, test } from "bun:test";

import { checkInput, describeAgents } from "@stage/agents/spec";

import { agentSet } from "./agents";
import { haikuAgent } from "./haiku-agent";
import { limerickAgent } from "./limerick-agent";

test("the haiku-poet agent is registered, is the default and has no tools", () => {
  expect(agentSet.agents["haiku-poet"]?.agent).toBe(haikuAgent);
  expect(agentSet.defaultAgent).toBe("haiku-poet");
  expect(haikuAgent.tools ?? []).toHaveLength(0);
  expect(haikuAgent.outputSchema).toBeDefined();
  expect(String(haikuAgent.instruction)).toContain("5, 7 and 5");
  expect(String(haikuAgent.instruction)).toContain("Markdown");
});

test("the haiku-poet agent publishes object schemas", () => {
  const [info] = describeAgents(agentSet.agents);
  expect(info).toMatchObject({
    name: "haiku-poet",
    description: "Writes a haiku about a topic.",
    inputSchema: {
      type: "object",
      required: ["topic"],
      properties: { topic: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      required: ["poem"],
      properties: { poem: { type: "string" } },
    },
  });
  expect(info?.outputSchema?.properties).toMatchObject({
    poem: { description: expect.stringContaining("Markdown") },
  });
});

test("haiku input must be JSON with a non-empty topic", () => {
  const haiku = agentSet.agents["haiku-poet"]!;
  expect(() => checkInput(haiku, '{"topic":"rain"}')).not.toThrow();
  expect(() => checkInput(haiku, "rain")).toThrow("must be JSON");
  expect(() => checkInput(haiku, "{}")).toThrow("does not match");
  expect(() => checkInput(haiku, '{"topic":""}')).toThrow("does not match");
});

test("the limerick-poet agent is registered with no tools", () => {
  expect(agentSet.agents["limerick-poet"]?.agent).toBe(limerickAgent);
  expect(limerickAgent.tools ?? []).toHaveLength(0);
  expect(String(limerickAgent.instruction)).toContain("AABBA");
});

test("every agent supports both run modes, so it can run on the app's service or as a job", () => {
  for (const info of describeAgents(agentSet.agents))
    expect(info.modes).toEqual(["quick", "workflow"]);
});

import { expect, test } from "bun:test";

import { checkInput, describeAgents } from "@agent-jobs/agents/spec";

import { agentSet } from "./agents";
import { haikuAgent } from "./haiku-agent";

test("the haiku agent is registered, is the default and has no tools", () => {
  expect(agentSet.agents.haiku?.agent).toBe(haikuAgent);
  expect(agentSet.defaultAgent).toBe("haiku");
  expect(haikuAgent.tools ?? []).toHaveLength(0);
  expect(haikuAgent.outputSchema).toBeDefined();
  expect(String(haikuAgent.instruction)).toContain("5, 7 and 5");
  expect(String(haikuAgent.instruction)).toContain("Markdown");
});

test("the haiku agent publishes object schemas", () => {
  const [info] = describeAgents(agentSet.agents);
  expect(info).toMatchObject({
    name: "haiku",
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
  const haiku = agentSet.agents.haiku!;
  expect(() => checkInput(haiku, '{"topic":"rain"}')).not.toThrow();
  expect(() => checkInput(haiku, "rain")).toThrow("must be JSON");
  expect(() => checkInput(haiku, "{}")).toThrow("does not match");
  expect(() => checkInput(haiku, '{"topic":""}')).toThrow("does not match");
});

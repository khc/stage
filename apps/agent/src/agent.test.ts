import { expect, test } from "bun:test";
import {
  agents,
  checkInput,
  describeAgents,
  getCurrentTime,
  rootAgent,
} from "./agent";
import { haikuAgent } from "./haiku-agent";

test("getCurrentTime returns the city and an ISO time", async () => {
  const result = (await getCurrentTime.runAsync({
    args: { city: "Warsaw" },
    toolContext: undefined as never,
  })) as { city: string; time: string };

  expect(result.city).toBe("Warsaw");
  expect(new Date(result.time).toISOString()).toBe(result.time);
});

test("rootAgent exposes getCurrentTime", () => {
  expect(rootAgent.tools).toContain(getCurrentTime);
});

test("the haiku agent is registered by its name and described", () => {
  expect(agents.haiku?.agent).toBe(haikuAgent);
  expect(haikuAgent.tools ?? []).toHaveLength(0);
  expect(String(haikuAgent.instruction)).toContain("5, 7 and 5");
  expect(haikuAgent.outputSchema).toBeDefined();
  expect(describeAgents().map((a) => [a.name, a.description])).toEqual([
    ["assistant", "A simple assistant that can tell the current time."],
    ["haiku", "Writes a haiku about a topic."],
  ]);
});

test("free-text agents publish string schemas and the haiku agent object schemas", () => {
  const info = Object.fromEntries(describeAgents().map((a) => [a.name, a]));
  expect(info.assistant?.inputSchema).toMatchObject({ type: "string" });
  expect(info.assistant?.outputSchema).toMatchObject({ type: "string" });
  expect(info.haiku?.inputSchema).toMatchObject({
    type: "object",
    required: ["topic"],
    properties: { topic: { type: "string" } },
  });
  expect(info.haiku?.outputSchema).toMatchObject({
    type: "object",
    required: ["poem"],
    properties: { poem: { type: "string" } },
  });
  expect(info.haiku?.inputSchema).not.toHaveProperty("$schema");
});

test("checkInput accepts any text for free-text agents and validates JSON for structured ones", () => {
  expect(() => checkInput(agents.assistant!, "anything at all")).not.toThrow();
  const haiku = agents.haiku!;
  expect(() => checkInput(haiku, '{"topic":"rain"}')).not.toThrow();
  expect(() => checkInput(haiku, "rain")).toThrow("must be JSON");
  expect(() => checkInput(haiku, "{}")).toThrow("does not match");
  expect(() => checkInput(haiku, '{"topic":""}')).toThrow("does not match");
});

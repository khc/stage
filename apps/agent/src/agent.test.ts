import { expect, test } from "bun:test";
import { agents, describeAgents, getCurrentTime, rootAgent } from "./agent";
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
  expect(describeAgents().map((a) => [a.name, a.description])).toEqual([
    ["assistant", "A simple assistant that can tell the current time."],
    ["haiku", "Answers every message with a haiku."],
  ]);
});

test("registered agents publish JSON Schema for their input and output", () => {
  for (const info of describeAgents()) {
    expect(info.inputSchema).toMatchObject({ type: "string" });
    expect(info.outputSchema).toMatchObject({ type: "string" });
    expect(info.inputSchema).not.toHaveProperty("$schema");
    expect(info.inputSchema?.description).toBeString();
  }
});

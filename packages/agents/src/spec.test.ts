import { expect, test } from "bun:test";

import { LlmAgent } from "@google/adk";
import { z } from "zod";

import { checkInput, describeAgents, type AgentSpec } from "./spec";

const agent = new LlmAgent({
  name: "fake",
  model: "fake-model",
  description: "A fake.",
});
const text: AgentSpec = {
  agent,
  inputSchema: z.string().describe("Any text."),
  outputSchema: z.string(),
};
const structured: AgentSpec = {
  agent,
  inputSchema: z.object({ n: z.number() }),
  outputSchema: z.object({ ok: z.boolean() }),
};

test("describeAgents publishes JSON Schema without $schema", () => {
  expect(describeAgents({ text, structured })).toEqual([
    {
      name: "text",
      description: "A fake.",
      inputSchema: { type: "string", description: "Any text." },
      outputSchema: { type: "string" },
    },
    {
      name: "structured",
      description: "A fake.",
      inputSchema: {
        type: "object",
        properties: { n: { type: "number" } },
        required: ["n"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  ]);
});

test("checkInput accepts any text for free-text agents and validates JSON for structured ones", () => {
  expect(() => checkInput(text, "anything at all")).not.toThrow();
  expect(() => checkInput(structured, '{"n":1}')).not.toThrow();
  expect(() => checkInput(structured, "nope")).toThrow("must be JSON");
  expect(() => checkInput(structured, '{"n":"x"}')).toThrow("does not match");
});

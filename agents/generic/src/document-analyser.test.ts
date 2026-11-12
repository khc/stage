import { expect, test } from "bun:test";

import { describeAgents } from "@stage/agents/spec";

import { agentSet } from "./agents";
import { createDocumentAnalyser, renderInstruction } from "./document-analyser";

const context = (taskId?: string) => ({ invocationContext: { session: { taskId } } }) as never;
const instructionOf = (load: Parameters<typeof createDocumentAnalyser>[0], taskId?: string) =>
  (createDocumentAnalyser(load).instruction as (c: never) => Promise<string>)(context(taskId));

test("puts every task document into the instruction", async () => {
  const docs = [
    { filename: "a.txt", contentType: "text/plain", content: "alpha" },
    { filename: "b.pdf", contentType: "application/pdf", content: "beta" },
  ];
  const text = await instructionOf(async (id) => (id === "t1" ? docs : []), "t1");
  expect(text).toBe(renderInstruction(docs));
  expect(text).toContain("# Document: a.txt (text/plain)\n\nalpha");
  expect(text).toContain("# Document: b.pdf (application/pdf)\n\nbeta");
});

test("fails clearly when the task has no documents", async () => {
  await expect(instructionOf(async () => [], "t1")).rejects.toThrow("no documents");
  await expect(
    instructionOf(async () => [{ filename: "a", contentType: "t", content: "c" }]),
  ).rejects.toThrow("no documents");
});

test("is registered with no input and the summary/category/bulletpoints output", () => {
  const info = describeAgents(agentSet.agents).find((a) => a.name === "document_analyser");
  expect(info?.inputSchema).toMatchObject({ type: "object", properties: {} });
  expect(info?.outputSchema).toMatchObject({
    type: "object",
    required: ["summary", "category", "bulletpoints"],
    properties: { bulletpoints: { type: "array", items: { type: "string" } } },
  });
});

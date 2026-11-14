import { LlmAgent } from "@google/adk";
import { createModel } from "@stage/agents/model";
import { z } from "zod";

export const limerickInput = z.object({
  topic: z.string().min(1).describe("The subject of the limerick."),
});
export const limerickOutput = z.object({
  poem: z
    .string()
    .describe(
      "The limerick as Markdown: a '## ' heading with its title, a blank line, then five lines rhyming AABBA, each ending with two spaces so the line breaks show.",
    ),
});

export const limerickAgent = new LlmAgent({
  name: "limerick-poet",
  model: createModel(process.env),
  description: "Writes a limerick about a topic.",
  instruction:
    'The message is a JSON object {"topic": string}. Write exactly one limerick about that topic: five lines rhyming AABBA, lines 1, 2 and 5 longer than lines 3 and 4. Reply with a JSON object {"poem": string}. The poem is Markdown: first a level-2 heading ("## " followed by a short title), then a blank line, then the five lines, each line ending with two spaces so Markdown keeps the line breaks. Use only that Markdown, with no quotes or commentary.',
  outputSchema: limerickOutput,
});

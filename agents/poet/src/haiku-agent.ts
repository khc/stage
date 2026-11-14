import { LlmAgent } from "@google/adk";
import { createModel } from "@stage/agents/model";
import { z } from "zod";

export const haikuInput = z.object({
  topic: z.string().min(1).describe("The subject of the haiku."),
});
export const haikuOutput = z.object({
  poem: z
    .string()
    .describe(
      "The haiku as Markdown: a '## ' heading with its title, a blank line, then three lines of 5, 7 and 5 syllables, each ending with two spaces so the line breaks show.",
    ),
});

export const haikuAgent = new LlmAgent({
  name: "haiku-poet",
  model: createModel(process.env),
  description: "Writes a haiku about a topic.",
  instruction:
    'The message is a JSON object {"topic": string}. Write exactly one haiku about that topic: three lines of 5, 7 and 5 syllables. Reply with a JSON object {"poem": string}. The poem is Markdown: first a level-2 heading ("## " followed by a short title), then a blank line, then the three lines, each line ending with two spaces so Markdown keeps the line breaks. Use only that Markdown, with no quotes or commentary.',
  outputSchema: haikuOutput,
});

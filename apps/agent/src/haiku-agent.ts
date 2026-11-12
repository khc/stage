import { LlmAgent } from "@google/adk";
import { z } from "zod";
import { createModel } from "./model";

export const haikuInput = z.object({
  topic: z.string().min(1).describe("The subject of the haiku."),
});
export const haikuOutput = z.object({
  poem: z
    .string()
    .describe(
      "One haiku: three lines of 5, 7 and 5 syllables, joined by newlines.",
    ),
});

export const haikuAgent = new LlmAgent({
  name: "haiku",
  model: createModel(process.env),
  description: "Writes a haiku about a topic.",
  instruction:
    'The message is a JSON object {"topic": string}. Write exactly one haiku about that topic: three lines of 5, 7 and 5 syllables. Reply with a JSON object {"poem": string} whose poem is the three lines joined by newline characters, with no title or commentary.',
  outputSchema: haikuOutput,
});

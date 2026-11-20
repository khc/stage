import { z } from "zod";

// The reply of the agents of this app: the answer, and what it was based on.
export const knowledgeOutput = z.object({
  answer: z.string().describe("The answer as Markdown, based only on the search results."),
  sources: z
    .array(z.string())
    .describe(
      "The chunks the answer used, each as '<source> › <doc_id> › <section_path>'. Empty when nothing relevant was found.",
    ),
});

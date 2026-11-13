import { Firestore } from "@google-cloud/firestore";
import { LlmAgent } from "@google/adk";
import { createModel } from "@stage/agents/model";
import { createLoadTaskDocuments, type LoadTaskDocuments } from "@stage/agents/task-documents";
import { z } from "zod";

// The agent reads the documents attached to its task, so the message carries nothing.
export const documentAnalyserInput = z.object({});
export const documentAnalyserOutput = z.object({
  summary: z.string().describe("A summary of the documents, as Markdown."),
  category: z.string().describe("A short category that best describes the documents."),
  bulletpoints: z.array(z.string()).describe("The key points of the documents, one per item."),
});

const instruction =
  "You analyse the documents below, which were uploaded to this task. Ignore the user message: it is empty. Reply with a JSON object {summary, category, bulletpoints}. summary is a Markdown summary of the documents; category is a short label for the kind of document or topic; bulletpoints are the key points, each one a short sentence. Base everything only on the documents.";

export const renderInstruction = (documents: Awaited<ReturnType<LoadTaskDocuments>>) =>
  [
    instruction,
    ...documents.map((d) => `# Document: ${d.filename} (${d.contentType})\n\n${d.content}`),
  ].join("\n\n");

export const createDocumentAnalyser = (load: LoadTaskDocuments) =>
  new LlmAgent({
    name: "document_analyser",
    model: createModel(process.env),
    description: "Summarises and categorises the documents uploaded to the task.",
    instruction: async (context) => {
      const { taskId } = context.invocationContext.session as { taskId?: string };
      const documents = taskId ? await load(taskId) : [];
      if (!documents.length) throw new Error("This task has no documents to analyse");
      return renderInstruction(documents);
    },
    outputSchema: documentAnalyserOutput,
  });

let db: Firestore | undefined;
export const documentAnalyserAgent = createDocumentAnalyser((taskId) =>
  createLoadTaskDocuments((db ??= new Firestore()))(taskId),
);

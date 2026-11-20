import { t } from "elysia";

import { agentName, jobName } from "../agents/agents-model";

export const TasksModel = {
  // `\S` rejects a blank name or prompt; the controller trims both.
  createBody: t.Object({
    name: t.String({ pattern: "\\S", maxLength: 200 }),
    prompt: t.String({ pattern: "\\S", maxLength: 10_000 }),
    jobName,
    agentName: t.Optional(agentName),
  }),
  params: t.Object({ taskId: t.String({ format: "uuid" }) }),
  // The body of a run that starts a session from a user message or resumes an existing one;
  // the controller trims the message.
  resume: t.Object({
    sessionId: t.Optional(t.String({ minLength: 1, maxLength: 1500 })),
    message: t.String({ pattern: "\\S", maxLength: 10_000 }),
  }),
  // Response shapes, used only to document the API.
  task: t.Object({
    taskId: t.String({ format: "uuid" }),
    name: t.Optional(t.String()),
    prompt: t.String(),
    jobName: t.Optional(t.String()),
    agentName: t.Optional(t.String()),
    documents: t.Optional(t.Array(t.Object({ documentId: t.String() }))),
  }),
  operation: t.Object({ operation: t.String(), sessionId: t.Optional(t.String()) }),
} as const;

export type TasksModel = { [K in keyof typeof TasksModel]: (typeof TasksModel)[K]["static"] };

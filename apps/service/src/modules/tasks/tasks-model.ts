import { t } from "elysia";

import { agentName, jobName } from "../agents/agents-model";

export const TasksModel = {
  // `\S` rejects a blank prompt; the controller trims it, as apps/service-deprecated does.
  createBody: t.Object({
    prompt: t.String({ pattern: "\\S", maxLength: 10_000 }),
    jobName,
    agentName: t.Optional(agentName),
  }),
  params: t.Object({ taskId: t.String({ format: "uuid" }) }),
  // The body of a run that resumes a session; the controller trims the message.
  resume: t.Object({
    sessionId: t.String({ minLength: 1, maxLength: 1500 }),
    message: t.String({ pattern: "\\S", maxLength: 10_000 }),
  }),
  // Response shapes, used only to document the API.
  task: t.Object({
    taskId: t.String({ format: "uuid" }),
    prompt: t.String(),
    jobName: t.Optional(t.String()),
    agentName: t.Optional(t.String()),
    documents: t.Optional(t.Array(t.Object({ documentId: t.String() }))),
  }),
  operation: t.Object({ operation: t.String() }),
} as const;

export type TasksModel = { [K in keyof typeof TasksModel]: (typeof TasksModel)[K]["static"] };

import { t } from "elysia";

import { agentName, jobName } from "../agents/agents-model";

export const TasksModel = {
  // `\S` rejects a blank prompt; the controller trims it, as apps/service does.
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
} as const;

export type TasksModel = { [K in keyof typeof TasksModel]: (typeof TasksModel)[K]["static"] };

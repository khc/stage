import { t, type Static } from "elysia";

import { agentName, jobName } from "../agents/agents-model";

// A model chosen on a saved provider: ids only, the key stays on the provider.
const modelRef = t.Object({
  providerId: t.String({ format: "uuid" }),
  model: t.String({ pattern: "\\S", maxLength: 200 }),
});

// How a run executes: `workflow` starts a Cloud Run job in the background; `quick` calls the job's service.
export const runMode = t.Union([t.Literal("quick"), t.Literal("workflow")]);
export type RunMode = Static<typeof runMode>;

export const TasksModel = {
  // `\S` rejects a blank name or prompt; the controller trims both.
  createBody: t.Object({
    name: t.String({ pattern: "\\S", maxLength: 200 }),
    prompt: t.String({ pattern: "\\S", maxLength: 10_000 }),
    jobName,
    agentName: t.Optional(agentName),
    defaultModel: t.Optional(modelRef),
  }),
  params: t.Object({ taskId: t.String({ format: "uuid" }) }),
  // The body of a run that starts a session from a user message or resumes an existing one;
  // the controller trims the message. `mode` picks the host, `workflow` when absent.
  resume: t.Object({
    sessionId: t.Optional(t.String({ minLength: 1, maxLength: 1500 })),
    message: t.String({ pattern: "\\S", maxLength: 10_000 }),
    // The model for this message; without one the task default, then the job default applies.
    model: t.Optional(modelRef),
    mode: t.Optional(runMode),
  }),
  // The body of a plain run that only picks the host: the task's own prompt runs.
  modeOnly: t.Object({ mode: runMode }, { additionalProperties: false }),
  // Response shapes, used only to document the API.
  task: t.Object({
    taskId: t.String({ format: "uuid" }),
    name: t.Optional(t.String()),
    prompt: t.String(),
    jobName: t.Optional(t.String()),
    agentName: t.Optional(t.String()),
    defaultModel: t.Optional(modelRef),
    // Set on a task that an agent delegated: the task and the session that caused it.
    parentTaskId: t.Optional(t.String({ format: "uuid" })),
    parentSessionId: t.Optional(t.String()),
    documents: t.Optional(t.Array(t.Object({ documentId: t.String() }))),
  }),
  operation: t.Object({ operation: t.String(), sessionId: t.Optional(t.String()) }),
} as const;

export type TasksModel = { [K in keyof typeof TasksModel]: (typeof TasksModel)[K]["static"] };

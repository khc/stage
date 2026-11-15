import { t } from "elysia";

const jobName = t.String({ pattern: "^[a-z]([-a-z0-9]*[a-z0-9])?$", maxLength: 63 });
const agentName = t.String({ pattern: "^[A-Za-z_][A-Za-z0-9_-]*$", maxLength: 64 });

export const TasksModel = {
  // `\S` rejects a blank prompt; the controller trims it, as apps/service does.
  createBody: t.Object({
    prompt: t.String({ pattern: "\\S", maxLength: 10_000 }),
    jobName,
    agentName: t.Optional(agentName),
  }),
  params: t.Object({ taskId: t.String({ format: "uuid" }) }),
} as const;

export type TasksModel = { [K in keyof typeof TasksModel]: (typeof TasksModel)[K]["static"] };

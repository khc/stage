import { t } from "elysia";

const JOB_NAME_PATTERN = "^[a-z]([-a-z0-9]*[a-z0-9])?$";
const jobName = t.String({ pattern: JOB_NAME_PATTERN, maxLength: 63 });
// A task whose job name is not a valid Cloud Run job name cannot be run.
export const isJobName = (value: string) =>
  value.length <= 63 && new RegExp(JOB_NAME_PATTERN).test(value);
const agentName = t.String({ pattern: "^[A-Za-z_][A-Za-z0-9_-]*$", maxLength: 64 });

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

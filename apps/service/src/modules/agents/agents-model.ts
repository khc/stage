import { t } from "elysia";

const JOB_NAME_PATTERN = "^[a-z]([-a-z0-9]*[a-z0-9])?$";

// A Cloud Run job name; a task whose job name is not one cannot be run.
export const jobName = t.String({ pattern: JOB_NAME_PATTERN, maxLength: 63 });
export const isJobName = (value: string) =>
  value.length <= 63 && new RegExp(JOB_NAME_PATTERN).test(value);
export const agentName = t.String({ pattern: "^[A-Za-z_][A-Za-z0-9_-]*$", maxLength: 64 });

export const AgentsModel = {
  jobParams: t.Object({ jobName }),
  agentParams: t.Object({ jobName, agentName }),
} as const;

export type AgentsModel = { [K in keyof typeof AgentsModel]: (typeof AgentsModel)[K]["static"] };

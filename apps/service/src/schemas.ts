import { z } from "zod";

const MAX_MESSAGE_LENGTH = 10_000;
const message = z.string().trim().min(1).max(MAX_MESSAGE_LENGTH);

export const jobNameSchema = z
  .string()
  .regex(/^[a-z]([-a-z0-9]*[a-z0-9])?$/)
  .max(63);
export const taskSchema = z.object({ prompt: message, jobName: jobNameSchema });
export const taskParamSchema = z.object({
  taskId: z.uuid().transform((id) => id.toLowerCase()),
});

export const sessionParamSchema = taskParamSchema.extend({
  sessionId: z.string().min(1).max(1500),
});
export const resumeSchema = z.object({
  sessionId: sessionParamSchema.shape.sessionId,
  message,
});

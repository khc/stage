import { z } from "zod";

// The A2A message metadata key under which the orchestrator names the task and session it is running
// in, so the gateway can record a delegated task as a sub-task of it.
export const A2A_PARENT_KEY = "stage:parent";

// The limit on the session id matches the one the service puts on a session id in a request.
export const parentRefSchema = z.object({
  taskId: z.uuid(),
  sessionId: z.string().min(1).max(1500),
});
export type ParentRef = z.infer<typeof parentRefSchema>;

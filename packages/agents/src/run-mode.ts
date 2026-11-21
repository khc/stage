import { z } from "zod";

// How a run is hosted: `quick` on the agent's service (the caller waits for the reply, within a
// budget), `workflow` as a Cloud Run job started in the background.
export const runModeSchema = z.enum(["quick", "workflow"]);
export type RunMode = z.infer<typeof runModeSchema>;

// The A2A message metadata key under which the orchestrator asks the gateway for a run mode.
export const A2A_MODE_KEY = "stage:mode";

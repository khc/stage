import type { Firestore } from "@google-cloud/firestore";

export type RunContract = { runId: string; prompt: string; jobName?: string };
export type GetRun = (runId: string) => Promise<RunContract | undefined>;

export const createGetRun =
  (db: Pick<Firestore, "collection">): GetRun =>
  async (runId) => {
    const doc = await db.collection("runs").doc(runId).get();
    if (!doc.exists) return undefined;
    const jobName = doc.get("jobName");
    return {
      runId: doc.id,
      prompt: doc.get("prompt"),
      ...(jobName !== undefined && { jobName }),
    };
  };

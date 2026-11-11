import type { Firestore } from "@google-cloud/firestore";
import type { RunContract } from "../run-contract";

export type { RunContract, GetRun } from "../run-contract";
export { createGetRun } from "../run-contract";

export type CreateRun = (input: {
  prompt: string;
  jobName: string;
}) => Promise<RunContract & { jobName: string }>;
export type ListRuns = () => Promise<RunContract[]>;

export const createCreateRun =
  (db: Pick<Firestore, "collection">): CreateRun =>
  async ({ prompt, jobName }) => {
    const contract = { runId: crypto.randomUUID(), prompt, jobName };
    await db.collection("runs").doc(contract.runId).create(contract);
    return contract;
  };

export const createListRuns =
  (db: Pick<Firestore, "collection">): ListRuns =>
  async () => {
    const snapshot = await db.collection("runs").get();
    return snapshot.docs.map((doc) => {
      const jobName = doc.get("jobName");
      return {
        runId: doc.id,
        prompt: doc.get("prompt"),
        ...(jobName !== undefined && { jobName }),
      };
    });
  };

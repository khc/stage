import type { Firestore } from "@google-cloud/firestore";

export type RunContract = { runId: string; prompt: string };
export type CreateRun = (prompt: string) => Promise<RunContract>;

export const createCreateRun =
  (db: Pick<Firestore, "collection">): CreateRun =>
  async (prompt) => {
    const contract = { runId: crypto.randomUUID(), prompt };
    await db.collection("runs").doc(contract.runId).create(contract);
    return contract;
  };

export type ListRuns = () => Promise<RunContract[]>;
export type GetRun = (runId: string) => Promise<RunContract | undefined>;

export const createListRuns =
  (db: Pick<Firestore, "collection">): ListRuns =>
  async () => {
    const snapshot = await db.collection("runs").get();
    return snapshot.docs.map((doc) => ({
      runId: doc.id,
      prompt: doc.get("prompt"),
    }));
  };

export const createGetRun =
  (db: Pick<Firestore, "collection">): GetRun =>
  async (runId) => {
    const doc = await db.collection("runs").doc(runId).get();
    return doc.exists
      ? { runId: doc.id, prompt: doc.get("prompt") }
      : undefined;
  };

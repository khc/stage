import type { Firestore } from "@google-cloud/firestore";

export type AgentInfo = { name: string; description?: string };
export type RegisterAgents = (
  jobName: string,
  agents: AgentInfo[],
) => Promise<void>;
export type ListAgents = (jobName: string) => Promise<AgentInfo[]>;

const COLLECTION = "agents";

// Replaces everything registered for the job, so agents removed from the
// image disappear from the registry on the next registration.
export const createRegisterAgents =
  (db: Pick<Firestore, "collection" | "batch">): RegisterAgents =>
  async (jobName, agents) => {
    const collection = db.collection(COLLECTION);
    const stored = await collection.where("jobName", "==", jobName).get();
    const keep = new Set(agents.map((agent) => agent.name));
    const batch = db.batch();
    for (const doc of stored.docs)
      if (!keep.has(doc.get("name"))) batch.delete(doc.ref);
    for (const { name, description } of agents)
      batch.set(collection.doc(`${jobName}:${name}`), {
        jobName,
        name,
        ...(description && { description }),
        registeredAt: Date.now(),
      });
    await batch.commit();
  };

export const createListAgents =
  (db: Pick<Firestore, "collection">): ListAgents =>
  async (jobName) =>
    (await db.collection(COLLECTION).where("jobName", "==", jobName).get()).docs
      .map((doc): AgentInfo => {
        const description = doc.get("description");
        return {
          name: doc.get("name"),
          ...(description !== undefined && { description }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

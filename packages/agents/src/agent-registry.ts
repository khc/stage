import type { Firestore } from "@google-cloud/firestore";

export type JsonSchema = Record<string, unknown>;
export type AgentInfo = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
};
export type RegisterAgents = (jobName: string, agents: AgentInfo[]) => Promise<void>;
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
    for (const doc of stored.docs) if (!keep.has(doc.get("name"))) batch.delete(doc.ref);
    // Schemas are stored as JSON text: Firestore restricts nested arrays and
    // some key names that JSON Schema can contain.
    for (const { name, description, inputSchema, outputSchema } of agents)
      batch.set(collection.doc(`${jobName}:${name}`), {
        jobName,
        name,
        ...(description && { description }),
        ...(inputSchema && { inputSchema: JSON.stringify(inputSchema) }),
        ...(outputSchema && { outputSchema: JSON.stringify(outputSchema) }),
        registeredAt: Date.now(),
      });
    await batch.commit();
  };

const parseSchema = (value: unknown): JsonSchema | undefined => {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as JsonSchema;
  } catch {
    return undefined;
  }
};

export const createListAgents =
  (db: Pick<Firestore, "collection">): ListAgents =>
  async (jobName) =>
    (await db.collection(COLLECTION).where("jobName", "==", jobName).get()).docs
      .map((doc): AgentInfo => {
        const description = doc.get("description");
        const inputSchema = parseSchema(doc.get("inputSchema"));
        const outputSchema = parseSchema(doc.get("outputSchema"));
        return {
          name: doc.get("name"),
          ...(description !== undefined && { description }),
          ...(inputSchema && { inputSchema }),
          ...(outputSchema && { outputSchema }),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

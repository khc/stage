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
        const info: AgentInfo = { name: doc.get("name") };
        const description = doc.get("description");
        if (description !== undefined) info.description = description;
        const inputSchema = parseSchema(doc.get("inputSchema"));
        if (inputSchema) info.inputSchema = inputSchema;
        const outputSchema = parseSchema(doc.get("outputSchema"));
        if (outputSchema) info.outputSchema = outputSchema;
        return info;
      })
      .toSorted((a, b) => a.name.localeCompare(b.name));

const mode = (schema?: JsonSchema) =>
  schema?.type === "string" || schema === undefined ? "text/plain" : "application/json";

// A registered agent as an A2A-style Agent Card: a discovery document with the
// agent's skill and its input and output modes. It carries no endpoint, because
// this service does not speak the A2A protocol; the schemas ride along under
// `x-stage` so a consumer can still build and check messages.
export const toAgentCard = (jobName: string, info: AgentInfo) => {
  const inputModes = [mode(info.inputSchema)];
  const outputModes = [mode(info.outputSchema)];
  return {
    name: info.name,
    description: info.description ?? "",
    capabilities: { streaming: true },
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills: [
      {
        id: info.name,
        name: info.name,
        description: info.description ?? "",
        tags: [jobName],
        inputModes,
        outputModes,
      },
    ],
    "x-stage": {
      jobName,
      ...(info.inputSchema && { inputSchema: info.inputSchema }),
      ...(info.outputSchema && { outputSchema: info.outputSchema }),
    },
  };
};

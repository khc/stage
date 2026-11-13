import { expect, mock, test } from "bun:test";

import { createAgentRegistry, toAgentCard } from "./agent-registry";

const registerSetup = (stored: { name: string; id: string }[]) => {
  const doc = mock((id: string) => ({ id }));
  const get = mock(async () => ({
    docs: stored.map((s) => ({
      ref: { id: s.id },
      get: (f: string) => (f === "name" ? s.name : undefined),
    })),
  }));
  const where = mock((..._args: unknown[]) => ({ get }));
  const collection = mock((_name: string) => ({ where, doc }));
  const batch = {
    set: mock((..._a: unknown[]) => {}),
    delete: mock((..._a: unknown[]) => {}),
    commit: mock(async () => {}),
  };
  return {
    db: { collection, batch: () => batch } as never,
    where,
    batch,
    collection,
  };
};

test("registers a job's agents and removes ones no longer in the image", async () => {
  const { db, where, batch, collection } = registerSetup([
    { name: "old", id: "my-job:old" },
    { name: "assistant", id: "my-job:assistant" },
  ]);

  await createAgentRegistry(db).register("my-job", [
    { name: "assistant", description: "Helps" },
    { name: "researcher" },
  ]);

  expect(collection).toHaveBeenCalledWith("agents");
  expect(where).toHaveBeenCalledWith("jobName", "==", "my-job");
  expect(batch.delete).toHaveBeenCalledTimes(1);
  expect(batch.delete).toHaveBeenCalledWith({ id: "my-job:old" });
  const sets = batch.set.mock.calls as [{ id: string }, Record<string, unknown>][];
  expect(sets.map(([ref]) => ref.id)).toEqual(["my-job:assistant", "my-job:researcher"]);
  expect(sets[0]![1]).toMatchObject({
    jobName: "my-job",
    name: "assistant",
    description: "Helps",
  });
  expect(sets[1]![1]).not.toHaveProperty("description");
  expect(batch.commit).toHaveBeenCalledTimes(1);
});

test("lists a job's agents sorted by name", async () => {
  const docs = [{ name: "b", description: "Second" }, { name: "a" }].map((d) => ({
    get: (f: string) => (d as Record<string, unknown>)[f],
  }));
  const where = mock((..._a: unknown[]) => ({ get: async () => ({ docs }) }));
  const db = { collection: () => ({ where }) } as never;

  expect(await createAgentRegistry(db as never).list("my-job")).toEqual([
    { name: "a" },
    { name: "b", description: "Second" },
  ]);
  expect(where).toHaveBeenCalledWith("jobName", "==", "my-job");
});

test("stores schemas as JSON text and parses them back when listing", async () => {
  const input = {
    type: "object",
    properties: { a: { type: "array", items: { type: "string" } } },
  };
  const { db, batch } = registerSetup([]);
  await createAgentRegistry(db).register("my-job", [
    { name: "x", inputSchema: input, outputSchema: { type: "string" } },
    { name: "y" },
  ]);
  const sets = batch.set.mock.calls as [unknown, Record<string, unknown>][];
  expect(sets[0]![1].inputSchema).toBe(JSON.stringify(input));
  expect(sets[0]![1].outputSchema).toBe('{"type":"string"}');
  expect(sets[1]![1]).not.toHaveProperty("inputSchema");

  const docs = [{ name: "x", inputSchema: JSON.stringify(input), outputSchema: "not json" }].map(
    (d) => ({ get: (f: string) => (d as Record<string, unknown>)[f] }),
  );
  const where = mock((..._a: unknown[]) => ({ get: async () => ({ docs }) }));
  const listed = await createAgentRegistry({
    collection: () => ({ where }),
  } as never).list("my-job");
  expect(listed).toEqual([{ name: "x", inputSchema: input }]);
});

test("toAgentCard describes a structured agent as one JSON skill with its schemas", () => {
  const inputSchema = { type: "object", properties: { topic: { type: "string" } } };
  const card = toAgentCard("poet-agents", {
    name: "haiku",
    description: "Writes a haiku.",
    inputSchema,
    outputSchema: { type: "object" },
  });
  expect(card).toMatchObject({
    name: "haiku",
    description: "Writes a haiku.",
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{ id: "haiku", tags: ["poet-agents"], inputModes: ["application/json"] }],
    "x-stage": { jobName: "poet-agents", inputSchema },
  });
});

test("toAgentCard treats string or missing schemas as plain text", () => {
  const card = toAgentCard("j", { name: "assistant", inputSchema: { type: "string" } });
  expect(card.defaultInputModes).toEqual(["text/plain"]);
  expect(card.defaultOutputModes).toEqual(["text/plain"]);
  expect(card.description).toBe("");
  expect(card["x-stage"]).not.toHaveProperty("outputSchema");
});

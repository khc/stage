import { expect, test } from "bun:test";

import { createLoadTaskDocuments } from "./task-documents";

const db = (refs: unknown, existing: string[]) =>
  ({
    collection: (name: string) => ({
      doc: (id: string) => (name === "tasks" ? { get: async () => ({ get: () => refs }) } : { id }),
    }),
    getAll: async (...docs: { id: string }[]) =>
      docs.map((d) => ({
        exists: existing.includes(d.id),
        get: (f: string) => `${f}:${d.id}`,
      })),
  }) as never;

test("loads the documents a task references, skipping missing ones", async () => {
  const load = createLoadTaskDocuments(db([{ documentId: "a" }, { documentId: "b" }], ["a"]));
  expect(await load("t")).toEqual([
    { filename: "filename:a", contentType: "contentType:a", content: "content:a" },
  ]);
});

test("returns no documents for a task without any", async () => {
  expect(await createLoadTaskDocuments(db(undefined, []))("t")).toEqual([]);
  expect(await createLoadTaskDocuments(db([], []))("t")).toEqual([]);
});

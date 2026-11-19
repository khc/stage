import { expect, test } from "bun:test";

import type { CatalogSink, Connector, DiscoveryBatch } from "./catalog";
import { pointId } from "./ids";
import { createIngestion } from "./ingestion";
import type { Embedder } from "./platform/embeddings-client";
import type { IndexPoint, VectorIndex } from "./platform/qdrant-client";

const chunk = (docId: string, index: number, text: string) => ({
  id: `${docId}#s:${index}`,
  docId,
  sectionId: `${docId}#s`,
  sectionPath: "Title > S",
  index,
  text,
});
const docBatch = (docId: string, texts: string[]): DiscoveryBatch => ({
  nodes: [{ id: docId, kind: "document", source: "bun", name: docId }],
  edges: [{ from: "bun", to: docId, type: "CONTAINS" }],
  chunks: texts.map((text, i) => chunk(docId, i, text)),
});

const setup = (
  batches: DiscoveryBatch[],
  options: { embedFails?: boolean; embedFailsOnCall?: number; discoverFails?: boolean } = {},
) => {
  const events: string[] = [];
  const upserts: IndexPoint[][] = [];
  const deletes: Record<string, string>[] = [];
  const embedded: string[][] = [];
  let embedCalls = 0;
  const catalogSink: CatalogSink = {
    write: async () => void events.push("write"),
    close: async () => void events.push("close"),
    abort: async () => void events.push("abort"),
  };
  const embedder: Embedder = {
    dimension: 2,
    embed: async (texts) => {
      events.push("embed");
      embedded.push(texts);
      embedCalls += 1;
      if (options.embedFails || options.embedFailsOnCall === embedCalls) {
        throw new Error("embedding server down");
      }
      return texts.map((text) => [text.length, 1]);
    },
    embedQuery: async () => [0, 0],
  };
  const vectorIndex: VectorIndex = {
    upsert: async (points) => void (events.push("upsert"), upserts.push(points)),
    search: async () => [],
    deleteWhere: async (filter) => void (events.push("delete"), deletes.push(filter)),
  };
  const connector: Connector = {
    source: "bun",
    skipped: () => [{ path: "bad.mdx", reason: "x" }],
    async *discover() {
      for (const batch of batches) yield batch;
      if (options.discoverFails) throw new Error("disk unreadable");
    },
  };
  const ingestion = createIngestion({ catalogSink, embedder, vectorIndex });
  return { ingestion, connector, events, upserts, deletes, embedded };
};

test("a document is embedded, then its old points deleted, then the new ones upserted", async () => {
  const { ingestion, connector, events, upserts, deletes, embedded } = setup([
    docBatch("bun:a.mdx", ["one", "three"]),
  ]);
  await ingestion.run(connector);
  expect(events).toEqual(["embed", "delete", "upsert", "write", "close"]);
  expect(embedded).toEqual([["one", "three"]]);
  expect(deletes).toEqual([{ source: "bun", doc_id: "bun:a.mdx" }]);
  expect(upserts).toEqual([
    [
      {
        id: pointId("bun:a.mdx#s:0"),
        vector: [3, 1],
        payload: {
          source: "bun",
          doc_id: "bun:a.mdx",
          section_id: "bun:a.mdx#s",
          section_path: "Title > S",
          chunk_index: 0,
          chunk_id: "bun:a.mdx#s:0",
          text: "one",
        },
      },
      {
        id: pointId("bun:a.mdx#s:1"),
        vector: [5, 1],
        payload: {
          source: "bun",
          doc_id: "bun:a.mdx",
          section_id: "bun:a.mdx#s",
          section_path: "Title > S",
          chunk_index: 1,
          chunk_id: "bun:a.mdx#s:1",
          text: "three",
        },
      },
    ],
  ]);
});

test("running twice produces the same deletes and upserts", async () => {
  const batches = [docBatch("bun:a.mdx", ["one"]), docBatch("bun:b.mdx", ["two", "three"])];
  const first = setup(batches);
  const second = setup(batches);
  await first.ingestion.run(first.connector);
  await second.ingestion.run(second.connector);
  expect(second.upserts).toEqual(first.upserts);
  expect(second.deletes).toEqual(first.deletes);
});

test("a failed embedding deletes nothing, writes no catalog, aborts the sink and throws", async () => {
  const { ingestion, connector, events } = setup([docBatch("bun:a.mdx", ["one"])], {
    embedFails: true,
  });
  await expect(ingestion.run(connector)).rejects.toThrow("embedding server down");
  expect(events).toEqual(["embed", "abort"]);
});

test("the sink is aborted, never closed, when the connector throws", async () => {
  const { ingestion, connector, events } = setup([docBatch("bun:a.mdx", ["one"])], {
    discoverFails: true,
  });
  await expect(ingestion.run(connector)).rejects.toThrow("disk unreadable");
  expect(events).toEqual(["embed", "delete", "upsert", "write", "abort"]);
});

test("a failure on a later document keeps the catalog uncommitted and omits that document", async () => {
  const { ingestion, connector, events, embedded } = setup(
    [docBatch("bun:a.mdx", ["one"]), docBatch("bun:b.mdx", ["two"])],
    { embedFailsOnCall: 2 },
  );
  await expect(ingestion.run(connector)).rejects.toThrow("embedding server down");
  expect(embedded).toEqual([["one"], ["two"]]);
  expect(events).toEqual(["embed", "delete", "upsert", "write", "embed", "abort"]);
});

test("a batch without chunks writes the catalog and makes no vector calls", async () => {
  const { ingestion, connector, events } = setup([
    { nodes: [{ id: "bun", kind: "source", source: "bun", name: "bun" }], edges: [] },
    { ...docBatch("bun:a.mdx", []), chunks: [] },
  ]);
  await ingestion.run(connector);
  expect(events).toEqual(["write", "write", "close"]);
});

test("the summary counts documents, nodes, edges, chunks and skipped files", async () => {
  const { ingestion, connector } = setup([
    docBatch("bun:a.mdx", ["one", "two"]),
    docBatch("bun:b.mdx", ["three"]),
  ]);
  expect(await ingestion.run(connector)).toEqual({
    documents: 2,
    nodes: 2,
    edges: 2,
    chunks: 3,
    skipped: 1,
  });
});

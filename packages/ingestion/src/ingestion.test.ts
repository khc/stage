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
  options: {
    embedFails?: boolean;
    embedFailsOnCall?: number;
    discoverFails?: boolean;
    fingerprint?: string;
    existing?: Map<string, Map<string, string | null>>;
  } = {},
) => {
  const events: string[] = [];
  const upserts: IndexPoint[][] = [];
  const deletedIds: string[][] = [];
  const listedSources: string[] = [];
  const embedded: string[][] = [];
  const store =
    options.existing ?? new Map<string, Map<string, string | null>>();
  let embedCalls = 0;
  const catalogSink: CatalogSink = {
    write: async () => void events.push("write"),
    close: async () => void events.push("close"),
    abort: async () => void events.push("abort"),
  };
  const embedder: Embedder = {
    dimension: 2,
    ...(options.fingerprint !== undefined && { fingerprint: options.fingerprint }),
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
    upsert: async (points) => {
      events.push("upsert");
      upserts.push(points);
      for (const point of points) {
        const docId = String(point.payload.doc_id);
        let docMap = store.get(docId);
        if (!docMap) {
          docMap = new Map();
          store.set(docId, docMap);
        }
        const hash = point.payload.chunk_hash;
        docMap.set(point.id, typeof hash === "string" ? hash : null);
      }
    },
    search: async () => [],
    listSourceHashes: async (source) => {
      events.push("list");
      listedSources.push(source);
      return new Map(
        [...store.entries()].map(([docId, hashes]) => [docId, new Map(hashes)]),
      );
    },
    deleteIds: async (ids) => {
      events.push("deleteIds");
      deletedIds.push(ids);
      const removed = new Set(ids);
      for (const hashes of store.values()) {
        for (const id of removed) hashes.delete(id);
      }
    },
    deleteWhere: async () => {},
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
  return { ingestion, connector, events, upserts, deletedIds, listedSources, embedded, store };
};

test("new chunks are embedded with chunk_hash and upserted once per source scroll", async () => {
  const { ingestion, connector, events, upserts, deletedIds, listedSources, embedded } = setup([
    docBatch("bun:a.mdx", ["one", "three"]),
  ]);
  await ingestion.run(connector);
  expect(listedSources).toEqual(["bun"]);
  expect(events).toEqual(["list", "embed", "upsert", "write", "close"]);
  expect(embedded).toEqual([["one", "three"]]);
  expect(deletedIds).toEqual([]);
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
          chunk_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
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
          chunk_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
          text: "three",
        },
      },
    ],
  ]);
});

test("re-running on unchanged chunks skips embed, upsert and deleteIds", async () => {
  const batches = [docBatch("bun:a.mdx", ["one"]), docBatch("bun:b.mdx", ["two", "three"])];
  const first = setup(batches, { fingerprint: "m\0" });
  await first.ingestion.run(first.connector);
  const second = setup(batches, { fingerprint: "m\0", existing: first.store });
  await second.ingestion.run(second.connector);
  expect(second.embedded).toEqual([]);
  expect(second.upserts).toEqual([]);
  expect(second.deletedIds).toEqual([]);
  expect(second.events).toEqual(["list", "write", "write", "close"]);
});

test("modifying one chunk embeds and upserts only the changed chunk", async () => {
  const first = setup([docBatch("bun:a.mdx", ["one", "two"])], { fingerprint: "m\0" });
  await first.ingestion.run(first.connector);
  const second = setup([docBatch("bun:a.mdx", ["one", "two-edited"])], {
    fingerprint: "m\0",
    existing: first.store,
  });
  await second.ingestion.run(second.connector);
  expect(second.embedded).toEqual([["two-edited"]]);
  expect(second.upserts.flat().map((p) => p.id)).toEqual([pointId("bun:a.mdx#s:1")]);
  expect(second.deletedIds).toEqual([]);
});

test("shortening a document deletes only removed point ids, including legacy points with null hash", async () => {
  const existing = new Map<string, Map<string, string | null>>([
    [
      "bun:a.mdx",
      new Map<string, string | null>([
        [pointId("bun:a.mdx#s:0"), null],
        [pointId("bun:a.mdx#s:1"), null],
      ]),
    ],
  ]);
  const { ingestion, connector, embedded, upserts, deletedIds } = setup(
    [docBatch("bun:a.mdx", ["one"])],
    { existing },
  );
  await ingestion.run(connector);
  expect(embedded).toEqual([["one"]]);
  expect(upserts.flat().map((p) => p.id)).toEqual([pointId("bun:a.mdx#s:0")]);
  expect(deletedIds).toEqual([[pointId("bun:a.mdx#s:1")]]);

  // When a document still has one unchanged chunk and lost a second chunk, embed/upsert are skipped.
  const twoChunks = setup([docBatch("bun:b.mdx", ["one", "two"])], { fingerprint: "m\0" });
  await twoChunks.ingestion.run(twoChunks.connector);
  const trimmed = setup([docBatch("bun:b.mdx", ["one"])], {
    fingerprint: "m\0",
    existing: twoChunks.store,
  });
  await trimmed.ingestion.run(trimmed.connector);
  expect(trimmed.embedded).toEqual([]);
  expect(trimmed.upserts).toEqual([]);
  expect(trimmed.deletedIds).toEqual([[pointId("bun:b.mdx#s:1")]]);
});

test("changing embedder fingerprint re-embeds unchanged text", async () => {
  const first = setup([docBatch("bun:a.mdx", ["one"])], { fingerprint: "m1\0" });
  await first.ingestion.run(first.connector);
  const second = setup([docBatch("bun:a.mdx", ["one"])], {
    fingerprint: "m2\0",
    existing: first.store,
  });
  await second.ingestion.run(second.connector);
  expect(second.embedded).toEqual([["one"]]);
  expect(second.upserts).toHaveLength(1);
});

test("a failed embedding deletes nothing, writes no catalog, aborts the sink and throws", async () => {
  const existing = new Map<string, Map<string, string | null>>([
    ["bun:a.mdx", new Map([[pointId("bun:a.mdx#s:1"), "old-hash"]])],
  ]);
  const { ingestion, connector, events, upserts, deletedIds } = setup(
    [docBatch("bun:a.mdx", ["one"])],
    { embedFails: true, existing },
  );
  await expect(ingestion.run(connector)).rejects.toThrow("embedding server down");
  expect(events).toEqual(["list", "embed", "abort"]);
  expect(upserts).toEqual([]);
  expect(deletedIds).toEqual([]);
});

test("the sink is aborted, never closed, when the connector throws", async () => {
  const { ingestion, connector, events } = setup([docBatch("bun:a.mdx", ["one"])], {
    discoverFails: true,
  });
  await expect(ingestion.run(connector)).rejects.toThrow("disk unreadable");
  expect(events).toEqual(["list", "embed", "upsert", "write", "abort"]);
});

test("a failure on a later document keeps the catalog uncommitted and omits that document", async () => {
  const { ingestion, connector, events, embedded } = setup(
    [docBatch("bun:a.mdx", ["one"]), docBatch("bun:b.mdx", ["two"])],
    { embedFailsOnCall: 2 },
  );
  await expect(ingestion.run(connector)).rejects.toThrow("embedding server down");
  expect(embedded).toEqual([["one"], ["two"]]);
  expect(events).toEqual(["list", "embed", "upsert", "write", "embed", "abort"]);
});

test("a batch without chunks writes the catalog and makes no embed, upsert or deleteIds calls", async () => {
  const { ingestion, connector, events } = setup([
    { nodes: [{ id: "bun", kind: "source", source: "bun", name: "bun" }], edges: [] },
    { ...docBatch("bun:a.mdx", []), chunks: [] },
  ]);
  await ingestion.run(connector);
  expect(events).toEqual(["list", "write", "write", "close"]);
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

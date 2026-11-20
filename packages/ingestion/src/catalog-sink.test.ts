import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CatalogEdge, CatalogNode } from "./catalog";
import {
  createJsonlCatalogSink,
  createMultiCatalogSink,
  createNeo4jCatalogSink,
} from "./catalog-sink";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "catalog-sink-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const source: CatalogNode = { id: "bun", kind: "source", source: "bun", name: "bun" };
const doc: CatalogNode = {
  id: "bun:a.mdx",
  kind: "document",
  source: "bun",
  name: "A",
  props: { title: "A", chunkIds: ["x", "y"] },
};
const contains: CatalogEdge = { from: "bun", to: "bun:a.mdx", type: "CONTAINS" };
const lines = async (path: string) =>
  (await Bun.file(path).text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("writes one json line per node and edge, nodes first, and ignores chunks", async () => {
  const path = join(dir, "catalog", "bun.jsonl");
  const sink = createJsonlCatalogSink(path);
  await sink.write({
    nodes: [source, doc],
    edges: [contains],
    chunks: [{ id: "c", docId: "d", sectionId: "s", sectionPath: "p", index: 0, text: "t" }],
  });
  await sink.close();
  expect(await lines(path)).toEqual([{ node: source }, { node: doc }, { edge: contains }]);
});

test("a node or edge written twice appears once", async () => {
  const path = join(dir, "bun.jsonl");
  const sink = createJsonlCatalogSink(path);
  await sink.write({ nodes: [source, doc], edges: [contains] });
  await sink.write({ nodes: [source], edges: [contains, { ...contains, type: "LINKS_TO" }] });
  await sink.close();
  const records = await lines(path);
  expect(records).toHaveLength(4);
  expect(records.filter((r) => "edge" in r)).toEqual([
    { edge: contains },
    { edge: { ...contains, type: "LINKS_TO" } },
  ]);
});

test("a new sink replaces what an earlier run wrote", async () => {
  const path = join(dir, "bun.jsonl");
  const first = createJsonlCatalogSink(path);
  await first.write({ nodes: [source, doc], edges: [contains] });
  await first.close();
  const second = createJsonlCatalogSink(path);
  await second.write({ nodes: [source], edges: [] });
  await second.close();
  expect(await lines(path)).toEqual([{ node: source }]);
});

test("the same input gives byte-identical files", async () => {
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  for (const path of [a, b]) {
    const sink = createJsonlCatalogSink(path);
    await sink.write({ nodes: [source, doc], edges: [contains] });
    await sink.close();
  }
  expect(await Bun.file(a).text()).toBe(await Bun.file(b).text());
});

test("closing leaves only the catalog file behind, and a sink that is never closed leaves the old file", async () => {
  const path = join(dir, "bun.jsonl");
  const first = createJsonlCatalogSink(path);
  await first.write({ nodes: [source, doc], edges: [contains] });
  await first.close();
  const abandoned = createJsonlCatalogSink(path);
  await abandoned.write({ nodes: [source], edges: [] });
  expect(await lines(path)).toHaveLength(3);
  expect(await readdir(dir)).toEqual(["bun.jsonl"]);
});

test("createNeo4jCatalogSink ensures schema once, upserts batches, and prunes only on close", async () => {
  const events: string[] = [];
  const runIds = new Set<string>();
  const sink = createNeo4jCatalogSink(
    {
      ensureSchema: async () => void events.push("schema"),
      upsertBatch: async ({ nodes, edges, runId }) => {
        runIds.add(runId);
        events.push(`upsert:${nodes.length}:${edges.length}`);
      },
      pruneSource: async (src, runId) => {
        runIds.add(runId);
        events.push(`prune:${src}`);
        return 0;
      },
    },
    "bun",
  );
  await sink.write({ nodes: [source], edges: [] });
  await sink.write({ nodes: [doc], edges: [contains, contains] });
  await sink.close();
  expect(events).toEqual(["schema", "upsert:1:0", "upsert:1:0", "upsert:0:1", "prune:bun"]);
  expect(runIds.size).toBe(1);

  const abortedEvents: string[] = [];
  const aborted = createNeo4jCatalogSink(
    {
      ensureSchema: async () => void abortedEvents.push("schema"),
      upsertBatch: async () => void abortedEvents.push("upsert"),
      pruneSource: async () => (abortedEvents.push("prune"), 0),
    },
    "bun",
  );
  await aborted.write({ nodes: [source], edges: [] });
  await aborted.abort?.();
  expect(abortedEvents).toEqual(["schema", "upsert"]);
});

test("createMultiCatalogSink forwards write, close, and abort to all sinks", async () => {
  const events: string[] = [];
  const stub = (label: string) => ({
    write: async () => void events.push(`write:${label}`),
    close: async () => void events.push(`close:${label}`),
    abort: async () => void events.push(`abort:${label}`),
  });
  const multi = createMultiCatalogSink([stub("a"), stub("b")]);
  await multi.write({ nodes: [source], edges: [] });
  await multi.close();
  await multi.abort?.();
  expect(events).toEqual(["write:a", "write:b", "close:a", "close:b", "abort:a", "abort:b"]);
});

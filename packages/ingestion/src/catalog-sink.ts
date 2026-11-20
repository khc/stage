import { rename } from "node:fs/promises";

import type { CatalogEdge, CatalogNode, CatalogSink } from "./catalog";
import type { GraphStore } from "./platform/neo4j-client";

// Writes the catalog as JSON lines, `{"node":{...}}` then `{"edge":{...}}`, when the sink is closed:
// to a temporary file first, then renamed over the target, so the file is either the old catalog or
// the new one. A sink that is never closed leaves the old file alone. A node is kept once per id
// and an edge once per (from, type, to), so a re-run replaces the file with the same bytes. Chunks
// are not part of the catalog and are ignored.
export const createJsonlCatalogSink = (path: string): CatalogSink => {
  const nodes = new Map<string, CatalogNode>();
  const edges = new Map<string, CatalogEdge>();
  return {
    async write({ nodes: newNodes, edges: newEdges }) {
      for (const node of newNodes) if (!nodes.has(node.id)) nodes.set(node.id, node);
      for (const edge of newEdges) {
        const key = `${edge.from}\u0000${edge.type}\u0000${edge.to}`;
        if (!edges.has(key)) edges.set(key, edge);
      }
    },
    async close() {
      const records = [
        ...[...nodes.values()].map((node) => ({ node })),
        ...[...edges.values()].map((edge) => ({ edge })),
      ];
      const temporary = `${path}.tmp`;
      await Bun.write(temporary, records.map((record) => `${JSON.stringify(record)}\n`).join(""));
      await rename(temporary, path);
    },
  };
};

// Persists catalog batches to Neo4j: upserts nodes per batch, buffers edges until `close` so
// forward references match existing nodes without creating orphan stubs, then prunes stale nodes/edges
// for `source`. `abort` discards buffered edges and skips pruning.
export const createNeo4jCatalogSink = (
  graphStore: Pick<GraphStore, "ensureSchema" | "upsertBatch" | "pruneSource">,
  source: string,
): CatalogSink => {
  const runId = crypto.randomUUID();
  const bufferedEdges = new Map<string, CatalogEdge>();
  let schemaEnsured: Promise<void> | undefined;

  const ensure = () =>
    (schemaEnsured ??= graphStore.ensureSchema().catch((err) => {
      schemaEnsured = undefined;
      throw err;
    }));

  return {
    async write({ nodes, edges }) {
      await ensure();
      for (const edge of edges) {
        bufferedEdges.set(`${edge.from}\u0000${edge.type}\u0000${edge.to}`, edge);
      }
      if (nodes.length === 0) return;
      await graphStore.upsertBatch({ nodes, edges: [], runId });
    },
    async close() {
      await ensure();
      if (bufferedEdges.size > 0) {
        await graphStore.upsertBatch({ nodes: [], edges: [...bufferedEdges.values()], runId });
      }
      await graphStore.pruneSource(source, runId);
    },
    async abort() {
      bufferedEdges.clear();
    },
  };
};

// Fans out catalog writes, commits and aborts to multiple sinks (e.g. JSONL + Neo4j).
export const createMultiCatalogSink = (sinks: CatalogSink[]): CatalogSink => ({
  async write(batch) {
    await Promise.all(sinks.map((sink) => sink.write(batch)));
  },
  async close() {
    await Promise.all(sinks.map((sink) => sink.close()));
  },
  async abort() {
    await Promise.all(sinks.map((sink) => sink.abort?.()));
  },
});

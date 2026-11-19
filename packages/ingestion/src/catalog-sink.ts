import { rename } from "node:fs/promises";

import type { CatalogEdge, CatalogNode, CatalogSink } from "./catalog";

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

import { FunctionTool } from "@google/adk";
import type { CatalogEdge, CatalogNode } from "@stage/ingestion/catalog";
import {
  createNeo4jStore,
  type GraphAsset,
  type GraphNeighbor,
  type GraphStore,
  type JoinPathStep,
} from "@stage/ingestion/platform/neo4j-client";
import { z } from "zod";

import { openKnowledgeBase, type KnowledgeBase } from "./knowledge-base";

const DEFAULT_NEIGHBOR_LIMIT = 25;
const MAX_LIMIT = 50;

const NODE_KINDS = [
  "source",
  "document",
  "section",
  "table",
  "column",
  "endpoint",
  "schema",
  "field",
] as const satisfies readonly CatalogNode["kind"][];

const EDGE_TYPES = [
  "CONTAINS",
  "REFERENCES",
  "LINKS_TO",
] as const satisfies readonly CatalogEdge["type"][];

export type GraphDiscovery = Pick<GraphStore, "searchAssets" | "getNeighbors" | "findJoinPath">;

const lazyOpen = <T>(open: () => Promise<T>): (() => Promise<T>) => {
  let opened: Promise<T> | undefined;
  return () =>
    (opened ??= open().catch((err) => {
      opened = undefined;
      throw err;
    }));
};

export const openGraphDiscovery = async (
  env: Record<string, string | undefined>,
  fetchFn: typeof fetch = fetch,
): Promise<GraphDiscovery> => {
  if (!env.NEO4J_URL) {
    throw new Error("NEO4J_URL is required to query the discovery graph");
  }
  return createNeo4jStore(fetchFn, {
    url: env.NEO4J_URL,
    database: env.NEO4J_DATABASE || "neo4j",
    user: env.NEO4J_USER || undefined,
    password: env.NEO4J_PASSWORD || undefined,
  });
};

const clampLimit = (limit: number | undefined, fallback: number) =>
  Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? fallback)));

export const discoverAssetsParameters = z.object({
  query: z
    .string()
    .min(1)
    .describe("Natural-language keywords, table name, column name, or topic."),
  kinds: z
    .array(z.enum(NODE_KINDS))
    .optional()
    .describe("Filter by asset kind (e.g. table, column, document, section)."),
  source: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by source name (e.g. bun, duckdb, postgres:imdb)."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Maximum results (1..50)."),
});

export const exploreAssetParameters = z.object({
  id: z
    .string()
    .min(1)
    .describe("Exact asset id returned by discover_assets or search_knowledge_base."),
  depth: z.number().int().min(1).max(2).optional().describe("Traversal hops (1 or 2)."),
  edgeTypes: z
    .array(z.enum(EDGE_TYPES))
    .optional()
    .describe("Filter edges by type: CONTAINS, REFERENCES, or LINKS_TO."),
  limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe("Maximum neighbors (1..50)."),
});

export const findJoinPathParameters = z.object({
  fromId: z
    .string()
    .min(1)
    .describe("Starting asset id (for example postgres:imdb:imdb.title_principals)."),
  toId: z
    .string()
    .min(1)
    .describe("Target asset id (for example postgres:imdb:imdb.title_ratings)."),
});

const errorResult = (err: unknown) => ({
  error: err instanceof Error ? err.message : String(err),
});

export const createDiscoverAssets = (
  openGraph: () => Promise<GraphDiscovery>,
  openKb?: () => Promise<KnowledgeBase>,
) => {
  const getGraph = lazyOpen(openGraph);
  const getKb = openKb ? lazyOpen(openKb) : undefined;

  return async ({
    query,
    kinds,
    source,
    limit,
  }: z.infer<typeof discoverAssetsParameters>): Promise<
    { assets: GraphAsset[] } | { error: string }
  > => {
    try {
      const capped = clampLimit(limit, 10);
      const graph = await getGraph();
      const graphHits = await graph.searchAssets({ query, kinds, source, limit: capped });
      const byId = new Map<string, GraphAsset>(graphHits.map((asset) => [asset.id, asset]));

      if (getKb && byId.size < capped) {
        try {
          const { embedder, vectorIndex } = await getKb();
          const vector = await embedder.embedQuery(query);
          const hits = await vectorIndex.search({
            vector,
            k: 5,
            ...(source && { filter: { source } }),
          });
          for (const { payload, score } of hits) {
            const id = String(payload.doc_id ?? "");
            if (!id || byId.has(id)) continue;
            const inferredKind: CatalogNode["kind"] = String(payload.source ?? "").startsWith(
              "postgres:",
            )
              ? "table"
              : "document";
            if (kinds && kinds.length > 0 && !kinds.includes(inferredKind)) continue;
            byId.set(id, {
              id,
              kind: inferredKind,
              source: String(payload.source ?? ""),
              name: String(payload.section_path ?? id),
              props: { semanticScore: score },
            });
            if (byId.size >= capped) break;
          }
        } catch {
          // Neo4j full-text discovery stays available even when embeddings/Qdrant are unconfigured.
        }
      }

      return { assets: [...byId.values()].slice(0, capped) };
    } catch (err) {
      return errorResult(err);
    }
  };
};

export const createExploreAsset = (openGraph: () => Promise<GraphDiscovery>) => {
  const getGraph = lazyOpen(openGraph);
  return async ({
    id,
    depth,
    edgeTypes,
    limit,
  }: z.infer<typeof exploreAssetParameters>): Promise<
    { id: string; neighbors: GraphNeighbor[] } | { error: string }
  > => {
    try {
      const graph = await getGraph();
      const boundedDepth = Math.max(1, Math.min(2, Math.trunc(depth ?? 1)));
      const neighbors = await graph.getNeighbors({
        id,
        depth: boundedDepth,
        edgeTypes,
        limit: clampLimit(limit, DEFAULT_NEIGHBOR_LIMIT),
      });
      return { id, neighbors };
    } catch (err) {
      return errorResult(err);
    }
  };
};

export const createFindJoinPath = (openGraph: () => Promise<GraphDiscovery>) => {
  const getGraph = lazyOpen(openGraph);
  return async ({
    fromId,
    toId,
  }: z.infer<typeof findJoinPathParameters>): Promise<
    { fromId: string; toId: string; steps: JoinPathStep[] } | { error: string }
  > => {
    try {
      const graph = await getGraph();
      const steps = await graph.findJoinPath({ fromId, toId, maxHops: 4 });
      return { fromId, toId, steps };
    } catch (err) {
      return errorResult(err);
    }
  };
};

const defaultGraphOpener = () => openGraphDiscovery(process.env);
const defaultKbOpener = () => openKnowledgeBase(process.env);

export const discoverAssets = new FunctionTool({
  name: "discover_assets",
  description:
    "Searches the Neo4j data-discovery graph (and Qdrant semantic summaries when configured) for tables, columns, documents, or sections matching a query.",
  parameters: discoverAssetsParameters,
  execute: createDiscoverAssets(defaultGraphOpener, defaultKbOpener),
});

export const exploreAsset = new FunctionTool({
  name: "explore_asset",
  description:
    "Traverses 1 or 2 hops from an asset id in Neo4j to inspect table columns, REFERENCES join edges, CONTAINS hierarchy, or LINKS_TO documents.",
  parameters: exploreAssetParameters,
  execute: createExploreAsset(defaultGraphOpener),
});

export const findJoinPath = new FunctionTool({
  name: "find_join_path",
  description:
    "Finds the shortest join path across REFERENCES and CONTAINS edges between two table or column asset ids in Neo4j.",
  parameters: findJoinPathParameters,
  execute: createFindJoinPath(defaultGraphOpener),
});

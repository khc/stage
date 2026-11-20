import type { CatalogEdge, CatalogNode } from "../catalog";
import { mapLimit } from "../map-limit";

export type Neo4jConfig = {
  url: string;
  database?: string;
  user?: string;
  password?: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type GraphAsset = {
  id: string;
  kind: CatalogNode["kind"];
  source: string;
  name: string;
  props: Record<string, unknown>;
};

export type GraphNeighbor = {
  asset: GraphAsset;
  relationship: string;
  direction: "outgoing" | "incoming";
  depth: number;
};

export type JoinPathStep = {
  fromId: string;
  toId: string;
  type: string;
  fromColumn?: string;
  toColumn?: string;
};

export type GraphStore = {
  ensureSchema: () => Promise<void>;
  upsertBatch: (batch: {
    nodes: CatalogNode[];
    edges: CatalogEdge[];
    runId: string;
  }) => Promise<void>;
  pruneSource: (source: string, runId: string) => Promise<number>;
  searchAssets: (query: {
    query: string;
    kinds?: CatalogNode["kind"][];
    source?: string;
    limit?: number;
  }) => Promise<GraphAsset[]>;
  getNeighbors: (query: {
    id: string;
    depth?: number;
    edgeTypes?: CatalogEdge["type"][];
    limit?: number;
  }) => Promise<GraphNeighbor[]>;
  findJoinPath: (query: {
    fromId: string;
    toId: string;
    maxHops?: number;
  }) => Promise<JoinPathStep[]>;
};

const UPSERT_SLICE = 128;
// Sequential slices avoid Neo4j lock deadlocks when edges share hub nodes (e.g. Source -> Document).
const MAX_CONCURRENT_SLICES = 1;
const MAX_TRANSIENT_RETRIES = 3;
const RETRY_BASE_MS = 50;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

const KIND_LABELS: Record<CatalogNode["kind"], string> = {
  source: "Source",
  document: "Document",
  section: "Section",
  table: "Table",
  column: "Column",
  endpoint: "Endpoint",
  schema: "Schema",
  field: "Field",
};

const EDGE_TYPES: Record<CatalogEdge["type"], string> = {
  CONTAINS: "CONTAINS",
  REFERENCES: "REFERENCES",
  LINKS_TO: "LINKS_TO",
};

const SCHEMA_STATEMENTS = [
  "CREATE CONSTRAINT asset_id_unique IF NOT EXISTS FOR (a:Asset) REQUIRE a.id IS UNIQUE",
  "CREATE INDEX asset_source_idx IF NOT EXISTS FOR (a:Asset) ON (a.source)",
  "CREATE INDEX asset_kind_idx IF NOT EXISTS FOR (a:Asset) ON (a.kind)",
  "CREATE FULLTEXT INDEX asset_search IF NOT EXISTS FOR (a:Asset) ON EACH [a.name, a.path, a.description, a.title, a.comment]",
];

type QueryApiResponse = {
  data?: { fields?: string[]; values?: unknown[][] };
  errors?: { code?: string; message?: string }[];
};

const clampLimit = (limit: number | undefined) =>
  Math.max(1, Math.min(MAX_LIMIT, Math.trunc(limit ?? DEFAULT_LIMIT)));

// Escape Lucene query-parser special characters so natural-language questions do not syntax-error.
export const toFulltextQuery = (raw: string) =>
  raw
    .trim()
    .replace(/[+\-!(){}[\]^"~*?:\\/]|&&|\|\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const chunkArray = <T>(items: T[], size: number): T[][] => {
  const slices: T[][] = [];
  for (let i = 0; i < items.length; i += size) slices.push(items.slice(i, i + size));
  return slices;
};

const stripReservedAssetProps = (props: Record<string, unknown>): Record<string, unknown> => {
  const { id: _id, kind: _kind, source: _source, name: _name, ingestRunId: _run, ...rest } = props;
  return rest;
};

const toGraphAsset = (raw: unknown): GraphAsset => {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const props =
    obj.props && typeof obj.props === "object"
      ? stripReservedAssetProps(obj.props as Record<string, unknown>)
      : {};
  return {
    id: String(obj.id ?? ""),
    kind: (obj.kind ?? "document") as CatalogNode["kind"],
    source: String(obj.source ?? ""),
    name: String(obj.name ?? ""),
    props,
  };
};

const rowsFrom = (body: QueryApiResponse): Record<string, unknown>[] => {
  const fields = body.data?.fields ?? [];
  const values = body.data?.values ?? [];
  return values.map((row) => {
    const record: Record<string, unknown> = {};
    for (const [i, field] of fields.entries()) record[field] = row[i];
    return record;
  });
};

export const createNeo4jStore = (
  fetchFn: typeof fetch,
  { url, database = "neo4j", user, password, timeoutMs = 30_000, sleep = Bun.sleep }: Neo4jConfig,
): GraphStore => {
  const endpoint = `${url.replace(/\/$/, "")}/db/${encodeURIComponent(database)}/query/v2`;
  const authHeader =
    user !== undefined || password !== undefined
      ? `Basic ${Buffer.from(`${user ?? ""}:${password ?? ""}`).toString("base64")}`
      : undefined;

  const query = async (
    statement: string,
    parameters: Record<string, unknown> = {},
    accessMode: "Read" | "Write" = "Write",
    attempt = 0,
  ): Promise<Record<string, unknown>[]> => {
    let res: Response;
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          ...(authHeader && { authorization: authHeader }),
        },
        body: JSON.stringify({
          statement,
          parameters,
          accessMode,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`neo4j query failed: ${reason}`, { cause: err });
    }
    const parsed = (await res.json().catch(() => undefined)) as QueryApiResponse | undefined;
    const neo4jError = parsed?.errors?.[0];
    if (neo4jError?.code?.startsWith("Neo.TransientError.") && attempt < MAX_TRANSIENT_RETRIES) {
      await sleep(RETRY_BASE_MS * 2 ** attempt);
      return query(statement, parameters, accessMode, attempt + 1);
    }
    if (!res.ok || neo4jError) {
      const detail = neo4jError
        ? `${neo4jError.code ? `${neo4jError.code}: ` : ""}${neo4jError.message ?? "query error"}`
        : JSON.stringify(parsed ?? {});
      throw new Error(`neo4j query failed: HTTP ${res.status}: ${detail}`);
    }
    return rowsFrom(parsed ?? {});
  };

  return {
    async ensureSchema() {
      for (const statement of SCHEMA_STATEMENTS) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await query(statement, {}, "Write");
      }
    },

    async upsertBatch({ nodes, edges, runId }) {
      const nodesByKind = new Map<CatalogNode["kind"], CatalogNode[]>();
      for (const node of nodes) {
        const list = nodesByKind.get(node.kind) ?? [];
        list.push(node);
        nodesByKind.set(node.kind, list);
      }

      for (const [kind, group] of nodesByKind.entries()) {
        if (!Object.hasOwn(KIND_LABELS, kind)) {
          throw new Error(`unknown node kind: ${String(kind)}`);
        }
        const label = KIND_LABELS[kind];
        const statement = [
          "UNWIND $rows AS row",
          "MERGE (n:Asset {id: row.id})",
          `SET n = { id: row.id, kind: row.kind, source: row.source, name: row.name, ingestRunId: $runId }`,
          `SET n:${label}, n += row.props`,
        ].join("\n");
        const slices = chunkArray(
          group.map((n) => ({
            id: n.id,
            kind: n.kind,
            source: n.source,
            name: n.name,
            props: stripReservedAssetProps(n.props ?? {}),
          })),
          UPSERT_SLICE,
        );
        // oxlint-disable-next-line eslint/no-await-in-loop
        await mapLimit(slices, MAX_CONCURRENT_SLICES, async (rows) => {
          await query(statement, { rows, runId }, "Write");
        });
      }

      const edgesByType = new Map<CatalogEdge["type"], CatalogEdge[]>();
      for (const edge of edges) {
        const list = edgesByType.get(edge.type) ?? [];
        list.push(edge);
        edgesByType.set(edge.type, list);
      }

      for (const [type, group] of edgesByType.entries()) {
        if (!Object.hasOwn(EDGE_TYPES, type)) {
          throw new Error(`unknown edge type: ${String(type)}`);
        }
        const relType = EDGE_TYPES[type];
        const statement = [
          "UNWIND $rows AS row",
          "MATCH (a:Asset {id: row.from}), (b:Asset {id: row.to})",
          `MERGE (a)-[r:${relType}]->(b)`,
          "SET r += coalesce(row.props, {}), r.ingestRunId = $runId",
        ].join("\n");
        const slices = chunkArray(
          group.map((e) => ({ from: e.from, to: e.to, props: e.props ?? {} })),
          UPSERT_SLICE,
        );
        // oxlint-disable-next-line eslint/no-await-in-loop
        await mapLimit(slices, MAX_CONCURRENT_SLICES, async (rows) => {
          await query(statement, { rows, runId }, "Write");
        });
      }
    },

    async pruneSource(source, runId) {
      await query(
        "MATCH (a:Asset {source: $source})-[r]->(:Asset) WHERE r.ingestRunId IS NULL OR r.ingestRunId <> $runId DELETE r",
        { source, runId },
        "Write",
      );
      const rows = await query(
        "MATCH (a:Asset {source: $source}) WHERE a.ingestRunId IS NULL OR a.ingestRunId <> $runId WITH a DETACH DELETE a RETURN count(a) AS deleted",
        { source, runId },
        "Write",
      );
      return Number(rows[0]?.deleted ?? 0);
    },

    async searchAssets({ query: rawQuery, kinds, source, limit }) {
      const cleaned = toFulltextQuery(rawQuery);
      if (!cleaned) return [];
      const rows = await query(
        [
          "CALL db.index.fulltext.queryNodes('asset_search', $query) YIELD node, score",
          "WHERE ($source IS NULL OR node.source = $source)",
          "  AND ($kinds IS NULL OR node.kind IN $kinds)",
          "RETURN node {.id, .kind, .source, .name, props: properties(node)} AS asset",
          "ORDER BY score DESC",
          "LIMIT $limit",
        ].join("\n"),
        {
          query: cleaned,
          source: source ?? null,
          kinds: kinds && kinds.length > 0 ? kinds : null,
          limit: clampLimit(limit),
        },
        "Read",
      );
      return rows.map((row) => toGraphAsset(row.asset));
    },

    async getNeighbors({ id, depth = 1, edgeTypes, limit }) {
      const hops = depth >= 2 ? 2 : 1;
      const rows = await query(
        [
          `MATCH p = (start:Asset {id: $id})-[*1..${hops}]-(neighbor:Asset)`,
          "WHERE neighbor.id <> $id",
          "  AND ($edgeTypes IS NULL OR ALL(rel IN relationships(p) WHERE type(rel) IN $edgeTypes))",
          "WITH neighbor, relationships(p)[-1] AS lastRel, nodes(p)[-2] AS prevNode, length(p) AS depth",
          "ORDER BY depth ASC, neighbor.id ASC",
          "WITH neighbor, collect({ rel: lastRel, prev: prevNode, depth: depth })[0] AS best",
          "RETURN neighbor {.id, .kind, .source, .name, props: properties(neighbor)} AS asset,",
          "       type(best.rel) AS relationship,",
          "       CASE WHEN startNode(best.rel).id = best.prev.id THEN 'outgoing' ELSE 'incoming' END AS direction,",
          "       best.depth AS depth",
          "ORDER BY depth ASC, neighbor.id ASC",
          "LIMIT $limit",
        ].join("\n"),
        {
          id,
          edgeTypes: edgeTypes && edgeTypes.length > 0 ? edgeTypes : null,
          limit: clampLimit(limit),
        },
        "Read",
      );
      return rows.map((row) => ({
        asset: toGraphAsset(row.asset),
        relationship: String(row.relationship ?? ""),
        direction: row.direction === "incoming" ? "incoming" : "outgoing",
        depth: Number(row.depth ?? 1),
      }));
    },

    async findJoinPath({ fromId, toId, maxHops = 4 }) {
      const bounded = Math.max(1, Math.min(6, Math.trunc(maxHops)));
      const rows = await query(
        [
          "MATCH (a:Asset {id: $fromId}), (b:Asset {id: $toId})",
          `MATCH p = shortestPath((a)-[:REFERENCES|CONTAINS*1..${bounded}]-(b))`,
          "RETURN [rel IN relationships(p) | {",
          "  fromId: startNode(rel).id,",
          "  toId: endNode(rel).id,",
          "  type: type(rel),",
          "  fromColumn: rel.fromColumn,",
          "  toColumn: rel.toColumn",
          "}] AS steps",
        ].join("\n"),
        { fromId, toId },
        "Read",
      );
      const steps = rows[0]?.steps;
      if (!Array.isArray(steps)) return [];
      return steps.map((step) => {
        const s = step as Record<string, unknown>;
        const item: JoinPathStep = {
          fromId: String(s.fromId ?? ""),
          toId: String(s.toId ?? ""),
          type: String(s.type ?? ""),
        };
        if (s.fromColumn !== undefined && s.fromColumn !== null) {
          item.fromColumn = String(s.fromColumn);
        }
        if (s.toColumn !== undefined && s.toColumn !== null) {
          item.toColumn = String(s.toColumn);
        }
        return item;
      });
    },
  };
};

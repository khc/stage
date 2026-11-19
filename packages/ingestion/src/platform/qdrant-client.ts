import { mapLimit } from "../map-limit";

type Payload = Record<string, string | number>;

export type IndexPoint = { id: string; vector: number[]; payload: Payload };

export type SearchHit = { id: string; score: number; payload: Payload };

// A vector index. Named for what it does, not for Qdrant, so a Vertex AI Vector Search backend can
// share it: filters are equality on string keys, the lowest common denominator of both.
export type VectorIndex = {
  upsert: (points: IndexPoint[]) => Promise<void>;
  search: (query: {
    vector: number[];
    k: number;
    filter?: Record<string, string>;
  }) => Promise<SearchHit[]>;
  // Returns existing `{ pointId -> chunk_hash | null }` grouped by `doc_id` for a source.
  listSourceHashes: (source: string) => Promise<Map<string, Map<string, string | null>>>;
  // Deletes specific point IDs; an empty list is a no-op.
  deleteIds: (ids: string[]) => Promise<void>;
  // Deletes every point whose payload matches all the keys; an empty filter is refused.
  deleteWhere: (filter: Record<string, string>) => Promise<void>;
};

export type QdrantConfig = {
  url: string;
  collection: string;
  dimension: number;
  // Sent as the `api-key` header, for a Qdrant that requires one.
  apiKey?: string;
  // How long one request may take; defaults to 30 seconds.
  timeoutMs?: number;
};

// Payload fields the pipeline filters on.
const INDEXED_FIELDS = ["source", "doc_id", "section_id"];
const UPSERT_SLICE = 128;
const SCROLL_LIMIT = 256;
// Upsert slices of one document that may be in flight at once.
const MAX_CONCURRENT_SLICES = 2;

type Reply = { status: number; body: unknown };

const toFilter = (filter: Record<string, string>) => ({
  must: Object.entries(filter).map(([key, value]) => ({ key, match: { value } })),
});

const errorText = (body: unknown) => {
  const error = (body as { status?: { error?: unknown } } | undefined)?.status?.error;
  return typeof error === "string" ? error : JSON.stringify(body);
};

export const createQdrantIndex = async (
  fetchFn: typeof fetch,
  { url, collection, dimension, apiKey, timeoutMs = 30_000 }: QdrantConfig,
): Promise<VectorIndex> => {
  const base = `${url.replace(/\/$/, "")}/collections/${encodeURIComponent(collection)}`;

  // Throws on a non-2xx answer unless the status is one the caller expects.
  const request = async (
    method: string,
    path: string,
    body?: unknown,
    expected: number[] = [],
  ): Promise<Reply> => {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method,
        headers: {
          ...(body !== undefined && { "content-type": "application/json" }),
          ...(apiKey && { "api-key": apiKey }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`qdrant ${method} ${path || "/"} failed: ${reason}`, { cause: err });
    }
    const parsed: unknown = await res.json().catch(() => undefined);
    if (!res.ok && !expected.includes(res.status)) {
      throw new Error(
        `qdrant ${method} ${path || "/"} failed: HTTP ${res.status}: ${errorText(parsed)}`,
      );
    }
    return { status: res.status, body: parsed };
  };

  const checkSize = (info: unknown) => {
    const vectors = (
      info as { result?: { config?: { params?: { vectors?: { size?: unknown } } } } }
    ).result?.config?.params?.vectors;
    if (typeof vectors?.size !== "number") {
      throw new Error(`collection "${collection}" has no single unnamed vector configuration`);
    }
    if (vectors.size !== dimension) {
      throw new Error(
        `collection "${collection}" has vectors of size ${vectors.size}, the embedder makes ${dimension}: a different embedding model needs a new collection`,
      );
    }
  };

  const found = await request("GET", "", undefined, [404]);
  if (found.status === 404) {
    const created = await request(
      "PUT",
      "",
      { vectors: { size: dimension, distance: "Cosine" } },
      [409],
    );
    if (created.status === 409) {
      // Another run created it first.
      checkSize((await request("GET", "")).body);
    } else {
      await Promise.all(
        INDEXED_FIELDS.map((field) =>
          request("PUT", "/index?wait=true", { field_name: field, field_schema: "keyword" }),
        ),
      );
    }
  } else {
    checkSize(found.body);
  }

  return {
    async upsert(points) {
      const slices: IndexPoint[][] = [];
      for (let i = 0; i < points.length; i += UPSERT_SLICE) {
        slices.push(points.slice(i, i + UPSERT_SLICE));
      }
      await mapLimit(slices, MAX_CONCURRENT_SLICES, (slice) =>
        request("PUT", "/points?wait=true", { points: slice }),
      );
    },
    async search({ vector, k, filter }) {
      const { body } = await request("POST", "/points/query", {
        query: vector,
        limit: k,
        with_payload: true,
        ...(filter && { filter: toFilter(filter) }),
      });
      const points = (body as { result?: { points?: SearchHit[] } }).result?.points ?? [];
      return points.map(({ id, score, payload }) => ({ id, score, payload }));
    },
    async listSourceHashes(source) {
      const byDoc = new Map<string, Map<string, string | null>>();
      let offset: unknown;
      do {
        const { body } = await request("POST", "/points/scroll", {
          filter: toFilter({ source }),
          limit: SCROLL_LIMIT,
          with_payload: ["doc_id", "chunk_hash"],
          with_vector: false,
          ...(offset !== undefined && { offset }),
        });
        const result = (
          body as {
            result?: {
              points?: { id: string | number; payload?: Payload }[];
              next_page_offset?: unknown;
            };
          }
        ).result;
        for (const point of result?.points ?? []) {
          const docId = point.payload?.doc_id;
          if (typeof docId !== "string") continue;
          let docHashes = byDoc.get(docId);
          if (!docHashes) {
            docHashes = new Map();
            byDoc.set(docId, docHashes);
          }
          const hash = point.payload?.chunk_hash;
          docHashes.set(String(point.id), typeof hash === "string" ? hash : null);
        }
        offset = result?.next_page_offset ?? undefined;
      } while (offset !== undefined);
      return byDoc;
    },
    async deleteIds(ids) {
      if (ids.length === 0) return;
      await request("POST", "/points/delete?wait=true", { points: ids });
    },
    async deleteWhere(filter) {
      if (Object.keys(filter).length === 0) throw new Error("deleteWhere needs a filter");
      await request("POST", "/points/delete?wait=true", { filter: toFilter(filter) });
    },
  };
};

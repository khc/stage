export type RerankResult = { index: number; relevanceScore: number };

export type Reranker = {
  rerank: (query: string, documents: string[], topN?: number) => Promise<RerankResult[]>;
};

export type RerankerConfig = {
  // Base URL of an OpenAI/oMLX-compatible rerank server; `/v1/rerank` is appended.
  url: string;
  model: string;
  apiKey?: string;
  // How long one request may take before it is given up and retried; defaults to 60 seconds.
  timeoutMs?: number;
  // Waits between retries; defaults to `Bun.sleep`.
  sleep?: (ms: number) => Promise<void>;
};

const MAX_RETRIES = 5;
const BACKOFF_MS = 250;
const DEFAULT_TIMEOUT_MS = 60_000;

class RetryableError extends Error {}

const sanitizeError = (text: string) => text.replace(/\p{Cc}/gu, " ").slice(0, 200);

const errorMessage = async (res: Response) => {
  const text = await res.text();
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return sanitizeError(message);
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return sanitizeError(text);
};

const toResults = (results: unknown, documentCount: number, topN?: number): RerankResult[] => {
  if (!Array.isArray(results)) throw new Error("rerank response has no results");
  const parsed = results.map((entry) => {
    const item = entry as { index?: unknown; relevance_score?: unknown };
    const index = item?.index;
    const relevanceScore = item?.relevance_score;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= documentCount
    ) {
      throw new Error(`rerank response has an invalid document index: ${String(index)}`);
    }
    if (typeof relevanceScore !== "number" || !Number.isFinite(relevanceScore)) {
      throw new Error(`rerank response has an invalid relevance_score: ${String(relevanceScore)}`);
    }
    return { index, relevanceScore };
  });

  parsed.sort((a, b) => b.relevanceScore - a.relevanceScore || a.index - b.index);
  const seen = new Set<number>();
  const unique = parsed.filter(({ index }) => !seen.has(index) && (seen.add(index), true));
  return topN === undefined ? unique : unique.slice(0, topN);
};

export const createReranker = (
  fetchFn: typeof fetch,
  { url, model, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, sleep = Bun.sleep }: RerankerConfig,
): Reranker => {
  const endpoint = `${url.replace(/\/$/, "")}/v1/rerank`;
  const headers = {
    "content-type": "application/json",
    ...(apiKey && { authorization: `Bearer ${apiKey}` }),
  };

  const post = async (query: string, documents: string[], topN?: number) => {
    let res: Response;
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          query,
          documents,
          ...(topN !== undefined && { top_n: topN }),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RetryableError(`rerank request failed: ${reason}`, { cause: err });
    }
    if (!res.ok) {
      const message = `rerank request failed: HTTP ${res.status}: ${await errorMessage(res)}`;
      throw res.status === 429 || res.status >= 500
        ? new RetryableError(message)
        : new Error(message);
    }
    const body = (await res.json()) as { results?: unknown };
    return toResults(body.results, documents.length, topN);
  };

  const send = async (
    query: string,
    documents: string[],
    topN?: number,
    attempt = 0,
  ): Promise<RerankResult[]> => {
    try {
      return await post(query, documents, topN);
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= MAX_RETRIES) throw err;
      await sleep(BACKOFF_MS * 2 ** attempt);
      return send(query, documents, topN, attempt + 1);
    }
  };

  return {
    rerank: async (query, documents, topN) => {
      if (topN !== undefined && (!Number.isInteger(topN) || topN < 0)) {
        throw new Error(`topN must be a non-negative integer, got ${topN}`);
      }
      if (documents.length === 0 || topN === 0) return [];
      return send(query, documents, topN);
    },
  };
};

const sameOrigin = (a: string, b?: string) => {
  if (!b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

// Resolves reranker settings from config/env, falling back to EMBEDDING_URL when RERANK_URL is
// unset and only sharing EMBEDDING_API_KEY with the embedding server's own origin.
export const resolveRerankerConfig = (env: {
  RERANK_URL?: string;
  RERANK_MODEL?: string;
  RERANK_API_KEY?: string;
  EMBEDDING_URL?: string;
  EMBEDDING_API_KEY?: string;
  [key: string]: unknown;
}): RerankerConfig | undefined => {
  if (!env.RERANK_MODEL) return undefined;
  const url = env.RERANK_URL || env.EMBEDDING_URL;
  if (!url) {
    throw new Error("RERANK_URL or EMBEDDING_URL is required when RERANK_MODEL is set");
  }
  const shareEmbeddingKey = !env.RERANK_URL || sameOrigin(env.RERANK_URL, env.EMBEDDING_URL);
  return {
    url,
    model: env.RERANK_MODEL,
    apiKey:
      env.RERANK_API_KEY || (shareEmbeddingKey ? env.EMBEDDING_API_KEY : undefined) || undefined,
  };
};

// Reranks arbitrary candidate items by extracted text and preserves each item with its new score.
export const rerankItems = async <T>(
  reranker: Pick<Reranker, "rerank">,
  query: string,
  items: readonly T[],
  textOf: (item: T) => string,
  topN?: number,
): Promise<{ item: T; score: number }[]> => {
  if (items.length === 0 || topN === 0) return [];
  const results = await reranker.rerank(query, items.map(textOf), topN);
  return results.map(({ index, relevanceScore }) => ({
    item: items[index]!,
    score: relevanceScore,
  }));
};

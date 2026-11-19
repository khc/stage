import { mapLimit } from "../map-limit";

export type Embedder = {
  // The length of every vector, learned from the endpoint when the embedder is created.
  dimension: number;
  // Identifies the active model and document prefix so stored chunk hashes invalidate on changes.
  fingerprint?: string;
  // Embeds documents (the document prefix is added to each text).
  embed: (texts: string[]) => Promise<number[][]>;
  // Embeds a search query (the query prefix is added).
  embedQuery: (text: string) => Promise<number[]>;
};

export type EmbedderConfig = {
  // Base URL of an OpenAI-compatible server; `/v1/embeddings` is appended.
  url: string;
  model: string;
  apiKey?: string;
  // Models like Qwen3-Embedding expect an instruction on the query only. A literal `\n` in a prefix
  // is turned into a newline, so it can be written in a `.env` file.
  documentPrefix?: string;
  queryPrefix?: string;
  // Texts per request; defaults to 32.
  batchSize?: number;
  // How long one request may take before it is given up and retried; defaults to 60 seconds.
  timeoutMs?: number;
  // Waits between retries; defaults to `Bun.sleep`.
  sleep?: (ms: number) => Promise<void>;
};

const MAX_RETRIES = 5;
// Batches of one document that may be in flight at once.
const MAX_CONCURRENT_BATCHES = 2;
const BACKOFF_MS = 250;

const unescape = (prefix: string) => prefix.replaceAll("\\n", "\n");

// A failure worth another attempt: a network error, a rate limit or a server error.
class RetryableError extends Error {}

const errorMessage = async (res: Response) => {
  const text = await res.text();
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
    if (typeof message === "string") return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text.slice(0, 200);
};

const toVectors = (data: unknown, expected: number): number[][] => {
  if (!Array.isArray(data)) throw new Error("embeddings response has no data");
  if (data.length !== expected) {
    throw new Error(`embeddings response has ${data.length} vectors for ${expected} inputs`);
  }
  const items = data as { index?: number; embedding?: unknown }[];
  return items
    .map((item, position) => ({ index: item.index ?? position, embedding: item.embedding }))
    .toSorted((a, b) => a.index - b.index)
    .map(({ embedding }) => {
      if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("embeddings response has a vector that is missing or empty");
      }
      return embedding as number[];
    });
};

export const createEmbedder = async (
  fetchFn: typeof fetch,
  {
    url,
    model,
    apiKey,
    documentPrefix = "",
    queryPrefix = "",
    batchSize = 32,
    timeoutMs = 60_000,
    sleep = Bun.sleep,
  }: EmbedderConfig,
): Promise<Embedder> => {
  const endpoint = `${url.replace(/\/$/, "")}/v1/embeddings`;
  const headers = {
    "content-type": "application/json",
    ...(apiKey && { authorization: `Bearer ${apiKey}` }),
  };
  const docPrefix = unescape(documentPrefix);
  const qPrefix = unescape(queryPrefix);

  const post = async (input: string[]): Promise<number[][]> => {
    let res: Response;
    try {
      res = await fetchFn(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RetryableError(`embeddings request failed: ${reason}`, { cause: err });
    }
    if (!res.ok) {
      const message = `embeddings request failed: HTTP ${res.status}: ${await errorMessage(res)}`;
      throw res.status === 429 || res.status >= 500
        ? new RetryableError(message)
        : new Error(message);
    }
    return toVectors(((await res.json()) as { data?: unknown }).data, input.length);
  };

  const send = async (input: string[], attempt = 0): Promise<number[][]> => {
    try {
      return await post(input);
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= MAX_RETRIES) throw err;
      await sleep(BACKOFF_MS * 2 ** attempt);
      return send(input, attempt + 1);
    }
  };

  const [probe] = await send(["dimension probe"]);
  const dimension = probe!.length;

  const embedAll = async (texts: string[]) => {
    const batches: string[][] = [];
    for (let i = 0; i < texts.length; i += batchSize) batches.push(texts.slice(i, i + batchSize));
    const vectors = (
      await mapLimit(batches, MAX_CONCURRENT_BATCHES, (batch) => send(batch))
    ).flat();
    if (vectors.some((vector) => vector.length !== dimension)) {
      throw new Error(`embeddings response has a vector that does not have dimension ${dimension}`);
    }
    return vectors;
  };

  return {
    dimension,
    fingerprint: `${model}\0${docPrefix}`,
    embed: (texts) => embedAll(texts.map((text) => `${docPrefix}${text}`)),
    embedQuery: async (text) => (await embedAll([`${qPrefix}${text}`]))[0]!,
  };
};

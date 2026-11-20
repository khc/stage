import { expect, test } from "bun:test";

import { createReranker, rerankItems, resolveRerankerConfig } from "./reranker-client";

type Call = {
  url: string;
  body: { model: string; query: string; documents: string[]; top_n?: number };
  headers: Headers;
};
type Reply = { status?: number; json?: unknown } | Error;

const server = (reply?: (call: Call, n: number) => Reply | undefined) => {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      body: JSON.parse(String(init?.body)),
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const custom = reply?.(call, calls.length);
    if (custom instanceof Error) throw custom;
    if (custom) return Response.json(custom.json ?? {}, { status: custom.status ?? 200 });
    const results = call.body.documents.map((_, index) => ({
      index,
      relevance_score: (index + 1) / 10,
    }));
    return Response.json({ model: call.body.model, results });
  }) as typeof fetch;
  return { fetchFn, calls };
};

const config = { url: "http://127.0.0.1:8000", model: "rerank-m", sleep: async () => {} };

test("trailing slash is stripped and api key is sent only when present", async () => {
  const first = server();
  await createReranker(first.fetchFn, {
    ...config,
    url: "http://h:8000/",
    apiKey: "secret",
  }).rerank("q", ["a"]);
  expect(first.calls[0]!.url).toBe("http://h:8000/v1/rerank");
  expect(first.calls[0]!.headers.get("authorization")).toBe("Bearer secret");
  expect(first.calls[0]!.headers.get("content-type")).toBe("application/json");
  expect(first.calls[0]!.body).toEqual({ model: "rerank-m", query: "q", documents: ["a"] });

  const second = server();
  await createReranker(second.fetchFn, config).rerank("q", ["a"]);
  expect(second.calls[0]!.headers.has("authorization")).toBe(false);
});

test("empty documents or zero topN returns [] without calling the server", async () => {
  const { fetchFn, calls } = server();
  const reranker = createReranker(fetchFn, config);

  expect(await reranker.rerank("q", [])).toEqual([]);
  expect(await reranker.rerank("q", ["a", "b"], 0)).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("results are sorted descending by relevance_score, deduplicated, and sliced to topN", async () => {
  const { fetchFn, calls } = server(() => ({
    json: {
      results: [
        { index: 0, relevance_score: 0.2 },
        { index: 2, relevance_score: 0.9 },
        { index: 1, relevance_score: 0.5 },
        { index: 2, relevance_score: 0.4 },
      ],
    },
  }));
  const reranker = createReranker(fetchFn, config);

  expect(await reranker.rerank("q", ["d0", "d1", "d2"], 2)).toEqual([
    { index: 2, relevanceScore: 0.9 },
    { index: 1, relevanceScore: 0.5 },
  ]);
  expect(calls[0]!.body.top_n).toBe(2);
});

test("rerankItems maps returned indices back to items and skips empty input", async () => {
  const { fetchFn, calls } = server();
  const reranker = createReranker(fetchFn, config);

  expect(await rerankItems(reranker, "q", [], (x: string) => x, 5)).toEqual([]);
  expect(calls).toHaveLength(0);

  const items = [
    { id: "a", text: "first" },
    { id: "b", text: "second" },
  ];
  expect(await rerankItems(reranker, "q", items, (x) => x.text, 1)).toEqual([
    { item: { id: "b", text: "second" }, score: 0.2 },
  ]);
});

test("rejects malformed results, out-of-range indices, and invalid scores", async () => {
  const missing = server(() => ({ json: {} }));
  await expect(createReranker(missing.fetchFn, config).rerank("q", ["a"])).rejects.toThrow(
    "no results",
  );

  const badIndex = server(() => ({ json: { results: [{ index: 3, relevance_score: 0.5 }] } }));
  await expect(createReranker(badIndex.fetchFn, config).rerank("q", ["a"])).rejects.toThrow(
    "invalid document index",
  );

  const badScore = server(() => ({ json: { results: [{ index: 0, relevance_score: "x" }] } }));
  await expect(createReranker(badScore.fetchFn, config).rerank("q", ["a"])).rejects.toThrow(
    "invalid relevance_score",
  );
});

test("retries 429, 5xx, and network errors; fails immediately on 400", async () => {
  const waits: number[] = [];
  const transient = server((_, n) => {
    if (n === 1) return { status: 429, json: { error: { message: "slow down" } } };
    if (n === 2) return { status: 503, json: { error: { message: "overloaded" } } };
    if (n === 3) return new Error("ECONNRESET");
    return undefined;
  });
  const reranker = createReranker(transient.fetchFn, {
    ...config,
    sleep: async (ms) => void waits.push(ms),
  });
  expect(await reranker.rerank("q", ["a", "b"])).toHaveLength(2);
  expect(waits).toEqual([250, 500, 1000]);

  const bad = server(() => ({ status: 400, json: { error: { message: "bad model" } } }));
  await expect(createReranker(bad.fetchFn, config).rerank("q", ["a"])).rejects.toThrow(
    "HTTP 400: bad model",
  );
  expect(bad.calls).toHaveLength(1);

  const longMsg = `${"x".repeat(250)}\u001b[31m`;
  const noisy = server(() => ({ status: 400, json: { error: { message: longMsg } } }));
  let thrown = "";
  try {
    await createReranker(noisy.fetchFn, config).rerank("q", ["a"]);
  } catch (err) {
    thrown = (err as Error).message;
  }
  expect(thrown).toBe(`rerank request failed: HTTP 400: ${"x".repeat(200)}`);
  expect(/\p{Cc}/u.test(thrown)).toBe(false);
});

test("resolveRerankerConfig only shares EMBEDDING_API_KEY on the embedding origin", () => {
  expect(
    resolveRerankerConfig({
      RERANK_MODEL: "m",
      EMBEDDING_URL: "http://127.0.0.1:8000",
      EMBEDDING_API_KEY: "emb-secret",
    }),
  ).toEqual({ url: "http://127.0.0.1:8000", model: "m", apiKey: "emb-secret" });

  expect(
    resolveRerankerConfig({
      RERANK_URL: "http://127.0.0.1:8000/",
      RERANK_MODEL: "m",
      EMBEDDING_URL: "http://127.0.0.1:8000",
      EMBEDDING_API_KEY: "emb-secret",
    }),
  ).toEqual({ url: "http://127.0.0.1:8000/", model: "m", apiKey: "emb-secret" });

  expect(
    resolveRerankerConfig({
      RERANK_URL: "http://127.0.0.1:8001",
      RERANK_MODEL: "m",
      EMBEDDING_URL: "http://127.0.0.1:8000",
      EMBEDDING_API_KEY: "emb-secret",
    }),
  ).toEqual({ url: "http://127.0.0.1:8001", model: "m", apiKey: undefined });

  expect(
    resolveRerankerConfig({
      RERANK_URL: "http://127.0.0.1:8001",
      RERANK_MODEL: "m",
      RERANK_API_KEY: "rerank-secret",
      EMBEDDING_URL: "http://127.0.0.1:8000",
      EMBEDDING_API_KEY: "emb-secret",
    }),
  ).toEqual({ url: "http://127.0.0.1:8001", model: "m", apiKey: "rerank-secret" });
});

const liveUrl = process.env.RERANK_URL || process.env.EMBEDDING_URL;
test.skipIf(!liveUrl || !process.env.RERANK_MODEL)(
  "contract: a real reranker ranks the matching document higher",
  async () => {
    const reranker = createReranker(fetch, resolveRerankerConfig(process.env)!);
    const results = await reranker.rerank("start an http server", [
      "SQLite is an embedded relational database.",
      "Bun.serve starts a fast HTTP server in TypeScript.",
    ]);
    expect(results[0]!.index).toBe(1);
    expect(results[0]!.relevanceScore).toBeGreaterThan(results[1]!.relevanceScore);
  },
);

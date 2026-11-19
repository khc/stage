import { expect, test } from "bun:test";

import { createEmbedder } from "./embeddings-client";

type Call = { url: string; body: { model: string; input: string[] }; headers: Headers };
type Reply = { status?: number; json?: unknown } | Error;

// A fake OpenAI-compatible server: by default one 3-dimension vector per input, [length, 1, 0].
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
    const data = call.body.input.map((text, index) => ({
      object: "embedding",
      index,
      embedding: [text.length, 1, 0],
    }));
    return Response.json({ object: "list", data: data.toReversed(), model: call.body.model });
  }) as typeof fetch;
  return { fetchFn, calls };
};
const config = { url: "http://127.0.0.1:8000", model: "m", sleep: async () => {} };

test("creation probes the endpoint and takes the dimension from the answer", async () => {
  const { fetchFn, calls } = server();
  const embedder = await createEmbedder(fetchFn, config);
  expect(embedder.dimension).toBe(3);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("http://127.0.0.1:8000/v1/embeddings");
  expect(calls[0]!.body.model).toBe("m");
  expect(calls[0]!.body.input).toHaveLength(1);
});

test("a trailing slash on the url is ignored and the api key is sent as a bearer token", async () => {
  const { fetchFn, calls } = server();
  await createEmbedder(fetchFn, { ...config, url: "http://h:8000/", apiKey: "secret" });
  expect(calls[0]!.url).toBe("http://h:8000/v1/embeddings");
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer secret");
  expect(calls[0]!.headers.get("content-type")).toBe("application/json");
});

test("no authorization header without an api key", async () => {
  const { fetchFn, calls } = server();
  await createEmbedder(fetchFn, config);
  expect(calls[0]!.headers.has("authorization")).toBe(false);
});

test("documents and queries get their own prefix, and a literal \\n becomes a newline", async () => {
  const { fetchFn, calls } = server();
  const embedder = await createEmbedder(fetchFn, {
    ...config,
    documentPrefix: "passage: ",
    queryPrefix: "Instruct: find it\\nQuery: ",
  });
  await embedder.embed(["a", "b"]);
  await embedder.embedQuery("q");
  expect(calls[1]!.body.input).toEqual(["passage: a", "passage: b"]);
  expect(calls[2]!.body.input).toEqual(["Instruct: find it\nQuery: q"]);
});

test("the probe is sent without a prefix", async () => {
  const { fetchFn, calls } = server();
  await createEmbedder(fetchFn, { ...config, documentPrefix: "passage: ", queryPrefix: "query: " });
  expect(calls[0]!.body.input[0]!.startsWith("passage")).toBe(false);
  expect(calls[0]!.body.input[0]!.startsWith("query")).toBe(false);
});

test("vectors are returned in input order even when the server answers in another order", async () => {
  const { fetchFn } = server();
  const embedder = await createEmbedder(fetchFn, config);
  expect(await embedder.embed(["a", "bb", "ccc"])).toEqual([
    [1, 1, 0],
    [2, 1, 0],
    [3, 1, 0],
  ]);
  expect(await embedder.embedQuery("four")).toEqual([4, 1, 0]);
});

test("texts are sent in batches and the order is kept", async () => {
  const { fetchFn, calls } = server();
  const embedder = await createEmbedder(fetchFn, { ...config, batchSize: 32 });
  const texts = Array.from({ length: 70 }, (_, i) => "x".repeat(i + 1));
  const vectors = await embedder.embed(texts);
  expect(calls.slice(1).map((c) => c.body.input.length)).toEqual([32, 32, 6]);
  expect(vectors.map((v) => v[0])).toEqual(texts.map((t) => t.length));
});

test("embedding nothing makes no request", async () => {
  const { fetchFn, calls } = server();
  const embedder = await createEmbedder(fetchFn, config);
  expect(await embedder.embed([])).toEqual([]);
  expect(calls).toHaveLength(1);
});

test("a rate limit, a server error and a network error are retried with a growing delay", async () => {
  const waits: number[] = [];
  const { fetchFn, calls } = server((_call, n) => {
    if (n === 2) return { status: 429, json: { error: { message: "slow down" } } };
    if (n === 3) return { status: 503, json: {} };
    if (n === 4) return new TypeError("fetch failed");
    return undefined;
  });
  const embedder = await createEmbedder(fetchFn, {
    ...config,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  expect(await embedder.embed(["a"])).toEqual([[1, 1, 0]]);
  expect(calls).toHaveLength(5);
  expect(waits).toHaveLength(3);
  expect(waits[1]!).toBeGreaterThan(waits[0]!);
  expect(waits[2]!).toBeGreaterThan(waits[1]!);
});

test("retries stop after five and the last error is thrown", async () => {
  const { fetchFn, calls } = server((_call, n) =>
    n === 1 ? undefined : { status: 503, json: { error: { message: "overloaded" } } },
  );
  const embedder = await createEmbedder(fetchFn, config);
  await expect(embedder.embed(["a"])).rejects.toThrow("overloaded");
  expect(calls).toHaveLength(1 + 6);
});

test("a client error is not retried and carries the server's message", async () => {
  const { fetchFn, calls } = server(() => ({
    status: 404,
    json: {
      error: { message: "Model 'x' not found. Available models: m", type: "not_found_error" },
    },
  }));
  const failure = createEmbedder(fetchFn, config);
  await expect(failure).rejects.toThrow("HTTP 404");
  await expect(failure).rejects.toThrow("Model 'x' not found");
  expect(calls).toHaveLength(1);
});

test("an answer with the wrong number of vectors or the wrong length is rejected", async () => {
  const short = server((call, n) =>
    n === 1 ? undefined : { json: { data: [{ index: 0, embedding: [1, 1, 0] }] } },
  );
  const embedder = await createEmbedder(short.fetchFn, config);
  await expect(embedder.embed(["a", "b"])).rejects.toThrow("2");

  const odd = server((call, n) =>
    n === 1 ? undefined : { json: { data: [{ index: 0, embedding: [1, 2] }] } },
  );
  const other = await createEmbedder(odd.fetchFn, config);
  await expect(other.embed(["a"])).rejects.toThrow("dimension");
});

test("every request carries a timeout signal, and a request that never answers is retried then fails", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  await expect(createEmbedder(hanging, { ...config, timeoutMs: 15 })).rejects.toThrow("timed out");
  expect(signals).toHaveLength(6);
  expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
});

test("at most two batches are in flight at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const { fetchFn: inner } = server();
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(5);
    inFlight -= 1;
    return inner(input, init);
  }) as typeof fetch;
  const embedder = await createEmbedder(slow, { ...config, batchSize: 1 });
  peak = 0;
  await embedder.embed(["a", "b", "c", "d", "e", "f"]);
  expect(peak).toBe(2);
});

test.skipIf(!process.env.EMBEDDING_URL || !process.env.EMBEDDING_MODEL)(
  "contract: a real endpoint returns stable, fixed-size vectors",
  async () => {
    const embedder = await createEmbedder(fetch, {
      url: process.env.EMBEDDING_URL!,
      model: process.env.EMBEDDING_MODEL!,
      apiKey: process.env.EMBEDDING_API_KEY,
    });
    expect(embedder.dimension).toBeGreaterThan(0);
    const [first, second] = await embedder.embed(["start an http server", "read a parquet file"]);
    expect(first).toHaveLength(embedder.dimension);
    expect(second).toHaveLength(embedder.dimension);
    expect((await embedder.embedQuery("start an http server")).length).toBe(embedder.dimension);
  },
);

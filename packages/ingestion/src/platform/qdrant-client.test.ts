import { afterAll, expect, test } from "bun:test";

import { createQdrantIndex, type IndexPoint } from "./qdrant-client";

type Call = { method: string; url: string; body?: unknown };
type Reply = { status?: number; json?: unknown };

// A scripted fake: `reply` sees each call and may answer; the default is a 200 `ok`.
const server = (reply: (call: Call, n: number) => Reply | undefined) => {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const custom = reply(call, calls.length) ?? { json: { result: true, status: "ok" } };
    return Response.json(custom.json ?? {}, { status: custom.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
};
const collectionInfo = (size: number) => ({
  result: { config: { params: { vectors: { size, distance: "Cosine" } } } },
  status: "ok",
});
const config = { url: "http://127.0.0.1:6333", collection: "docs", dimension: 4 };
const existing = (size = 4) =>
  server((call) => (call.method === "GET" ? { json: collectionInfo(size) } : undefined));

test("a missing collection is created with cosine distance and keyword payload indexes", async () => {
  const { fetchFn, calls } = server((call) =>
    call.method === "GET" ? { status: 404, json: { status: { error: "Not found" } } } : undefined,
  );
  await createQdrantIndex(fetchFn, config);
  expect(calls[0]).toMatchObject({ method: "GET", url: "http://127.0.0.1:6333/collections/docs" });
  expect(calls[1]).toMatchObject({
    method: "PUT",
    url: "http://127.0.0.1:6333/collections/docs",
    body: { vectors: { size: 4, distance: "Cosine" } },
  });
  expect(calls.slice(2)).toEqual([
    {
      method: "PUT",
      url: "http://127.0.0.1:6333/collections/docs/index?wait=true",
      body: { field_name: "source", field_schema: "keyword" },
    },
    {
      method: "PUT",
      url: "http://127.0.0.1:6333/collections/docs/index?wait=true",
      body: { field_name: "doc_id", field_schema: "keyword" },
    },
    {
      method: "PUT",
      url: "http://127.0.0.1:6333/collections/docs/index?wait=true",
      body: { field_name: "section_id", field_schema: "keyword" },
    },
  ]);
});

test("an existing collection of the same size is left alone", async () => {
  const { fetchFn, calls } = existing(4);
  await createQdrantIndex(fetchFn, config);
  expect(calls.map((c) => c.method)).toEqual(["GET"]);
});

test("an existing collection of another size is rejected: a new model needs a new collection", async () => {
  const { fetchFn, calls } = existing(1024);
  await expect(createQdrantIndex(fetchFn, config)).rejects.toThrow(/1024.*4|new collection/s);
  expect(calls).toHaveLength(1);
});

test("a create that loses a race (409) re-reads the collection and creates no indexes", async () => {
  let gets = 0;
  const { fetchFn, calls } = server((call) => {
    if (call.method === "GET") {
      return ++gets === 1 ? { status: 404, json: {} } : { json: collectionInfo(4) };
    }
    if (call.method === "PUT")
      return { status: 409, json: { status: { error: "already exists" } } };
    return undefined;
  });
  await createQdrantIndex(fetchFn, config);
  expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
});

test("the collection name is encoded and a trailing slash on the url is ignored", async () => {
  const { fetchFn, calls } = existing();
  await createQdrantIndex(fetchFn, { ...config, url: "http://q:6333/", collection: "my docs" });
  expect(calls[0]!.url).toBe("http://q:6333/collections/my%20docs");
});

test("upsert waits for the write and sends id, vector and payload", async () => {
  const { fetchFn, calls } = existing();
  const index = await createQdrantIndex(fetchFn, config);
  const point: IndexPoint = {
    id: "6f1c2d0e-1b3a-5c4d-8e9f-0a1b2c3d4e5f",
    vector: [1, 0, 0, 0],
    payload: { source: "bun", chunk_index: 0 },
  };
  await index.upsert([point]);
  expect(calls[1]).toEqual({
    method: "PUT",
    url: "http://127.0.0.1:6333/collections/docs/points?wait=true",
    body: { points: [point] },
  });
});

test("upsert of nothing makes no request and a large upsert is sent in slices", async () => {
  const { fetchFn, calls } = existing();
  const index = await createQdrantIndex(fetchFn, config);
  await index.upsert([]);
  expect(calls).toHaveLength(1);
  const points = Array.from({ length: 300 }, (_, i) => ({
    id: `00000000-0000-5000-8000-${String(i).padStart(12, "0")}`,
    vector: [1, 0, 0, 0],
    payload: {},
  }));
  await index.upsert(points);
  const sent = calls.slice(1).map((c) => (c.body as { points: unknown[] }).points.length);
  expect(sent.reduce((a, b) => a + b, 0)).toBe(300);
  expect(sent.every((n) => n <= 128)).toBe(true);
});

test("search maps equality filters to must conditions and returns id, score and payload", async () => {
  const { fetchFn, calls } = server((call) => {
    if (call.method === "GET") return { json: collectionInfo(4) };
    return {
      json: {
        result: {
          points: [{ id: "a", version: 2, score: 0.9, payload: { doc_id: "bun:x", text: "t" } }],
        },
        status: "ok",
      },
    };
  });
  const index = await createQdrantIndex(fetchFn, config);
  const hits = await index.search({ vector: [1, 0, 0, 0], k: 3, filter: { source: "bun" } });
  expect(hits).toEqual([{ id: "a", score: 0.9, payload: { doc_id: "bun:x", text: "t" } }]);
  expect(calls[1]).toEqual({
    method: "POST",
    url: "http://127.0.0.1:6333/collections/docs/points/query",
    body: {
      query: [1, 0, 0, 0],
      limit: 3,
      with_payload: true,
      filter: { must: [{ key: "source", match: { value: "bun" } }] },
    },
  });
  await index.search({ vector: [1, 0, 0, 0], k: 1 });
  expect(calls[2]!.body).toEqual({ query: [1, 0, 0, 0], limit: 1, with_payload: true });
});

test("deleteWhere deletes by all the filter keys and waits", async () => {
  const { fetchFn, calls } = existing();
  const index = await createQdrantIndex(fetchFn, config);
  await index.deleteWhere({ source: "bun", doc_id: "bun:a.mdx" });
  expect(calls[1]).toEqual({
    method: "POST",
    url: "http://127.0.0.1:6333/collections/docs/points/delete?wait=true",
    body: {
      filter: {
        must: [
          { key: "source", match: { value: "bun" } },
          { key: "doc_id", match: { value: "bun:a.mdx" } },
        ],
      },
    },
  });
});

test("deleteWhere without a filter is refused instead of deleting everything", async () => {
  const { fetchFn, calls } = existing();
  const index = await createQdrantIndex(fetchFn, config);
  await expect(index.deleteWhere({})).rejects.toThrow("filter");
  expect(calls).toHaveLength(1);
});

test("an error response is thrown with Qdrant's message", async () => {
  const { fetchFn } = server((call) => {
    if (call.method === "GET") return { json: collectionInfo(4) };
    return {
      status: 400,
      json: { status: { error: "Wrong input: Vector dimension error: expected dim: 4, got 3" } },
    };
  });
  const index = await createQdrantIndex(fetchFn, config);
  const failure = index.upsert([{ id: "a", vector: [1, 0, 0], payload: {} }]);
  await expect(failure).rejects.toThrow("HTTP 400");
  await expect(failure).rejects.toThrow("expected dim: 4, got 3");
});

test("an api key is sent as the api-key header on every request, and not without one", async () => {
  const seen: Headers[] = [];
  const record = (info: ReturnType<typeof existing>) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return info.fetchFn(input, init);
    }) as typeof fetch;
  const secured = await createQdrantIndex(record(existing()), { ...config, apiKey: "k1" });
  await secured.upsert([{ id: "a", vector: [1, 0, 0, 0], payload: {} }]);
  await secured.search({ vector: [1, 0, 0, 0], k: 1 });
  expect(seen).toHaveLength(3);
  expect(seen.every((headers) => headers.get("api-key") === "k1")).toBe(true);
  expect(seen[1]!.get("content-type")).toBe("application/json");
  seen.length = 0;
  await createQdrantIndex(record(existing()), config);
  expect(seen[0]!.has("api-key")).toBe(false);
});

test("every request carries a timeout signal, and one that never answers fails with a clear message", async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const hanging = (async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal ?? undefined);
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
  await expect(createQdrantIndex(hanging, { ...config, timeoutMs: 15 })).rejects.toThrow(
    /qdrant GET .*timed out/,
  );
  expect(signals[0]).toBeInstanceOf(AbortSignal);
});

test("at most two upsert slices are in flight at once", async () => {
  let inFlight = 0;
  let peak = 0;
  const base = existing();
  const slow = (async (input: string | URL | Request, init?: RequestInit) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(5);
    inFlight -= 1;
    return base.fetchFn(input, init);
  }) as typeof fetch;
  const index = await createQdrantIndex(slow, config);
  peak = 0;
  const points = Array.from({ length: 128 * 5 }, (_, i) => ({
    id: `00000000-0000-5000-8000-${String(i).padStart(12, "0")}`,
    vector: [1, 0, 0, 0],
    payload: {},
  }));
  await index.upsert(points);
  expect(peak).toBe(2);
});

const live = process.env.QDRANT_URL;
const collection = `ingestion-test-${crypto.randomUUID()}`;
afterAll(async () => {
  if (live) await fetch(`${live}/collections/${collection}`, { method: "DELETE" });
});

test.skipIf(!live)(
  "contract: upsert, search with and without a filter, and deleteWhere",
  async () => {
    const index = await createQdrantIndex(fetch, {
      url: live!,
      collection,
      dimension: 4,
      apiKey: process.env.QDRANT_API_KEY,
    });
    const id = (n: number) => `00000000-0000-5000-8000-${String(n).padStart(12, "0")}`;
    await index.upsert([
      { id: id(1), vector: [1, 0, 0, 0], payload: { source: "bun", doc_id: "bun:a", text: "a" } },
      {
        id: id(2),
        vector: [0.9, 0.1, 0, 0],
        payload: { source: "bun", doc_id: "bun:b", text: "b" },
      },
      {
        id: id(3),
        vector: [0, 1, 0, 0],
        payload: { source: "duckdb", doc_id: "duckdb:c", text: "c" },
      },
    ]);
    const all = await index.search({ vector: [1, 0, 0, 0], k: 3 });
    expect(all.map((hit) => hit.id)).toEqual([id(1), id(2), id(3)]);
    const duck = await index.search({ vector: [1, 0, 0, 0], k: 3, filter: { source: "duckdb" } });
    expect(duck.map((hit) => hit.payload.doc_id)).toEqual(["duckdb:c"]);
    await index.deleteWhere({ source: "bun", doc_id: "bun:a" });
    const rest = await index.search({ vector: [1, 0, 0, 0], k: 3 });
    expect(rest.map((hit) => hit.id)).toEqual([id(2), id(3)]);
  },
);

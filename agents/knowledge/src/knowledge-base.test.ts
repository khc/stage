import { afterAll, beforeAll, expect, test } from "bun:test";

import { createSearchKnowledgeBase, openKnowledgeBase, type KnowledgeBase } from "./knowledge-base";

const payload = {
  source: "bun",
  doc_id: "bun:runtime/file-io.mdx",
  section_path: "File I/O > Reading files",
  text: "Bun.file(path) creates a BunFile.",
};

const fakeBase = () => {
  const calls: { query: string; search: unknown[] } = { query: "", search: [] };
  const base: KnowledgeBase = {
    embedder: {
      embedQuery: async (text) => {
        calls.query = text;
        return [0.1, 0.2];
      },
    },
    vectorIndex: {
      search: async (query) => {
        calls.search.push(query);
        return [{ id: "1", score: 0.8, payload }];
      },
    },
  };
  return { base, calls };
};

test("search embeds the query and maps the payload to hits", async () => {
  const { base, calls } = fakeBase();
  const search = createSearchKnowledgeBase(async () => base);

  expect(await search({ query: "read a file" })).toEqual({
    hits: [
      {
        score: 0.8,
        source: "bun",
        docId: "bun:runtime/file-io.mdx",
        sectionPath: "File I/O > Reading files",
        text: "Bun.file(path) creates a BunFile.",
      },
    ],
  });
  expect(calls.query).toBe("read a file");
  expect(calls.search).toEqual([{ vector: [0.1, 0.2], k: 5 }]);
});

test("search passes the source as a filter", async () => {
  const { base, calls } = fakeBase();
  await createSearchKnowledgeBase(async () => base)({ query: "q", source: "duckdb" });

  expect(calls.search).toEqual([{ vector: [0.1, 0.2], k: 5, filter: { source: "duckdb" } }]);
});

test("the knowledge base is opened once, on the first search", async () => {
  const { base } = fakeBase();
  let opened = 0;
  const search = createSearchKnowledgeBase(async () => {
    opened += 1;
    return base;
  });
  expect(opened).toBe(0);

  await search({ query: "a" });
  await search({ query: "b" });
  expect(opened).toBe(1);
});

test("a failed open is retried by the next search", async () => {
  const { base } = fakeBase();
  let opened = 0;
  const search = createSearchKnowledgeBase(async () => {
    opened += 1;
    if (opened === 1) throw new Error("qdrant is down");
    return base;
  });

  await expect(search({ query: "a" })).rejects.toThrow("qdrant is down");
  expect((await search({ query: "a" })).hits).toHaveLength(1);
  expect(opened).toBe(2);
});

// One stub server plays both the embeddings server and Qdrant, and records what it was asked.
type Seen = { method: string; path: string; headers: Headers; body: unknown };
const seen: Seen[] = [];
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const body = request.method === "POST" ? await request.json() : undefined;
      seen.push({ method: request.method, path: pathname, headers: request.headers, body });
      if (pathname === "/v1/embeddings") {
        const { input } = body as { input: string[] };
        return Response.json({
          data: input.map((_, index) => ({ index, embedding: [0.1, 0.2, 0.3] })),
        });
      }
      if (pathname === "/collections/docs") {
        return Response.json({ result: { config: { params: { vectors: { size: 3 } } } } });
      }
      return Response.json({ result: { points: [] } });
    },
  });
});
afterAll(() => server.stop(true));

const env = () => ({
  EMBEDDING_URL: `http://localhost:${server.port}`,
  EMBEDDING_MODEL: "test-model",
  EMBEDDING_QUERY_PREFIX: "Query: ",
  EMBEDDING_API_KEY: "embedding-test-key",
  QDRANT_URL: `http://localhost:${server.port}`,
  QDRANT_COLLECTION: "docs",
  QDRANT_API_KEY: "qdrant-test-key",
});

test("openKnowledgeBase embeds queries with the model, prefix and key, and searches the collection", async () => {
  seen.length = 0;
  const { embedder, vectorIndex } = await openKnowledgeBase(env());

  expect(await embedder.embedQuery("read a file")).toEqual([0.1, 0.2, 0.3]);
  await vectorIndex.search({ vector: [0.1, 0.2, 0.3], k: 5 });

  const embedding = seen.findLast((request) => request.path === "/v1/embeddings")!;
  expect(embedding.body).toEqual({ model: "test-model", input: ["Query: read a file"] });
  expect(embedding.headers.get("authorization")).toBe("Bearer embedding-test-key");
  const search = seen.find((request) => request.path === "/collections/docs/points/query")!;
  expect(search.headers.get("api-key")).toBe("qdrant-test-key");
  expect(search.body).toMatchObject({ limit: 5 });
});

test("openKnowledgeBase asks for the embedding server and model", async () => {
  const { EMBEDDING_URL: _url, ...withoutUrl } = env();
  const { EMBEDDING_MODEL: _model, ...withoutModel } = env();

  for (const incomplete of [withoutUrl, withoutModel, {}]) {
    await expect(openKnowledgeBase(incomplete)).rejects.toThrow(
      "EMBEDDING_URL and EMBEDDING_MODEL are required",
    );
  }
});

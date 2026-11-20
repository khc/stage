import { afterAll, expect, test } from "bun:test";

import { createNeo4jStore, toFulltextQuery } from "./neo4j-client";

type Call = { url: string; headers: Headers; body: Record<string, unknown> };
type Reply = { status?: number; json?: unknown };

const server = (reply: (call: Call, n: number) => Reply | undefined) => {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    };
    calls.push(call);
    const custom = reply(call, calls.length) ?? { json: { data: { fields: [], values: [] } } };
    return Response.json(custom.json ?? {}, { status: custom.status ?? 200 });
  }) as typeof fetch;
  return { fetchFn, calls };
};

const config = {
  url: "http://127.0.0.1:7474/",
  database: "my db",
  user: "neo4j",
  password: "secret",
};

test("posts to Query API v2 with encoded database name and Basic auth", async () => {
  const { fetchFn, calls } = server(() => undefined);
  const store = createNeo4jStore(fetchFn, config);
  await store.ensureSchema();
  expect(calls.length).toBe(4);
  expect(calls[0]!.url).toBe("http://127.0.0.1:7474/db/my%20db/query/v2");
  expect(calls[0]!.headers.get("authorization")).toBe(
    `Basic ${Buffer.from("neo4j:secret").toString("base64")}`,
  );
  expect(calls[0]!.body.accessMode).toBe("Write");
  expect(String(calls[0]!.body.statement)).toContain("CREATE CONSTRAINT asset_id_unique");
});

test("upsertBatch groups nodes by kind, batches UNWIND slices, and merges edges with props", async () => {
  const { fetchFn, calls } = server(() => undefined);
  const store = createNeo4jStore(fetchFn, { url: "http://127.0.0.1:7474" });
  const docs = Array.from({ length: 130 }, (_, i) => ({
    id: `bun:doc-${i}`,
    kind: "document" as const,
    source: "bun",
    name: `Doc ${i}`,
    props: { path: `doc-${i}.mdx` },
  }));
  await store.upsertBatch({
    nodes: [{ id: "bun", kind: "source", source: "bun", name: "bun" }, ...docs],
    edges: [
      { from: "bun", to: "bun:doc-0", type: "CONTAINS" },
      {
        from: "postgres:imdb:imdb.title_ratings.tconst",
        to: "postgres:imdb:imdb.title_basics.tconst",
        type: "REFERENCES",
        props: { fromColumn: "tconst", toColumn: "tconst", relationType: "logical" },
      },
    ],
    runId: "run-1",
  });
  const statements = calls.map((c) => String(c.body.statement));
  expect(statements.filter((s) => s.includes("SET n:Document"))).toHaveLength(2);
  expect(statements.filter((s) => s.includes("SET n:Source"))).toHaveLength(1);
  expect(statements.filter((s) => s.includes("MERGE (a)-[r:CONTAINS]->(b)"))).toHaveLength(1);
  expect(statements.filter((s) => s.includes("MERGE (a)-[r:REFERENCES]->(b)"))).toHaveLength(1);
  expect(calls[0]!.headers.has("authorization")).toBe(false);
});

test("pruneSource removes stale edges and nodes for the source and returns deleted count", async () => {
  const { fetchFn, calls } = server((_, n) =>
    n === 2 ? { json: { data: { fields: ["deleted"], values: [[7]] } } } : undefined,
  );
  const store = createNeo4jStore(fetchFn, config);
  expect(await store.pruneSource("bun", "run-2")).toBe(7);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body.parameters).toEqual({ source: "bun", runId: "run-2" });
});

test("read operations send accessMode Read, clamp limits, and map returned rows", async () => {
  const { fetchFn, calls } = server((call) => {
    const stmt = String(call.body.statement);
    if (stmt.includes("fulltext.queryNodes")) {
      return {
        json: {
          data: {
            fields: ["asset"],
            values: [
              [
                {
                  id: "postgres:imdb:imdb.title_basics",
                  kind: "table",
                  source: "postgres:imdb",
                  name: "title_basics",
                  props: {
                    id: "postgres:imdb:imdb.title_basics",
                    kind: "table",
                    source: "postgres:imdb",
                    name: "title_basics",
                    ingestRunId: "r1",
                    schema: "imdb",
                  },
                },
              ],
            ],
          },
        },
      };
    }
    if (stmt.includes("neighbor")) {
      return {
        json: {
          data: {
            fields: ["asset", "relationship", "direction", "depth"],
            values: [
              [
                {
                  id: "postgres:imdb:imdb.title_basics.tconst",
                  kind: "column",
                  source: "postgres:imdb",
                  name: "tconst",
                  props: { dataType: "text" },
                },
                "CONTAINS",
                "outgoing",
                1,
              ],
            ],
          },
        },
      };
    }
    return {
      json: {
        data: {
          fields: ["steps"],
          values: [
            [
              [
                {
                  fromId: "a",
                  toId: "b",
                  type: "REFERENCES",
                  fromColumn: "tconst",
                  toColumn: "tconst",
                },
              ],
            ],
          ],
        },
      },
    };
  });

  const store = createNeo4jStore(fetchFn, config);
  const assets = await store.searchAssets({ query: "title_basics (movies)?", limit: 200 });
  expect(assets).toEqual([
    {
      id: "postgres:imdb:imdb.title_basics",
      kind: "table",
      source: "postgres:imdb",
      name: "title_basics",
      props: { schema: "imdb" },
    },
  ]);
  expect(calls[0]!.body.accessMode).toBe("Read");
  expect(calls[0]!.body.parameters).toMatchObject({ query: "title_basics movies", limit: 50 });

  const neighbors = await store.getNeighbors({
    id: "postgres:imdb:imdb.title_basics",
    depth: 4,
    edgeTypes: ["CONTAINS"],
    limit: 0,
  });
  expect(neighbors[0]).toMatchObject({
    relationship: "CONTAINS",
    direction: "outgoing",
    depth: 1,
    asset: { id: "postgres:imdb:imdb.title_basics.tconst", props: { dataType: "text" } },
  });
  expect(String(calls[1]!.body.statement)).toContain("[*1..2]");
  expect(String(calls[1]!.body.statement)).toContain("collect(");
  expect(calls[1]!.body.parameters).toMatchObject({ limit: 1 });

  const path = await store.findJoinPath({ fromId: "a", toId: "b", maxHops: 20 });
  expect(path).toEqual([
    { fromId: "a", toId: "b", type: "REFERENCES", fromColumn: "tconst", toColumn: "tconst" },
  ]);
  expect(String(calls[2]!.body.statement)).toContain(
    "[*1..6]".replace("[*1..6]", "[:REFERENCES|CONTAINS*1..6]"),
  );
});

test("toFulltextQuery strips Lucene operators and searchAssets skips empty queries", async () => {
  expect(toFulltextQuery("how does Bun.serve() work?")).toBe("how does Bun.serve work");
  const { fetchFn, calls } = server(() => undefined);
  const store = createNeo4jStore(fetchFn, config);
  expect(await store.searchAssets({ query: "???" })).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("Neo4j errors and timeouts reject with a clear error message", async () => {
  const { fetchFn } = server(() => ({
    status: 200,
    json: { errors: [{ code: "Neo.ClientError.Statement.SyntaxError", message: "Invalid input" }] },
  }));
  await expect(createNeo4jStore(fetchFn, config).ensureSchema()).rejects.toThrow(
    "Neo.ClientError.Statement.SyntaxError: Invalid input",
  );

  const hanging = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })) as typeof fetch;
  await expect(
    createNeo4jStore(hanging, { ...config, timeoutMs: 15 }).ensureSchema(),
  ).rejects.toThrow(/neo4j query failed/);
});

test("upsertBatch strips reserved keys from props, resets node properties, matches edge endpoints, and rejects unknown kinds/types", async () => {
  const { fetchFn, calls } = server(() => undefined);
  const store = createNeo4jStore(fetchFn, config);
  await store.upsertBatch({
    nodes: [
      {
        id: "bun:a",
        kind: "document",
        source: "bun",
        name: "A",
        props: { id: "hijacked", path: "a.mdx" } as unknown as Record<string, string>,
      },
    ],
    edges: [{ from: "bun", to: "bun:a", type: "CONTAINS" }],
    runId: "r1",
  });
  const nodeCall = calls[0]!.body;
  const rows = (nodeCall.parameters as { rows: { props: Record<string, unknown> }[] }).rows;
  expect(rows[0]!.props).toEqual({ path: "a.mdx" });
  expect(String(nodeCall.statement)).toContain("SET n = {");
  expect(String(calls[1]!.body.statement)).toContain(
    "MATCH (a:Asset {id: row.from}), (b:Asset {id: row.to})",
  );

  await expect(
    store.upsertBatch({
      nodes: [{ id: "x", kind: "constructor" as never, source: "s", name: "n" }],
      edges: [],
      runId: "r1",
    }),
  ).rejects.toThrow("unknown node kind");

  await expect(
    store.upsertBatch({
      nodes: [],
      edges: [{ from: "a", to: "b", type: "toString" as never }],
      runId: "r1",
    }),
  ).rejects.toThrow("unknown edge type");
});

const live = process.env.NEO4J_URL;
const testSource = `test-${crypto.randomUUID()}`;
afterAll(async () => {
  if (!live) return;
  const store = createNeo4jStore(fetch, {
    url: live,
    database: process.env.NEO4J_DATABASE,
    user: process.env.NEO4J_USER,
    password: process.env.NEO4J_PASSWORD,
  });
  await store.pruneSource(testSource, "cleanup-none");
});

test.skipIf(!live)(
  "contract: schema, upsertBatch, searchAssets, getNeighbors, pruneSource",
  async () => {
    const store = createNeo4jStore(fetch, {
      url: live!,
      database: process.env.NEO4J_DATABASE,
      user: process.env.NEO4J_USER,
      password: process.env.NEO4J_PASSWORD,
    });
    await store.ensureSchema();
    await store.upsertBatch({
      nodes: [
        { id: `${testSource}:t1`, kind: "table", source: testSource, name: "title_basics" },
        { id: `${testSource}:c1`, kind: "column", source: testSource, name: "tconst" },
      ],
      edges: [{ from: `${testSource}:t1`, to: `${testSource}:c1`, type: "CONTAINS" }],
      runId: "r1",
    });
    const found = await store.searchAssets({ query: "title_basics", source: testSource });
    expect(found.map((a) => a.id)).toEqual([`${testSource}:t1`]);
    const neighbors = await store.getNeighbors({ id: `${testSource}:t1` });
    expect(neighbors.map((n) => n.asset.id)).toEqual([`${testSource}:c1`]);
  },
);

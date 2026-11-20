import { expect, test } from "bun:test";

import {
  createDiscoverAssets,
  createExploreAsset,
  createFindJoinPath,
  openGraphDiscovery,
  type GraphDiscovery,
} from "./graph";
import type { KnowledgeBase } from "./knowledge-base";

const fakeGraph = (): { graph: GraphDiscovery; calls: { method: string; args: unknown }[] } => {
  const calls: { method: string; args: unknown }[] = [];
  const graph: GraphDiscovery = {
    searchAssets: async (args) => {
      calls.push({ method: "searchAssets", args });
      return [
        {
          id: "postgres:imdb:imdb.title_basics",
          kind: "table",
          source: "postgres:imdb",
          name: "title_basics",
          props: { schema: "imdb" },
        },
      ];
    },
    getNeighbors: async (args) => {
      calls.push({ method: "getNeighbors", args });
      return [
        {
          asset: {
            id: "postgres:imdb:imdb.title_basics.tconst",
            kind: "column",
            source: "postgres:imdb",
            name: "tconst",
            props: { dataType: "text" },
          },
          relationship: "CONTAINS",
          direction: "outgoing",
          depth: 1,
        },
      ];
    },
    findJoinPath: async (args) => {
      calls.push({ method: "findJoinPath", args });
      return [
        {
          fromId: args.fromId,
          toId: args.toId,
          type: "REFERENCES",
          fromColumn: "tconst",
          toColumn: "tconst",
        },
      ];
    },
  };
  return { graph, calls };
};

test("discover_assets opens lazily once, retries on failure, and merges Qdrant semantic hits", async () => {
  const { graph, calls } = fakeGraph();
  let opened = 0;
  const open = async () => {
    opened += 1;
    if (opened === 1) throw new Error("neo4j down");
    return graph;
  };
  const kb: KnowledgeBase = {
    embedder: { embedQuery: async () => [0.1, 0.2] },
    vectorIndex: {
      search: async () => [
        {
          id: "p1",
          score: 0.9,
          payload: {
            source: "bun",
            doc_id: "bun:runtime/http/server.mdx",
            section_path: "HTTP Server",
          },
        },
      ],
    },
  };
  const discover = createDiscoverAssets(open, async () => kb);
  expect(await discover({ query: "title" })).toEqual({ error: "neo4j down" });
  const result = await discover({ query: "title", limit: 10 });
  expect((result as { assets: { id: string }[] }).assets.map((a) => a.id)).toEqual([
    "postgres:imdb:imdb.title_basics",
    "bun:runtime/http/server.mdx",
  ]);
  await discover({ query: "again" });
  expect(opened).toBe(2);
  expect(calls.filter((c) => c.method === "searchAssets")).toHaveLength(2);
});

test("discover_assets degrades gracefully when embeddings/Qdrant fail", async () => {
  const { graph } = fakeGraph();
  const discover = createDiscoverAssets(
    async () => graph,
    async () => {
      throw new Error("EMBEDDING_URL missing");
    },
  );
  const res = await discover({ query: "title" });
  expect("assets" in res && res.assets).toHaveLength(1);
  if (!("assets" in res)) throw new Error("expected assets");
  expect(res.assets[0]!.id).toBe("postgres:imdb:imdb.title_basics");
});

test("explore_asset clamps depth and limit, and find_join_path delegates maxHops 4", async () => {
  const { graph, calls } = fakeGraph();
  const explore = createExploreAsset(async () => graph);
  const joinPath = createFindJoinPath(async () => graph);

  const explored = await explore({ id: "postgres:imdb:imdb.title_basics", depth: 5, limit: 100 });
  expect((explored as { neighbors: unknown[] }).neighbors).toHaveLength(1);
  expect(calls[0]).toEqual({
    method: "getNeighbors",
    args: { id: "postgres:imdb:imdb.title_basics", depth: 2, edgeTypes: undefined, limit: 50 },
  });

  const path = await joinPath({ fromId: "a", toId: "b" });
  expect((path as { steps: unknown[] }).steps).toHaveLength(1);
  expect(calls[1]).toEqual({
    method: "findJoinPath",
    args: { fromId: "a", toId: "b", maxHops: 4 },
  });

  const failingExplore = createExploreAsset(async () => {
    throw new Error("NEO4J_URL is required");
  });
  const failingJoin = createFindJoinPath(async () => {
    throw new Error("NEO4J_URL is required");
  });
  expect(await failingExplore({ id: "x" })).toEqual({ error: "NEO4J_URL is required" });
  expect(await failingJoin({ fromId: "a", toId: "b" })).toEqual({
    error: "NEO4J_URL is required",
  });
});

test("openGraphDiscovery requires NEO4J_URL and targets the configured database", async () => {
  await expect(openGraphDiscovery({})).rejects.toThrow("NEO4J_URL is required");
  const requests: { url: string; auth: string | null }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      auth: new Headers(init?.headers).get("authorization"),
    });
    return Response.json({ data: { fields: ["asset"], values: [] } });
  }) as typeof fetch;

  const graph = await openGraphDiscovery(
    {
      NEO4J_URL: "http://127.0.0.1:7474",
      NEO4J_DATABASE: "stage",
      NEO4J_USER: "neo4j",
      NEO4J_PASSWORD: "secret",
    },
    fetchFn,
  );
  await graph.searchAssets({ query: "movies" });
  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:7474/db/stage/query/v2",
      auth: `Basic ${Buffer.from("neo4j:secret").toString("base64")}`,
    },
  ]);
});

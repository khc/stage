import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createDockerPostgresRunner,
  DEFAULT_IMDB_CONTAINER,
  defaultPsqlExec,
  main,
  type CliDeps,
} from "./cli";
import type { Embedder } from "./platform/embeddings-client";
import type { IndexPoint, SearchHit, VectorIndex } from "./platform/qdrant-client";

let out: string;
let logs: string[];
let errors: string[];
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), "ingestion-cli-"));
  logs = [];
  errors = [];
  log = spyOn(console, "log").mockImplementation(
    (...args: unknown[]) => void logs.push(args.join(" ")),
  );
  error = spyOn(console, "error").mockImplementation(
    (...args: unknown[]) => void errors.push(args.join(" ")),
  );
});
afterEach(async () => {
  log.mockRestore();
  error.mockRestore();
  await rm(out, { recursive: true, force: true });
});

const fixture = (path: string) => Bun.file(`${import.meta.dir}/../fixtures/${path}`).text();
const put = async (relative: string, text: string) => {
  const file = join(out, "corpora", relative);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, text);
};
const corpora = async () => {
  await put("bun/docs/runtime/http/server.mdx", await fixture("mdx/server.mdx"));
  await put("bun/docs/runtime/guide.mdx", await fixture("mdx/guide.mdx"));
  await put("bun/docs/z-bad.mdx", "---\ntitle: Bad\n---\n\nHello {broken");
  await put("duckdb/docs/2.0/sql/select.md", await fixture("jekyll/select.md"));
};

type Setup = {
  deps: CliDeps;
  commands: { cmd: string[]; cwd?: string }[];
  embedderConfigs: unknown[];
  indexConfigs: unknown[];
  upserts: IndexPoint[][];
  deletedIds: string[][];
  searches: unknown[];
  queries: string[];
};
const setup = (hits: SearchHit[] = []): Setup => {
  const state: Setup = {
    commands: [],
    embedderConfigs: [],
    indexConfigs: [],
    upserts: [],
    deletedIds: [],
    searches: [],
    queries: [],
    deps: undefined as never,
  };
  const embedder: Embedder = {
    dimension: 2,
    embed: async (texts) => texts.map((text) => [text.length, 1]),
    embedQuery: async (text) => {
      state.queries.push(text);
      return [1, 0];
    },
  };
  const vectorIndex: VectorIndex = {
    upsert: async (points) => void state.upserts.push(points),
    search: async (query) => (state.searches.push(query), hits),
    listSourceHashes: async () => new Map(),
    deleteIds: async (ids) => void state.deletedIds.push(ids),
    deleteWhere: async () => {},
  };
  state.deps = {
    run: async (cmd, cwd) => {
      state.commands.push({ cmd, cwd });
      return cmd[1] === "rev-parse" ? "abc123\n" : "";
    },
    createEmbedder: mock(async (config) => (state.embedderConfigs.push(config), embedder)),
    createVectorIndex: mock(async (config) => (state.indexConfigs.push(config), vectorIndex)),
  };
  return state;
};
const env = (extra: Record<string, string> = {}) => ({
  OUT_DIR: out,
  EMBEDDING_URL: "http://127.0.0.1:8000",
  EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-8bit",
  ...extra,
});

test("fetch all clones both corpora under OUT_DIR and prints each revision", async () => {
  const { deps, commands } = setup();
  expect(await main(["fetch", "all"], env(), deps)).toBe(0);
  const clones = commands.filter(({ cmd }) => cmd[1] === "clone").map(({ cmd }) => cmd.at(-1));
  expect(clones.toSorted()).toEqual(
    [join(out, "corpora", "bun"), join(out, "corpora", "duckdb")].toSorted(),
  );
  expect(logs).toEqual(["bun: abc123", "duckdb: abc123"]);
});

test("fetch of one source touches only that source", async () => {
  const { deps, commands } = setup();
  expect(await main(["fetch", "bun"], env(), deps)).toBe(0);
  expect(commands.some(({ cmd }) => cmd.includes("https://github.com/duckdb/duckdb-web.git"))).toBe(
    false,
  );
  expect(logs).toEqual(["bun: abc123"]);
});

test("an unknown source or command exits 1 with a usage line", async () => {
  const { deps } = setup();
  expect(await main(["fetch", "nope"], env(), deps)).toBe(1);
  expect(errors.join("\n")).toContain("nope");
  expect(await main(["wat"], env(), deps)).toBe(1);
  expect(await main([], env(), deps)).toBe(1);
  expect(errors.join("\n")).toContain("usage");
});

test("inherited object keys are not sources", async () => {
  const { deps, commands } = setup();
  for (const name of ["toString", "constructor", "__proto__"]) {
    errors.length = 0;
    expect(await main(["ingest", name, "--dry-run"], env(), deps)).toBe(1);
    expect(errors.join("\n")).toContain("unknown source");
    expect(await main(["fetch", name], env(), deps)).toBe(1);
    expect(await main(["search", "x", "--source", name], env(), deps)).toBe(1);
  }
  expect(commands).toEqual([]);
});

test("a dry run counts documents, chunks and skipped files without any server or file", async () => {
  await corpora();
  const { deps } = setup();
  expect(await main(["ingest", "bun", "--dry-run"], env(), deps)).toBe(0);
  expect(deps.createEmbedder).not.toHaveBeenCalled();
  expect(deps.createVectorIndex).not.toHaveBeenCalled();
  expect(logs[0]).toMatch(
    /^bun: 2 documents, \d+ nodes, \d+ edges, \d+ chunks \(\d+ characters\), 1 skipped$/,
  );
  expect(logs.join("\n")).toContain("skipped z-bad.mdx");
  expect(await Bun.file(join(out, "catalog", "bun.jsonl")).exists()).toBe(false);
});

test("a dry run needs no embedding settings", async () => {
  await corpora();
  const { deps } = setup();
  expect(await main(["ingest", "duckdb", "--dry-run"], { OUT_DIR: out }, deps)).toBe(0);
  expect(logs[0]).toContain("duckdb: 1 documents");
});

test("ingest of a corpus that was not fetched says to run fetch", async () => {
  const { deps } = setup();
  expect(await main(["ingest", "bun", "--dry-run"], env(), deps)).toBe(1);
  expect(errors.join("\n")).toContain("fetch bun");
});

test("ingest names the missing embedding setting", async () => {
  await corpora();
  const { deps } = setup();
  expect(await main(["ingest", "bun"], { OUT_DIR: out, EMBEDDING_MODEL: "m" }, deps)).toBe(1);
  expect(errors.join("\n")).toContain("EMBEDDING_URL");
  errors.length = 0;
  expect(await main(["ingest", "bun"], { OUT_DIR: out, EMBEDDING_URL: "http://x" }, deps)).toBe(1);
  expect(errors.join("\n")).toContain("EMBEDDING_MODEL");
});

test("ingest embeds the chunks into Qdrant, writes the catalog and prints the summary", async () => {
  await corpora();
  const { deps, upserts, embedderConfigs, indexConfigs } = setup();
  const code = await main(
    ["ingest", "bun"],
    env({
      EMBEDDING_QUERY_PREFIX: "q: ",
      EMBEDDING_DOCUMENT_PREFIX: "d: ",
      EMBEDDING_API_KEY: "k",
    }),
    deps,
  );
  expect(code).toBe(0);
  expect(embedderConfigs).toEqual([
    {
      url: "http://127.0.0.1:8000",
      model: "Qwen3-Embedding-0.6B-8bit",
      apiKey: "k",
      documentPrefix: "d: ",
      queryPrefix: "q: ",
    },
  ]);
  expect(indexConfigs).toEqual([
    { url: "http://localhost:6333", collection: "docs", dimension: 2 },
  ]);
  const chunks = upserts.flat();
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((point) => point.payload.source === "bun")).toBe(true);
  expect([...new Set(chunks.map((point) => point.payload.doc_id))].toSorted()).toEqual([
    "bun:runtime/guide.mdx",
    "bun:runtime/http/server.mdx",
  ]);
  expect(logs[0]).toMatch(
    new RegExp(`^bun: 2 documents, \\d+ nodes, \\d+ edges, ${chunks.length} chunks, 1 skipped$`),
  );
  const catalog = (await Bun.file(join(out, "catalog", "bun.jsonl")).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  const source = catalog.find((r) => r.node?.id === "bun").node;
  expect(source.props.revision).toBe("abc123");
  expect(catalog.filter((r) => r.node?.kind === "document")).toHaveLength(2);
});

test("QDRANT_API_KEY reaches the vector index config", async () => {
  await corpora();
  const { deps, indexConfigs } = setup();
  expect(await main(["ingest", "bun"], env({ QDRANT_API_KEY: "qk" }), deps)).toBe(0);
  expect(indexConfigs).toEqual([
    { url: "http://localhost:6333", collection: "docs", dimension: 2, apiKey: "qk" },
  ]);
});

test("--limit keeps the first documents in path order", async () => {
  await corpora();
  const { deps, upserts } = setup();
  expect(await main(["ingest", "bun", "--limit", "1"], env(), deps)).toBe(0);
  expect([...new Set(upserts.flat().map((point) => point.payload.doc_id))]).toEqual([
    "bun:runtime/guide.mdx",
  ]);
});

test("a --limit run writes bun.partial.jsonl and leaves the full catalog alone", async () => {
  await corpora();
  await Bun.write(join(out, "catalog", "bun.jsonl"), "full catalog\n");
  const { deps } = setup();
  expect(await main(["ingest", "bun", "--limit", "1"], env(), deps)).toBe(0);
  expect(await Bun.file(join(out, "catalog", "bun.jsonl")).text()).toBe("full catalog\n");
  const partial = await Bun.file(join(out, "catalog", "bun.partial.jsonl")).text();
  expect(partial).toContain('"id":"bun:runtime/guide.mdx"');
  expect(await main(["ingest", "bun"], env(), deps)).toBe(0);
  expect(await Bun.file(join(out, "catalog", "bun.jsonl")).text()).toContain(
    '"id":"bun:runtime/http/server.mdx"',
  );
});

test("a --limit that is not a positive integer is rejected", async () => {
  await corpora();
  const { deps } = setup();
  for (const limit of ["0", "x", "-3", "1.5"]) {
    expect(await main(["ingest", "bun", "--limit", limit], env(), deps)).toBe(1);
  }
  expect(errors.join("\n")).toContain("--limit");
});

test("ingest all runs every source with one embedder and one index", async () => {
  await corpora();
  const { deps, upserts } = setup();
  expect(await main(["ingest", "all"], env(), deps)).toBe(0);
  expect(deps.createEmbedder).toHaveBeenCalledTimes(1);
  expect(deps.createVectorIndex).toHaveBeenCalledTimes(1);
  expect(logs.filter((line) => !line.startsWith("  ")).map((line) => line.split(":")[0])).toEqual([
    "bun",
    "duckdb",
  ]);
  expect(upserts.flat().some((point) => point.payload.source === "duckdb")).toBe(true);
});

test("a configuration error names the setting and prints no environment variable", async () => {
  const { deps } = setup();
  const code = await main(
    ["ingest", "bun", "--dry-run"],
    {
      OUT_DIR: out,
      CHUNK_SIZE: "abc",
      QDRANT_API_KEY: "FAKE_TEST_KEY_123",
      UNRELATED: "FAKE_OTHER_456",
    },
    deps,
  );
  expect(code).toBe(1);
  const printed = errors.join("\n");
  expect(printed).toContain("CHUNK_SIZE");
  expect(printed).not.toContain("FAKE_TEST_KEY_123");
  expect(printed).not.toContain("FAKE_OTHER_456");
});

test("an unexpected error is printed as its message with control characters removed", async () => {
  await corpora();
  const { deps } = setup();
  deps.createEmbedder = async () => {
    throw new Error("server said \u001b[31mno\u001b]0;x\u0007");
  };
  expect(await main(["ingest", "bun"], env(), deps)).toBe(1);
  const printed = errors.join("\n");
  expect(printed).toContain("server said");
  expect(/\p{Cc}/u.test(printed.replaceAll("\n", " "))).toBe(false);
});

test("a chunk overlap that is not smaller than the chunk size is rejected", async () => {
  const { deps } = setup();
  expect(
    await main(
      ["ingest", "bun", "--dry-run"],
      env({ CHUNK_SIZE: "200", CHUNK_OVERLAP: "200" }),
      deps,
    ),
  ).toBe(1);
  expect(errors.join("\n")).toContain("CHUNK_OVERLAP");
});

test("search embeds the query, asks for 5 hits, filters by source and prints them", async () => {
  const hit: SearchHit = {
    id: "p",
    score: 0.81234,
    payload: {
      source: "bun",
      doc_id: "bun:runtime/http/server.mdx",
      section_path: "Server > Basic Setup",
      text: `Server > Basic Setup\n\nBun.serve starts an HTTP server.\n${"x".repeat(200)}`,
    },
  };
  const { deps, queries, searches } = setup([hit]);
  expect(
    await main(["search", "start", "an", "http", "server", "--source", "bun"], env(), deps),
  ).toBe(0);
  expect(queries).toEqual(["start an http server"]);
  expect(searches).toEqual([{ vector: [1, 0], k: 5, filter: { source: "bun" } }]);
  expect(logs[0]).toBe("0.812  bun  bun:runtime/http/server.mdx  Server > Basic Setup");
  expect(logs[1]!.startsWith("  Bun.serve starts an HTTP server.")).toBe(true);
  expect(logs[1]!.length).toBeLessThanOrEqual(2 + 120);
});

test("terminal control characters in corpus text never reach the output", async () => {
  const hit: SearchHit = {
    id: "p",
    score: 0.5,
    payload: {
      source: "bun",
      doc_id: "bun:a\u001b]0;pwned\u0007.mdx",
      section_path: "Server \u001b[31m> Setup",
      text: "Server \u001b[31m> Setup\n\nBun.serve\u001b[2J starts a server.",
    },
  };
  const { deps } = setup([hit]);
  expect(await main(["search", "serve"], env(), deps)).toBe(0);
  await put("bun/docs/ev\u001b[31mil-bad.mdx", "---\ntitle: Bad\n---\n\nHello {broken");
  expect(await main(["ingest", "bun", "--dry-run"], env(), deps)).toBe(0);
  const printed = logs.join("\n").replaceAll("\n", " ");
  expect(printed).toContain("Bun.serve");
  expect(printed).toContain("skipped ev");
  expect(/\p{Cc}/u.test(printed)).toBe(false);
});

test("search without --source has no filter, and without a query or embedding settings it fails", async () => {
  const { deps, searches } = setup();
  expect(await main(["search", "parquet"], env(), deps)).toBe(0);
  expect(searches).toEqual([{ vector: [1, 0], k: 5 }]);
  expect(await main(["search"], env(), deps)).toBe(1);
  expect(await main(["search", "x"], { OUT_DIR: out }, deps)).toBe(1);
  expect(await main(["search", "x", "--source", "nope"], env(), deps)).toBe(1);
});

test("search with RERANK_MODEL fetches 25 candidates and reorders by reranker score", async () => {
  const hits: SearchHit[] = [
    {
      id: "low",
      score: 0.9,
      payload: {
        source: "bun",
        doc_id: "bun:a.mdx",
        section_path: "A",
        text: "A\n\nunrelated chunk",
      },
    },
    {
      id: "high",
      score: 0.4,
      payload: {
        source: "bun",
        doc_id: "bun:b.mdx",
        section_path: "B",
        text: "B\n\nBun.serve starts a server",
      },
    },
  ];
  const { deps, searches } = setup(hits);
  const rerankerConfigs: unknown[] = [];
  const rerankCalls: { query: string; documents: string[]; topN?: number }[] = [];
  deps.createReranker = (config) => {
    rerankerConfigs.push(config);
    return {
      rerank: async (query, documents, topN) => {
        rerankCalls.push({ query, documents, topN });
        return [
          { index: 1, relevanceScore: 0.99 },
          { index: 0, relevanceScore: 0.12 },
        ];
      },
    };
  };

  expect(
    await main(
      ["search", "start an http server"],
      env({ RERANK_MODEL: "Qwen3-Reranker-0.6B-mxfp8", EMBEDDING_API_KEY: "emb-key" }),
      deps,
    ),
  ).toBe(0);
  expect(rerankerConfigs).toEqual([
    { url: "http://127.0.0.1:8000", model: "Qwen3-Reranker-0.6B-mxfp8", apiKey: "emb-key" },
  ]);
  expect(searches).toEqual([{ vector: [1, 0], k: 25 }]);
  expect(rerankCalls).toEqual([
    {
      query: "start an http server",
      documents: ["A\n\nunrelated chunk", "B\n\nBun.serve starts a server"],
      topN: 5,
    },
  ]);
  expect(logs[0]).toBe("0.990  bun  bun:b.mdx  B");
  expect(logs[2]).toBe("0.120  bun  bun:a.mdx  A");

  rerankerConfigs.length = 0;
  expect(
    await main(
      ["search", "start an http server"],
      env({
        RERANK_URL: "http://127.0.0.1:8001",
        RERANK_MODEL: "Qwen3-Reranker-0.6B-mxfp8",
        EMBEDDING_API_KEY: "emb-key",
      }),
      deps,
    ),
  ).toBe(0);
  expect(rerankerConfigs).toEqual([
    { url: "http://127.0.0.1:8001", model: "Qwen3-Reranker-0.6B-mxfp8", apiKey: undefined },
  ]);
});

const evalDeps = (hitsByPrefix: Record<"prefix" | "plain", string>) => {
  const { deps } = setup();
  const prefixes: (string | undefined)[] = [];
  deps.createEmbedder = async (config) => {
    prefixes.push(config.queryPrefix);
    return {
      dimension: 2,
      embed: async (texts) => texts.map(() => [0, 0]),
      embedQuery: async () => [config.queryPrefix ? 1 : 0, 0],
    };
  };
  deps.createVectorIndex = async () => ({
    upsert: async () => {},
    deleteWhere: async () => {},
    deleteIds: async () => {},
    listSourceHashes: async () => new Map(),
    search: async ({ vector }) => {
      const docId = hitsByPrefix[vector[0] === 1 ? "prefix" : "plain"];
      return [{ id: "p", score: 1, payload: { doc_id: docId } }];
    },
  });
  return { deps, prefixes };
};

test("eval runs the judged queries with and without the query prefix and reports each", async () => {
  const { deps, prefixes } = evalDeps({
    prefix: "bun:runtime/http/server.mdx",
    plain: "bun:other.mdx",
  });
  expect(await main(["eval"], env({ EMBEDDING_QUERY_PREFIX: "Instruct: x\\nQuery: " }), deps)).toBe(
    0,
  );
  expect(prefixes).toEqual(["Instruct: x\\nQuery: ", undefined]);
  expect(logs.filter((line) => !line.startsWith("  "))).toEqual([
    "with query prefix",
    "plain (no query prefix)",
  ]);
  const summaries = logs.filter((line) => line.trimStart().startsWith("recall@5"));
  expect(summaries[0]).toMatch(
    /^ {2}recall@5 1\/\d+ \(0\.\d\d\) {2}MRR 0\.0\d\d {2}not found \d+$/,
  );
  expect(summaries[1]).toMatch(/^ {2}recall@5 0\/\d+ \(0\.00\) {2}MRR 0\.000 {2}not found \d+$/);
  expect(logs).toContain("  hit   rank 1  start an http server");
  expect(logs).toContain("  miss  rank -  start an http server");
});

test("eval without a query prefix runs only the plain variant", async () => {
  const { deps, prefixes } = evalDeps({ prefix: "bun:a", plain: "bun:guides/http/simple.mdx" });
  expect(await main(["eval"], env(), deps)).toBe(0);
  expect(prefixes).toEqual([undefined]);
  expect(logs[0]).toBe("plain (no query prefix)");
  expect(logs).toContain("  hit   rank 1  start an http server");
});

test("eval with RERANK_MODEL adds a reranked variant without truncating ranks 6..40", async () => {
  const { deps } = setup();
  deps.createEmbedder = async () => ({
    dimension: 2,
    embed: async (texts) => texts.map(() => [0, 0]),
    embedQuery: async () => [1, 0],
  });
  deps.createVectorIndex = async () => ({
    upsert: async () => {},
    deleteWhere: async () => {},
    deleteIds: async () => {},
    listSourceHashes: async () => new Map(),
    search: async () =>
      Array.from({ length: 7 }, (_, idx) => ({
        id: String(idx),
        score: 1 - idx * 0.1,
        payload: {
          doc_id: idx === 6 ? "bun:runtime/http/server.mdx" : `bun:other-${idx}.mdx`,
          text: idx === 6 ? "server docs" : "other",
        },
      })),
  });
  const topNs: (number | undefined)[] = [];
  deps.createReranker = () => ({
    rerank: async (_query, documents, topN) => {
      topNs.push(topN);
      // Put the 7th item (index 6) at rank 6 (0-based 5) to verify ranks >= 6 stay in MRR.
      return [0, 1, 2, 3, 4, 6, 5].slice(0, documents.length).map((index, pos) => ({
        index,
        relevanceScore: 1 - pos * 0.1,
      }));
    },
  });

  expect(await main(["eval"], env({ RERANK_MODEL: "rerank-m" }), deps)).toBe(0);
  expect(topNs.every((n) => n === undefined)).toBe(true);
  expect(logs.filter((line) => !line.startsWith("  "))).toEqual([
    "plain (no query prefix)",
    "plain (no query prefix) + rerank",
  ]);
  expect(logs).toContain("  miss  rank 7  start an http server");
  expect(logs).toContain("  miss  rank 6  start an http server");
});

test("eval names a missing embedding setting", async () => {
  const { deps } = evalDeps({ prefix: "x", plain: "x" });
  expect(await main(["eval"], { OUT_DIR: out }, deps)).toBe(1);
  expect(errors.join("\n")).toContain("EMBEDDING_URL");
});

test("ingest writes to Neo4j as well as JSONL when NEO4J_URL is set", async () => {
  await corpora();
  const { deps } = setup();
  const graphConfigs: unknown[] = [];
  const graphEvents: string[] = [];
  deps.createGraphStore = (config) => {
    graphConfigs.push(config);
    return {
      ensureSchema: async () => void graphEvents.push("schema"),
      upsertBatch: async ({ nodes }) => void graphEvents.push(`upsert:${nodes.length}`),
      pruneSource: async (source) => (graphEvents.push(`prune:${source}`), 0),
      searchAssets: async () => [],
      getNeighbors: async () => [],
      findJoinPath: async () => [],
    };
  };
  const code = await main(
    ["ingest", "bun"],
    env({ NEO4J_URL: "http://localhost:7474", NEO4J_USER: "neo4j", NEO4J_PASSWORD: "secret" }),
    deps,
  );
  expect(code).toBe(0);
  expect(graphConfigs).toEqual([
    { url: "http://localhost:7474", database: "neo4j", user: "neo4j", password: "secret" },
  ]);
  expect(graphEvents[0]).toBe("schema");
  expect(graphEvents.at(-1)).toBe("prune:bun");
  expect(await Bun.file(join(out, "catalog", "bun.jsonl")).exists()).toBe(true);
});

test("ingest imdb defaults to the Floci container, supports IMDB_DATABASE_URL, and closes runners", async () => {
  const { deps, upserts } = setup();
  const containers: string[] = [];
  deps.createContainerPostgresRunner = (container) => {
    containers.push(container);
    return async () => [];
  };
  expect(await main(["ingest", "imdb"], env(), deps)).toBe(0);
  expect(containers).toEqual([DEFAULT_IMDB_CONTAINER]);

  expect(await main(["ingest", "imdb", "--container", "custom-pg"], env(), deps)).toBe(0);
  expect(containers).toEqual([DEFAULT_IMDB_CONTAINER, "custom-pg"]);

  let closed = 0;
  deps.createPostgresRunner = () => ({
    runSql: async (sql) => {
      if (sql.includes("information_schema.tables")) {
        return [
          {
            table_schema: "imdb",
            table_name: "title_basics",
            table_type: "BASE TABLE",
            comment: null,
          },
        ];
      }
      if (sql.includes("information_schema.columns")) {
        return [
          {
            table_schema: "imdb",
            table_name: "title_basics",
            column_name: "tconst",
            ordinal_position: 1,
            data_type: "text",
            udt_name: "text",
            is_nullable: "NO",
            comment: null,
          },
        ];
      }
      return [];
    },
    close: async () => {
      closed += 1;
    },
  });
  expect(
    await main(
      ["ingest", "imdb"],
      env({ IMDB_DATABASE_URL: "postgres://u:p@localhost/imdb" }),
      deps,
    ),
  ).toBe(0);
  expect(closed).toBe(1);
  expect(upserts.flat().map((p) => p.payload.doc_id)).toEqual(["postgres:imdb:imdb.title_basics"]);
  expect(await Bun.file(join(out, "catalog", "postgres_imdb.jsonl")).exists()).toBe(true);
});

test("createDockerPostgresRunner wraps queries in json_agg, substitutes $1 arrays, and surfaces errors", async () => {
  expect(() => createDockerPostgresRunner("bad;name")).toThrow("invalid container name");
  const seen: { command: string[]; input: string }[] = [];
  const runSql = createDockerPostgresRunner("floci-pg", async (command, input) => {
    seen.push({ command, input });
    return { stdout: '[{"table_name":"title_basics"}]\n', stderr: "", exitCode: 0 };
  });
  expect(
    await runSql("SELECT table_name FROM t WHERE schema = ANY($1)", [["imdb", "o'neil"]]),
  ).toEqual([{ table_name: "title_basics" }]);
  expect(seen[0]!.command).toEqual([
    "docker",
    "exec",
    "-i",
    "floci-pg",
    "psql",
    "-U",
    "imdb_reader",
    "-d",
    "imdb",
    "-X",
    "-q",
    "-tA",
    "-v",
    "ON_ERROR_STOP=1",
  ]);
  expect(seen[0]!.input).toContain("ARRAY['imdb', 'o''neil']::text[]");
  expect(seen[0]!.input).toContain("json_agg(row_to_json(q))");

  const failing = createDockerPostgresRunner("floci-pg", async () => ({
    stdout: "",
    stderr: "Error: No such container",
    exitCode: 1,
  }));
  await expect(failing("SELECT 1")).rejects.toThrow("docker exec floci-pg failed (1)");

  await expect(runSql("SELECT '$1' AS lit, $1 AS val", ["\\'\n\\! id"])).resolves.toEqual([
    { table_name: "title_basics" },
  ]);
  expect(seen[1]!.input).toContain("SELECT '$1' AS lit, E'\\\\''\\n\\\\! id' AS val");

  await expect(runSql("SELECT $1", [Number.NaN])).rejects.toThrow("non-finite");
  await expect(runSql("SELECT $2", ["only-one"])).rejects.toThrow("missing parameter $2");
  await expect(defaultPsqlExec(["bun", "-e", "await Bun.sleep(5000)"], "", 20)).rejects.toThrow(
    "timed out",
  );
});

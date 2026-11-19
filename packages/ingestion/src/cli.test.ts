import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { main, type CliDeps } from "./cli";
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

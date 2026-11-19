import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CatalogEdge, CatalogNode, Chunk, DiscoveryBatch } from "../catalog";
import type { Corpus } from "../corpora";
import { createDocsConnector } from "./docs-connector";

const mdxCorpus: Corpus = {
  source: "bun",
  repo: "https://example.com/bun.git",
  path: "docs",
  format: "mdx",
  include: "**/*.mdx",
  exclude: ["lint/rules/**"],
};
const jekyllCorpus: Corpus = {
  source: "duckdb",
  repo: "https://example.com/duckdb-web.git",
  path: "docs/2.0",
  format: "jekyll",
  include: "**/*.md",
  exclude: [],
  maxFileBytes: 2000,
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "docs-connector-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const fixture = (path: string) => Bun.file(`${import.meta.dir}/../../fixtures/${path}`).text();
const write = async (corpus: Corpus, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    const file = join(dir, corpus.path, path);
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, text);
  }
};
const collect = async (connector: ReturnType<typeof createDocsConnector>) => {
  const batches: DiscoveryBatch[] = [];
  for await (const batch of connector.discover()) batches.push(batch);
  return {
    batches,
    nodes: batches.flatMap((b) => b.nodes),
    edges: batches.flatMap((b) => b.edges),
    chunks: batches.flatMap((b) => b.chunks ?? []),
  };
};
const ids = (nodes: CatalogNode[], kind: CatalogNode["kind"]) =>
  nodes.filter((n) => n.kind === kind).map((n) => n.id);
const edgesOf = (edges: CatalogEdge[], type: CatalogEdge["type"]) =>
  edges.filter((e) => e.type === type).map((e) => `${e.from} -> ${e.to}`);
const fences = (text: string) => (text.match(/^```/gm) ?? []).length;

test("emits a source node, a document per kept file and nothing for excluded files", async () => {
  await write(mdxCorpus, {
    "runtime/http/server.mdx": await fixture("mdx/server.mdx"),
    "runtime/guide.mdx": await fixture("mdx/guide.mdx"),
    "lint/rules/rule.mdx": "---\ntitle: Rule\n---\n\nGenerated.",
  });
  const connector = createDocsConnector({ corpus: mdxCorpus, dir, revision: "abc123" });
  const { batches, nodes, edges } = await collect(connector);
  expect(batches).toHaveLength(2);
  expect(nodes[0]).toMatchObject({
    id: "bun",
    kind: "source",
    source: "bun",
    props: { repo: mdxCorpus.repo, path: "docs", revision: "abc123" },
  });
  expect(ids(nodes, "document")).toEqual(["bun:runtime/guide.mdx", "bun:runtime/http/server.mdx"]);
  expect(nodes.find((n) => n.id === "bun:runtime/http/server.mdx")).toMatchObject({
    name: "Server",
    props: {
      title: "Server",
      description: "Use `Bun.serve` to start a high-performance HTTP server in Bun",
      path: "runtime/http/server.mdx",
    },
  });
  expect(edgesOf(edges, "CONTAINS")).toContain("bun -> bun:runtime/guide.mdx");
  expect(edgesOf(edges, "CONTAINS")).toContain("bun -> bun:runtime/http/server.mdx");
  expect(nodes.some((n) => n.id.includes("lint/rules"))).toBe(false);
});

test("section nodes follow the heading tree and carry the ids of their chunks", async () => {
  await write(mdxCorpus, { "runtime/http/server.mdx": await fixture("mdx/server.mdx") });
  const { nodes, edges, chunks } = await collect(createDocsConnector({ corpus: mdxCorpus, dir }));
  const doc = "bun:runtime/http/server.mdx";
  expect(ids(nodes, "section")).toEqual([
    `${doc}#_root`,
    `${doc}#basic-setup`,
    `${doc}#options`,
    `${doc}#options/tables`,
  ]);
  expect(edgesOf(edges, "CONTAINS").filter((e) => e.includes("#"))).toEqual([
    `${doc} -> ${doc}#_root`,
    `${doc}#_root -> ${doc}#basic-setup`,
    `${doc}#_root -> ${doc}#options`,
    `${doc}#options -> ${doc}#options/tables`,
  ]);
  const root = nodes.find((n) => n.id === `${doc}#_root`)!;
  expect(root.props?.chunkIds).toEqual([]);
  const claimed = nodes
    .filter((n) => n.kind === "section")
    .flatMap((n) => n.props?.chunkIds as string[]);
  expect(claimed.toSorted()).toEqual(chunks.map((c) => c.id).toSorted());
  expect(new Set(claimed).size).toBe(claimed.length);
  expect(chunks.every((c) => c.docId === doc)).toBe(true);
});

test("a chunk is prefixed with its section path and sections without blocks give no chunks", async () => {
  await write(mdxCorpus, { "runtime/http/server.mdx": await fixture("mdx/server.mdx") });
  const { chunks } = await collect(createDocsConnector({ corpus: mdxCorpus, dir }));
  const setup = chunks.filter((c) => c.sectionPath === "Server > Basic Setup");
  expect(setup.length).toBeGreaterThan(0);
  expect(setup[0]!.text.startsWith("Server > Basic Setup\n\n")).toBe(true);
  expect(chunks.some((c) => c.sectionPath === "Server")).toBe(false);
  expect(setup.map((c) => c.index)).toEqual(setup.map((_, i) => i));
  expect(setup[0]!.id).toBe(`${setup[0]!.sectionId}:0`);
});

test("duplicate headings get a numeric suffix", async () => {
  await write(mdxCorpus, {
    "a.mdx": "---\ntitle: A\n---\n\n## Usage\n\nOne.\n\n## Usage\n\nTwo.\n\n### Usage\n\nThree.\n",
  });
  const { nodes } = await collect(createDocsConnector({ corpus: mdxCorpus, dir }));
  expect(ids(nodes, "section")).toEqual([
    "bun:a.mdx#_root",
    "bun:a.mdx#usage",
    "bun:a.mdx#usage-2",
    "bun:a.mdx#usage/usage",
  ]);
});

test("small blocks are packed whole: a code block under chunkSize is never split", async () => {
  const code = "```ts\n" + "const value = 1;\n".repeat(8) + "```";
  const text = ["---", "title: A", "---", "", "x".repeat(200), "", code, "", "y".repeat(100), ""];
  await write(mdxCorpus, { "a.mdx": text.join("\n") });
  const { chunks } = await collect(
    createDocsConnector({ corpus: mdxCorpus, dir, chunkSize: 300, chunkOverlap: 20 }),
  );
  expect(chunks).toHaveLength(2);
  expect(chunks.every((c) => fences(c.text) % 2 === 0)).toBe(true);
  expect(chunks.some((c) => c.text.includes(code))).toBe(true);
});

test("a block larger than chunkSize is split by the markdown splitter within the size", async () => {
  const sentence = "Bun is a fast JavaScript runtime. ";
  await write(mdxCorpus, { "a.mdx": `---\ntitle: A\n---\n\n${sentence.repeat(30)}\n` });
  const { chunks } = await collect(
    createDocsConnector({ corpus: mdxCorpus, dir, chunkSize: 200, chunkOverlap: 20 }),
  );
  const prefix = "A\n\n";
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks.every((c) => c.text.startsWith(prefix))).toBe(true);
  expect(chunks.every((c) => c.text.length - prefix.length <= 200)).toBe(true);
  expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
});

test("a link resolves to a document with the extension added or as a folder index", async () => {
  await write(mdxCorpus, {
    "start.mdx":
      "---\ntitle: Start\n---\n\n[a](/runtime/http) [b](/pm/cli) [c](/missing) [d](/start)\n",
    "runtime/http/index.mdx": "---\ntitle: HTTP\n---\n\nhttp",
    "pm/cli.mdx": "---\ntitle: CLI\n---\n\ncli",
  });
  const { edges } = await collect(createDocsConnector({ corpus: mdxCorpus, dir }));
  expect(edgesOf(edges, "LINKS_TO")).toEqual([
    "bun:start.mdx -> bun:runtime/http/index.mdx",
    "bun:start.mdx -> bun:pm/cli.mdx",
  ]);
});

test("jekyll: links with the extension resolve, files over maxFileBytes are skipped, limit keeps the first sorted", async () => {
  await write(jekyllCorpus, {
    "sql/introduction.md": await fixture("jekyll/introduction.md"),
    "sql/statements/select.md": await fixture("jekyll/select.md"),
    "sql/overview.md": "---\ntitle: Overview\n---\n\nShort.",
    "big.md": `---\ntitle: Big\n---\n\n${"x".repeat(3000)}`,
  });
  const all = await collect(createDocsConnector({ corpus: jekyllCorpus, dir, revision: "r1" }));
  expect(ids(all.nodes, "document")).toEqual([
    "duckdb:sql/introduction.md",
    "duckdb:sql/overview.md",
    "duckdb:sql/statements/select.md",
  ]);
  expect(edgesOf(all.edges, "LINKS_TO")).toEqual([
    "duckdb:sql/introduction.md -> duckdb:sql/statements/select.md",
    "duckdb:sql/introduction.md -> duckdb:sql/overview.md",
    "duckdb:sql/statements/select.md -> duckdb:sql/introduction.md",
  ]);
  const limited = await collect(createDocsConnector({ corpus: jekyllCorpus, dir, limit: 2 }));
  expect(ids(limited.nodes, "document")).toEqual([
    "duckdb:sql/introduction.md",
    "duckdb:sql/overview.md",
  ]);
  expect(edgesOf(limited.edges, "LINKS_TO")).toEqual([
    "duckdb:sql/introduction.md -> duckdb:sql/overview.md",
  ]);
});

test("a file that fails to parse is reported and the others are still processed", async () => {
  await write(mdxCorpus, {
    "good.mdx": "---\ntitle: Good\n---\n\n[bad](/bad) text",
    "bad.mdx": "---\ntitle: Bad\n---\n\nHello {broken",
  });
  const connector = createDocsConnector({ corpus: mdxCorpus, dir });
  const { nodes, edges } = await collect(connector);
  expect(ids(nodes, "document")).toEqual(["bun:good.mdx"]);
  expect(edgesOf(edges, "LINKS_TO")).toEqual([]);
  expect(connector.skipped()).toHaveLength(1);
  expect(connector.skipped()[0]!.path).toBe("bad.mdx");
  expect(connector.skipped()[0]!.reason).toContain("bad.mdx");
});

test("two runs produce identical batches", async () => {
  await write(mdxCorpus, {
    "runtime/http/server.mdx": await fixture("mdx/server.mdx"),
    "runtime/guide.mdx": await fixture("mdx/guide.mdx"),
  });
  const connector = createDocsConnector({ corpus: mdxCorpus, dir, revision: "r" });
  const first = await collect(connector);
  const second = await collect(connector);
  expect(second.batches).toEqual(first.batches);
});

test("a corpus with no matching files still yields the source node", async () => {
  await mkdir(join(dir, mdxCorpus.path), { recursive: true });
  const { batches, nodes } = await collect(createDocsConnector({ corpus: mdxCorpus, dir }));
  expect(batches).toHaveLength(1);
  expect(nodes.map((n) => n.id)).toEqual(["bun"]);
});

test("chunks reference the document they belong to", async () => {
  await write(mdxCorpus, { "a.mdx": "---\ntitle: A\n---\n\n## One\n\nText.\n" });
  const { chunks } = await collect(createDocsConnector({ corpus: mdxCorpus, dir }));
  const chunk: Chunk = chunks[0]!;
  expect(chunk).toEqual({
    id: "bun:a.mdx#one:0",
    docId: "bun:a.mdx",
    sectionId: "bun:a.mdx#one",
    sectionPath: "A > One",
    index: 0,
    text: "A > One\n\nText.",
  });
});

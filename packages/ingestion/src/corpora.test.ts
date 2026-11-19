import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { corpora, corpusDir, fetchCorpus, type Run } from "./corpora";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "corpora-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const recorder = (revision = "abc123\n") => {
  const calls: { cmd: string[]; cwd?: string }[] = [];
  const run: Run = async (cmd, cwd) => {
    calls.push({ cmd, cwd });
    return cmd[1] === "rev-parse" ? revision : "";
  };
  return { calls, run };
};

test("the corpus definitions name the repos, paths and filters", () => {
  expect(corpora.bun).toMatchObject({
    source: "bun",
    path: "docs",
    format: "mdx",
    include: "**/*.mdx",
    exclude: ["lint/rules/**"],
  });
  expect(corpora.duckdb).toMatchObject({
    source: "duckdb",
    path: "docs/2.0",
    format: "jekyll",
    include: "**/*.md",
    exclude: [],
    maxFileBytes: 150_000,
  });
});

test("corpusDir puts each source under <outDir>/corpora", () => {
  expect(corpusDir("out/ingestion", "bun")).toBe("out/ingestion/corpora/bun");
});

test("a fresh directory is cloned sparse and shallow, then its revision is read", async () => {
  const { calls, run } = recorder();
  const dir = join(root, "bun");
  expect(await fetchCorpus(corpora.bun, dir, run)).toEqual({ revision: "abc123" });
  expect(calls).toEqual([
    {
      cmd: [
        "git",
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        corpora.bun.repo,
        dir,
      ],
      cwd: undefined,
    },
    { cmd: ["git", "sparse-checkout", "set", "docs"], cwd: dir },
    { cmd: ["git", "rev-parse", "HEAD"], cwd: dir },
  ]);
});

test("an existing clone is fetched and reset, not pulled", async () => {
  const { calls, run } = recorder("def456");
  const dir = join(root, "duckdb");
  await mkdir(join(dir, ".git"), { recursive: true });
  expect(await fetchCorpus(corpora.duckdb, dir, run)).toEqual({ revision: "def456" });
  expect(calls).toEqual([
    { cmd: ["git", "fetch", "--depth", "1", "origin"], cwd: dir },
    { cmd: ["git", "reset", "--hard", "FETCH_HEAD"], cwd: dir },
    { cmd: ["git", "rev-parse", "HEAD"], cwd: dir },
  ]);
});

test("a failing command propagates and stops the sequence", async () => {
  const calls: string[][] = [];
  const run: Run = async (cmd) => {
    calls.push(cmd);
    throw new Error("network down");
  };
  await expect(fetchCorpus(corpora.bun, join(root, "bun"), run)).rejects.toThrow("network down");
  expect(calls).toHaveLength(1);
});

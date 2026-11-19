import { existsSync } from "node:fs";
import { join } from "node:path";

// A documentation corpus: a folder of a git repo, fetched on demand and never committed.
export type Corpus = {
  source: string;
  repo: string;
  // The folder to check out, and the folder file paths are relative to.
  path: string;
  format: "mdx" | "jekyll";
  // Glob of the files to ingest, relative to `path`.
  include: string;
  // Globs of files to leave out, relative to `path`.
  exclude: string[];
  // Larger files are skipped (generated API dumps).
  maxFileBytes?: number;
};

export const corpora = {
  bun: {
    source: "bun",
    repo: "https://github.com/oven-sh/bun.git",
    path: "docs",
    format: "mdx",
    include: "**/*.mdx",
    // 1,051 generated lint rule pages.
    exclude: ["lint/rules/**"],
  },
  duckdb: {
    source: "duckdb",
    repo: "https://github.com/duckdb/duckdb-web.git",
    path: "docs/2.0",
    format: "jekyll",
    include: "**/*.md",
    exclude: [],
    // Four generated API dumps are larger than this.
    maxFileBytes: 150_000,
  },
} satisfies Record<string, Corpus>;

export type CorpusName = keyof typeof corpora;

// Runs a command and returns its output; the CLI passes one backed by `Bun.$`.
export type Run = (cmd: string[], cwd?: string) => Promise<string>;

export const corpusDir = (outDir: string, source: string) => `${outDir}/corpora/${source}`;

// Clones the corpus (shallow, sparse) or brings an existing clone up to date, and returns the
// commit it is at.
export const fetchCorpus = async (
  corpus: Corpus,
  dir: string,
  run: Run,
): Promise<{ revision: string }> => {
  if (existsSync(join(dir, ".git"))) {
    await run(["git", "fetch", "--depth", "1", "origin"], dir);
    await run(["git", "reset", "--hard", "FETCH_HEAD"], dir);
  } else {
    await run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", corpus.repo, dir]);
    await run(["git", "sparse-checkout", "set", corpus.path], dir);
  }
  return { revision: (await run(["git", "rev-parse", "HEAD"], dir)).trim() };
};

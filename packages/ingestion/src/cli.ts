import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import type { Connector } from "./catalog";
import { createJsonlCatalogSink } from "./catalog-sink";
import { ConfigError, loadConfig } from "./config";
import { createDocsConnector } from "./connectors/docs-connector";
import { corpora, corpusDir, fetchCorpus, type CorpusName, type Run } from "./corpora";
import { evaluateQuery, rankDocs, summarize, type JudgedQuery } from "./evaluation";
import { createIngestion } from "./ingestion";
import { mapLimit } from "./map-limit";
import { createEmbedder, type Embedder, type EmbedderConfig } from "./platform/embeddings-client";
import { createQdrantIndex, type QdrantConfig, type VectorIndex } from "./platform/qdrant-client";

// What the commands reach outside the process with; tests pass fakes.
export type CliDeps = {
  run: Run;
  createEmbedder: (config: EmbedderConfig) => Promise<Embedder>;
  createVectorIndex: (config: QdrantConfig) => Promise<VectorIndex>;
};

export const defaultDeps: CliDeps = {
  run: async (cmd, cwd) => await (cwd ? $`${cmd}`.cwd(cwd) : $`${cmd}`).quiet().text(),
  createEmbedder: (config) => createEmbedder(fetch, config),
  createVectorIndex: (config) => createQdrantIndex(fetch, config),
};

const USAGE = [
  "usage: ingestion <command>",
  "  fetch <bun|duckdb|all>",
  "  ingest <bun|duckdb|all> [--dry-run] [--limit N]",
  "  search <query...> [--source bun|duckdb]",
  "  eval",
].join("\n");

// Corpus text is not trusted: control characters (ESC and friends) would act on the terminal.
const printable = (value: unknown) => String(value).replace(/\p{Cc}/gu, " ");

// A mistake the user can fix: the message is printed as it is, without a stack.
class CliError extends Error {}

type Config = ReturnType<typeof loadConfig>;

const sourcesOf = (name: string | undefined): CorpusName[] => {
  if (name === "all") return Object.keys(corpora) as CorpusName[];
  if (name && Object.hasOwn(corpora, name)) return [name as CorpusName];
  throw new CliError(
    `unknown source "${name ?? ""}", expected one of: ${Object.keys(corpora).join(", ")}, all`,
  );
};

const parseLimit = (value: string | undefined) => {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value))
    throw new CliError(`--limit must be a positive integer, got "${value}"`);
  return Number(value);
};

const embedderConfig = (config: Config): EmbedderConfig => {
  if (!config.EMBEDDING_URL) {
    throw new CliError(
      "EMBEDDING_URL is required: the base URL of an OpenAI-compatible embeddings server, for example http://127.0.0.1:8000",
    );
  }
  if (!config.EMBEDDING_MODEL) {
    throw new CliError("EMBEDDING_MODEL is required: the model the embeddings server serves");
  }
  return {
    url: config.EMBEDDING_URL,
    model: config.EMBEDDING_MODEL,
    apiKey: config.EMBEDDING_API_KEY || undefined,
    documentPrefix: config.EMBEDDING_DOCUMENT_PREFIX || undefined,
    queryPrefix: config.EMBEDDING_QUERY_PREFIX || undefined,
  };
};

// The embedder first: its dimension is what the collection is created with.
const openIndex = (config: Config, deps: CliDeps, dimension: number) =>
  deps.createVectorIndex({
    url: config.QDRANT_URL,
    collection: config.QDRANT_COLLECTION,
    dimension,
    apiKey: config.QDRANT_API_KEY || undefined,
  });

const open = async (config: Config, deps: CliDeps) => {
  const embedder = await deps.createEmbedder(embedderConfig(config));
  return { embedder, vectorIndex: await openIndex(config, deps, embedder.dimension) };
};

const connectorFor = async (
  source: CorpusName,
  config: Config,
  deps: CliDeps,
  limit: number | undefined,
): Promise<Connector> => {
  const corpus = corpora[source];
  const dir = corpusDir(config.OUT_DIR, source);
  if (!existsSync(join(dir, corpus.path))) {
    throw new CliError(`${source} is not fetched: run "fetch ${source}" first`);
  }
  const revision = (await deps.run(["git", "rev-parse", "HEAD"], dir)).trim();
  return createDocsConnector({
    corpus,
    dir,
    revision,
    limit,
    chunkSize: config.CHUNK_SIZE,
    chunkOverlap: config.CHUNK_OVERLAP,
  });
};

const skippedLines = (connector: Connector) =>
  connector
    .skipped()
    .map(({ path, reason }) => `  skipped ${printable(path)}: ${printable(reason.split("\n")[0])}`);

const fetchCommand = async (names: CorpusName[], config: Config, deps: CliDeps) => {
  const revisions = await Promise.all(
    names.map(async (source) => {
      const { revision } = await fetchCorpus(
        corpora[source],
        corpusDir(config.OUT_DIR, source),
        deps.run,
      );
      return `${source}: ${revision}`;
    }),
  );
  for (const line of revisions) console.log(line);
};

const dryRun = async (connector: Connector): Promise<string[]> => {
  let documents = 0;
  let nodes = 0;
  let edges = 0;
  let chunks = 0;
  let characters = 0;
  for await (const batch of connector.discover()) {
    documents += batch.nodes.filter((node) => node.kind === "document").length;
    nodes += batch.nodes.length;
    edges += batch.edges.length;
    for (const chunk of batch.chunks ?? []) {
      chunks += 1;
      characters += chunk.text.length;
    }
  }
  return [
    `${connector.source}: ${documents} documents, ${nodes} nodes, ${edges} edges, ${chunks} chunks (${characters} characters), ${connector.skipped().length} skipped`,
    ...skippedLines(connector),
  ];
};

const ingestCommand = async (
  names: CorpusName[],
  flags: { dryRun: boolean; limit: number | undefined },
  config: Config,
  deps: CliDeps,
) => {
  const connectors = await Promise.all(
    names.map((source) => connectorFor(source, config, deps, flags.limit)),
  );
  if (flags.dryRun) {
    // Counting touches no server, so the sources run side by side; the lines print in order.
    for (const line of (await Promise.all(connectors.map(dryRun))).flat()) console.log(line);
    return;
  }
  const { embedder, vectorIndex } = await open(config, deps);
  // One source at a time: the embedding server and Qdrant take the documents in order.
  // oxlint-disable eslint/no-await-in-loop
  for (const connector of connectors) {
    // A --limit run covers part of the corpus, so it never replaces the full catalog.
    const file = `${connector.source}${flags.limit ? ".partial" : ""}.jsonl`;
    const catalogSink = createJsonlCatalogSink(join(config.OUT_DIR, "catalog", file));
    const summary = await createIngestion({ catalogSink, embedder, vectorIndex }).run(connector);
    console.log(
      `${connector.source}: ${summary.documents} documents, ${summary.nodes} nodes, ${summary.edges} edges, ${summary.chunks} chunks, ${summary.skipped} skipped`,
    );
    for (const line of skippedLines(connector)) console.log(line);
  }
  // oxlint-enable eslint/no-await-in-loop
};

const searchCommand = async (
  query: string,
  source: string | undefined,
  config: Config,
  deps: CliDeps,
) => {
  if (!query) throw new CliError(USAGE);
  if (source !== undefined) sourcesOf(source);
  const { embedder, vectorIndex } = await open(config, deps);
  const hits = await vectorIndex.search({
    vector: await embedder.embedQuery(query),
    k: 5,
    ...(source && { filter: { source } }),
  });
  for (const { score, payload } of hits) {
    const path = String(payload.section_path);
    // The stored text starts with the section path, which is printed above it.
    const text = String(payload.text).replace(path, "").replace(/\s+/g, " ").trim();
    console.log(
      `${score.toFixed(3)}  ${printable(payload.source)}  ${printable(payload.doc_id)}  ${printable(path)}`,
    );
    console.log(`  ${printable(text.slice(0, 120))}`);
  }
};

// Chunks retrieved per query, and the rank that counts as a hit.
const EVAL_CHUNKS = 40;
const EVAL_RANK = 5;

// Runs the judged queries against the index, with the query prefix if one is set and without it,
// and prints each query's best rank and the totals, so the two can be compared.
const evalCommand = async (config: Config, deps: CliDeps) => {
  const base = embedderConfig(config);
  const queries = (await Bun.file(
    `${import.meta.dir}/../eval/queries.json`,
  ).json()) as JudgedQuery[];
  const variants = [
    ...(base.queryPrefix ? [{ label: "with query prefix", embedder: base }] : []),
    { label: "plain (no query prefix)", embedder: { ...base, queryPrefix: undefined } },
  ];
  const embedders = await Promise.all(
    variants.map(({ embedder }) => deps.createEmbedder(embedder)),
  );
  const vectorIndex = await openIndex(config, deps, embedders[0]!.dimension);
  // The variants run side by side; the output below is printed in order.
  const all = await Promise.all(
    variants.map((_, i) =>
      mapLimit(queries, 2, async (judged) => {
        const hits = await vectorIndex.search({
          vector: await embedders[i]!.embedQuery(judged.query),
          k: EVAL_CHUNKS,
        });
        return evaluateQuery(judged, rankDocs(hits), EVAL_RANK);
      }),
    ),
  );
  for (const [i, { label }] of variants.entries()) {
    const results = all[i]!;
    console.log(label);
    for (const { hit, bestRank, query } of results) {
      console.log(`  ${hit ? "hit " : "miss"}  rank ${bestRank ?? "-"}  ${query}`);
    }
    const { hits, queries: total, recall, mrr, notFound } = summarize(results);
    console.log(
      `  recall@${EVAL_RANK} ${hits}/${total} (${recall.toFixed(2)})  MRR ${mrr.toFixed(3)}  not found ${notFound}`,
    );
  }
};

export const main = async (
  argv: string[],
  env: Record<string, string | undefined>,
  deps: CliDeps = defaultDeps,
): Promise<number> => {
  try {
    const [command, ...rest] = argv;
    const { values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean" },
        limit: { type: "string" },
        source: { type: "string" },
      },
    });
    const config = loadConfig(env);
    if (config.CHUNK_OVERLAP >= config.CHUNK_SIZE) {
      throw new CliError("CHUNK_OVERLAP must be smaller than CHUNK_SIZE");
    }
    switch (command) {
      case "fetch":
        await fetchCommand(sourcesOf(positionals[0]), config, deps);
        return 0;
      case "ingest":
        await ingestCommand(
          sourcesOf(positionals[0]),
          { dryRun: values["dry-run"] ?? false, limit: parseLimit(values.limit) },
          config,
          deps,
        );
        return 0;
      case "search":
        await searchCommand(positionals.join(" ").trim(), values.source, config, deps);
        return 0;
      case "eval":
        await evalCommand(config, deps);
        return 0;
      default:
        throw new CliError(USAGE);
    }
  } catch (err) {
    // Only the message: an error object can carry more than is safe to print (a config error
    // once carried the whole environment), and its text can come from a server or a file name.
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      err instanceof CliError || err instanceof ConfigError ? message : printable(message),
    );
    return 1;
  }
};

if (import.meta.main) process.exit(await main(process.argv.slice(2), process.env));

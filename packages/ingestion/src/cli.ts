import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { $ } from "bun";

import type { Connector } from "./catalog";
import {
  createJsonlCatalogSink,
  createMultiCatalogSink,
  createNeo4jCatalogSink,
} from "./catalog-sink";
import { ConfigError, loadConfig } from "./config";
import { createDocsConnector } from "./connectors/docs-connector";
import { imdbLogicalReferences } from "./connectors/imdb-relations";
import { createPostgresConnector, type PostgresSqlRunner } from "./connectors/postgres-connector";
import { corpora, corpusDir, fetchCorpus, type CorpusName, type Run } from "./corpora";
import { evaluateQuery, rankDocs, summarize, type JudgedQuery } from "./evaluation";
import { createIngestion } from "./ingestion";
import { mapLimit } from "./map-limit";
import { createEmbedder, type Embedder, type EmbedderConfig } from "./platform/embeddings-client";
import { createNeo4jStore, type GraphStore, type Neo4jConfig } from "./platform/neo4j-client";
import { createQdrantIndex, type QdrantConfig, type VectorIndex } from "./platform/qdrant-client";

export type PostgresRunnerHandle =
  | PostgresSqlRunner
  | { runSql: PostgresSqlRunner; close?: () => Promise<void> };

export const DEFAULT_IMDB_CONTAINER = "floci-gcp-cloudsql-floci-local-imdb";
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export type PsqlExec = (
  command: string[],
  input: string,
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

const defaultPsqlExec: PsqlExec = async (command, input) => {
  const child = Bun.spawn(command, {
    stdin: new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
};

const formatPgLiteral = (value: unknown): string => {
  if (Array.isArray(value)) {
    const items = value.map((item) => `'${String(item).replaceAll("'", "''")}'`).join(", ");
    return `ARRAY[${items}]::text[]`;
  }
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

export const createDockerPostgresRunner = (
  container: string,
  exec: PsqlExec = defaultPsqlExec,
): PostgresSqlRunner => {
  if (!CONTAINER_NAME.test(container)) {
    throw new CliError(`invalid container name "${container}"`);
  }
  return async (query, params = []) => {
    const substituted = query.replace(/\$(\d+)\b/g, (_m, index) =>
      formatPgLiteral(params[Number(index) - 1]),
    );
    const wrapped = `SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)\nFROM (\n${substituted}\n) AS q;\n`;
    const command = [
      "docker",
      "exec",
      "-i",
      container,
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
    ];
    const { stdout, stderr, exitCode } = await exec(command, wrapped);
    if (exitCode !== 0) {
      throw new Error(`docker exec ${container} failed (${exitCode}): ${stderr.trim()}`);
    }
    return JSON.parse(stdout.trim() || "[]") as Record<string, unknown>[];
  };
};

// What the commands reach outside the process with; tests pass fakes.
export type CliDeps = {
  run: Run;
  createEmbedder: (config: EmbedderConfig) => Promise<Embedder>;
  createVectorIndex: (config: QdrantConfig) => Promise<VectorIndex>;
  createGraphStore?: (config: Neo4jConfig) => GraphStore;
  createPostgresRunner?: (databaseUrl: string) => PostgresRunnerHandle;
  createContainerPostgresRunner?: (container: string) => PostgresRunnerHandle;
};

export const defaultDeps: CliDeps = {
  run: async (cmd, cwd) => await (cwd ? $`${cmd}`.cwd(cwd) : $`${cmd}`).quiet().text(),
  createEmbedder: (config) => createEmbedder(fetch, config),
  createVectorIndex: (config) => createQdrantIndex(fetch, config),
  createGraphStore: (config) => createNeo4jStore(fetch, config),
  createPostgresRunner: (databaseUrl) => {
    const sql = new Bun.SQL(databaseUrl);
    return {
      runSql: (query, params = []) => sql.unsafe(query, params),
      close: () => sql.close(),
    };
  },
  createContainerPostgresRunner: (container) => createDockerPostgresRunner(container),
};

const USAGE = [
  "usage: ingestion <command>",
  "  fetch <bun|duckdb|all>",
  "  ingest <bun|duckdb|imdb|all> [--dry-run] [--limit N] [--container NAME]",
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

const neo4jConfig = (config: Config): Neo4jConfig | undefined =>
  config.NEO4J_URL
    ? {
        url: config.NEO4J_URL,
        database: config.NEO4J_DATABASE,
        user: config.NEO4J_USER || undefined,
        password: config.NEO4J_PASSWORD || undefined,
      }
    : undefined;

const sinkFor = (source: string, file: string, config: Config, deps: CliDeps) => {
  const jsonl = createJsonlCatalogSink(join(config.OUT_DIR, "catalog", file));
  const neo4j = neo4jConfig(config);
  if (!neo4j) return jsonl;
  const createGraph = deps.createGraphStore ?? defaultDeps.createGraphStore!;
  return createMultiCatalogSink([jsonl, createNeo4jCatalogSink(createGraph(neo4j), source)]);
};

const imdbConnector = (
  config: Config,
  deps: CliDeps,
  containerFlag?: string,
): { connector: Connector; close?: () => Promise<void> } => {
  const container = containerFlag || config.IMDB_CONTAINER;
  const handle =
    !container && config.IMDB_DATABASE_URL
      ? (deps.createPostgresRunner ?? defaultDeps.createPostgresRunner!)(config.IMDB_DATABASE_URL)
      : (deps.createContainerPostgresRunner ?? defaultDeps.createContainerPostgresRunner!)(
          container || DEFAULT_IMDB_CONTAINER,
        );
  const runSql = typeof handle === "function" ? handle : handle.runSql;
  const close = typeof handle === "function" ? undefined : handle.close;
  return {
    connector: createPostgresConnector({
      source: "postgres:imdb",
      schemas: ["imdb"],
      runSql,
      logicalReferences: imdbLogicalReferences,
    }),
    close,
  };
};

const ingestCommand = async (
  target: string | undefined,
  flags: { dryRun: boolean; limit: number | undefined; container: string | undefined },
  config: Config,
  deps: CliDeps,
) => {
  const closers: (() => Promise<void>)[] = [];
  const connectors =
    target === "imdb"
      ? [imdbConnector(config, deps, flags.container)].map(({ connector, close }) => {
          if (close) closers.push(close);
          return connector;
        })
      : await Promise.all(
          sourcesOf(target).map((source) => connectorFor(source, config, deps, flags.limit)),
        );
  try {
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
      const slug = connector.source.replace(/[^a-zA-Z0-9_-]+/g, "_");
      const file = `${slug}${flags.limit ? ".partial" : ""}.jsonl`;
      const catalogSink = sinkFor(connector.source, file, config, deps);
      const summary = await createIngestion({ catalogSink, embedder, vectorIndex }).run(connector);
      console.log(
        `${connector.source}: ${summary.documents} documents, ${summary.nodes} nodes, ${summary.edges} edges, ${summary.chunks} chunks, ${summary.skipped} skipped`,
      );
      for (const line of skippedLines(connector)) console.log(line);
    }
    // oxlint-enable eslint/no-await-in-loop
  } finally {
    await Promise.all(closers.map((close) => close()));
  }
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
        container: { type: "string" },
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
          positionals[0],
          {
            dryRun: values["dry-run"] ?? false,
            limit: parseLimit(values.limit),
            container: values.container,
          },
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

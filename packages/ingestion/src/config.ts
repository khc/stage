import { createConfigLoader } from "@stage/http/config";
import { t } from "elysia";

// The embedding server is optional here: `fetch` and `ingest --dry-run` work without one, so the
// commands that need it check for it themselves. An empty value counts as unset.
const fields = {
  // Qdrant, and the collection the chunks go into.
  QDRANT_URL: t.String({ minLength: 1 }),
  QDRANT_COLLECTION: t.String({ minLength: 1 }),
  // Sent as the `api-key` header, for a Qdrant started with QDRANT__SERVICE__API_KEY.
  QDRANT_API_KEY: t.Optional(t.String()),
  // Base URL of an OpenAI-compatible embeddings server (oMLX), and the model it serves.
  EMBEDDING_URL: t.Optional(t.String()),
  EMBEDDING_MODEL: t.Optional(t.String()),
  EMBEDDING_API_KEY: t.Optional(t.String()),
  // Text added before each document or query, for models that expect an instruction.
  EMBEDDING_DOCUMENT_PREFIX: t.Optional(t.String()),
  EMBEDDING_QUERY_PREFIX: t.Optional(t.String()),
  // Characters per chunk, and the overlap between the pieces of an oversize block.
  CHUNK_SIZE: t.Numeric({ minimum: 100, multipleOf: 1 }),
  CHUNK_OVERLAP: t.Numeric({ minimum: 0, multipleOf: 1 }),
  // Where the corpora, and the catalog files, go.
  OUT_DIR: t.String({ minLength: 1 }),
  // Neo4j HTTP Query API v2, optional for offline fetch/dry-run and JSONL-only runs.
  NEO4J_URL: t.Optional(t.String()),
  NEO4J_DATABASE: t.String({ minLength: 1 }),
  NEO4J_USER: t.Optional(t.String()),
  NEO4J_PASSWORD: t.Optional(t.String()),
  // PostgreSQL connection string or Floci container name for RDBMS metadata discovery (`ingest imdb`).
  IMDB_DATABASE_URL: t.Optional(t.String()),
  IMDB_CONTAINER: t.Optional(t.String()),
};

const defaults = {
  QDRANT_URL: "http://localhost:6333",
  QDRANT_COLLECTION: "docs",
  CHUNK_SIZE: "1000",
  CHUNK_OVERLAP: "100",
  OUT_DIR: "out/ingestion",
  NEO4J_DATABASE: "neo4j",
};

const load = createConfigLoader(fields, defaults);

// A setting does not match. Its message names the settings and never carries a value: the decode
// error of the loader holds the whole environment, API keys included, so it is not passed on.
export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

const invalidKeys = (env: Env) =>
  (Object.keys(fields) as (keyof typeof fields)[]).filter((key) => {
    try {
      createConfigLoader(
        { [key]: fields[key] },
        {},
      )({
        ...(key in defaults && { [key]: defaults[key as keyof typeof defaults] }),
        ...(env[key] !== undefined && { [key]: env[key] }),
      });
      return false;
    } catch {
      return true;
    }
  });

export const loadConfig = (env: Env) => {
  try {
    return load(env);
  } catch {
    const keys = invalidKeys(env);
    throw new ConfigError(
      `invalid configuration: ${keys.length > 0 ? keys.join(", ") : "a setting"} does not match what is expected (see .env.example)`,
    );
  }
};

import { expect, test } from "bun:test";

import { ConfigError, loadConfig } from "./config";

test("defaults point at the local Qdrant and leave the embedding server unset", () => {
  expect(loadConfig({})).toEqual({
    QDRANT_URL: "http://localhost:6333",
    QDRANT_COLLECTION: "docs",
    CHUNK_SIZE: 1000,
    CHUNK_OVERLAP: 100,
    OUT_DIR: "out/ingestion",
    NEO4J_DATABASE: "neo4j",
  });
});

test("values from the environment win, and the numbers are decoded", () => {
  const config = loadConfig({
    QDRANT_URL: "http://q:6333",
    QDRANT_API_KEY: "qk",
    EMBEDDING_URL: "http://127.0.0.1:8000",
    EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-8bit",
    EMBEDDING_QUERY_PREFIX: "Instruct: x\\nQuery: ",
    CHUNK_SIZE: "800",
    CHUNK_OVERLAP: "50",
    OUT_DIR: "/tmp/ingest",
  });
  expect(config).toMatchObject({
    QDRANT_URL: "http://q:6333",
    QDRANT_API_KEY: "qk",
    EMBEDDING_URL: "http://127.0.0.1:8000",
    EMBEDDING_MODEL: "Qwen3-Embedding-0.6B-8bit",
    EMBEDDING_QUERY_PREFIX: "Instruct: x\\nQuery: ",
    CHUNK_SIZE: 800,
    CHUNK_OVERLAP: 50,
    OUT_DIR: "/tmp/ingest",
  });
});

test("an undefined variable counts as missing and an empty optional one is accepted", () => {
  const config = loadConfig({
    CHUNK_SIZE: undefined,
    EMBEDDING_URL: "",
    EMBEDDING_DOCUMENT_PREFIX: "",
  });
  expect(config.CHUNK_SIZE).toBe(1000);
  expect(config.EMBEDDING_URL).toBe("");
});

test("an invalid number is rejected", () => {
  expect(() => loadConfig({ CHUNK_SIZE: "abc" })).toThrow();
  expect(() => loadConfig({ CHUNK_SIZE: "50" })).toThrow();
  expect(() => loadConfig({ CHUNK_OVERLAP: "-1" })).toThrow();
  expect(() => loadConfig({ QDRANT_URL: "" })).toThrow();
});

test("an invalid value is reported by name, without the environment", () => {
  const env = {
    CHUNK_SIZE: "abc",
    QDRANT_URL: "",
    QDRANT_API_KEY: "FAKE_TEST_KEY_123",
    NEO4J_PASSWORD: "FAKE_NEO4J_PASSWORD_789",
    IMDB_DATABASE_URL: "postgres://user:FAKE_DB_PASS@localhost:5432/imdb",
    OTHER: "FAKE_OTHER_456",
  };
  let error: unknown;
  try {
    loadConfig(env);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(ConfigError);
  const text = `${(error as Error).message} ${JSON.stringify(error)} ${Bun.inspect(error)}`;
  expect(text).toContain("CHUNK_SIZE");
  expect(text).toContain("QDRANT_URL");
  expect(text).not.toContain("FAKE_TEST_KEY_123");
  expect(text).not.toContain("FAKE_NEO4J_PASSWORD_789");
  expect(text).not.toContain("FAKE_DB_PASS");
  expect(text).not.toContain("FAKE_OTHER_456");
  expect(text).not.toContain("abc");
});

test("Neo4j and IMDB settings are decoded when present", () => {
  const config = loadConfig({
    NEO4J_URL: "http://localhost:7474",
    NEO4J_DATABASE: "stage",
    NEO4J_USER: "neo4j",
    NEO4J_PASSWORD: "secret",
    IMDB_DATABASE_URL: "postgres://imdb_reader:x@localhost:5432/imdb",
    IMDB_CONTAINER: "floci-pg",
  });
  expect(config).toMatchObject({
    NEO4J_URL: "http://localhost:7474",
    NEO4J_DATABASE: "stage",
    NEO4J_USER: "neo4j",
    NEO4J_PASSWORD: "secret",
    IMDB_DATABASE_URL: "postgres://imdb_reader:x@localhost:5432/imdb",
    IMDB_CONTAINER: "floci-pg",
  });
  expect(loadConfig({}).IMDB_CONTAINER).toBeUndefined();
});

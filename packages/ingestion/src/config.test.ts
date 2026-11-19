import { expect, test } from "bun:test";

import { loadConfig } from "./config";

test("defaults point at the local Qdrant and leave the embedding server unset", () => {
  expect(loadConfig({})).toEqual({
    QDRANT_URL: "http://localhost:6333",
    QDRANT_COLLECTION: "docs",
    CHUNK_SIZE: 1000,
    CHUNK_OVERLAP: 100,
    OUT_DIR: "out/ingestion",
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

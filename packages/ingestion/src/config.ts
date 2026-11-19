import { createConfigLoader } from "@stage/http/config";
import { t } from "elysia";

// The embedding server is optional here: `fetch` and `ingest --dry-run` work without one, so the
// commands that need it check for it themselves. An empty value counts as unset.
export const loadConfig = createConfigLoader(
  {
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
  },
  {
    QDRANT_URL: "http://localhost:6333",
    QDRANT_COLLECTION: "docs",
    CHUNK_SIZE: "1000",
    CHUNK_OVERLAP: "100",
    OUT_DIR: "out/ingestion",
  },
);

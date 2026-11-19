# @stage/ingestion

Ingestion pipelines for documentation corpora. Each corpus is fetched, normalized, split into
sections and chunks, embedded and stored in Qdrant, and described in a catalog file (documents,
sections and the links between them) that a graph database can load later.

```
fetch ─▶ docs-connector ─▶ embed (OpenAI-compatible /v1/embeddings) ─▶ Qdrant   (chunks)
                      └──────────────────────────────────────────────▶ JSONL    (catalog)
```

## Corpora

| Source   | Repo                | Folder     | Format                  | Left out                                     |
| -------- | ------------------- | ---------- | ----------------------- | -------------------------------------------- |
| `bun`    | `oven-sh/bun`       | `docs`     | MDX (`.mdx`)            | `lint/rules/**` (1,051 generated pages)      |
| `duckdb` | `duckdb/duckdb-web` | `docs/2.0` | Jekyll markdown (`.md`) | files over 150 KB (four generated API dumps) |

The corpora are cloned (shallow, sparse) into `OUT_DIR/corpora/<source>` and never committed.
`OUT_DIR` is relative to this package (`packages/ingestion/out/ingestion` by default, which
`.gitignore` covers).

## Run

Needs Qdrant and, to embed, an OpenAI-compatible embeddings server (oMLX on the host). Copy the
`Ingestion` section of `.env.example` into `.env` and set `EMBEDDING_URL` and `EMBEDDING_MODEL`.

```sh
docker compose up -d qdrant                     # from the repo root
bun --filter @stage/ingestion fetch all
bun --filter @stage/ingestion ingest all --dry-run          # counts only, no server needed
bun --filter @stage/ingestion ingest bun --limit 20         # a quick trial
bun --filter @stage/ingestion ingest all
bun --filter @stage/ingestion search "start an http server" --source bun
```

- `ingest` replaces each document's points in Qdrant (embed, delete, upsert), so a re-run does not
  duplicate anything. It does not remove documents that left the corpus; drop the collection to
  start over.
- `--limit N` takes the first N documents in path order and writes its catalog to
  `<source>.partial.jsonl`, so a trial run never replaces a full catalog.
- A file that does not parse (for example malformed MDX) is skipped and listed.
- The vector size is read from the embeddings server. Switching model needs a new collection
  (`QDRANT_COLLECTION`); the client refuses to reuse one of another size.

## Catalog

`OUT_DIR/catalog/<source>.jsonl` is written only when a run completes (a failed run leaves the previous
file in place), and has one JSON object per line: all nodes first, as `{"node": ...}`,
then all edges, as `{"edge": ...}`. Ids are deterministic and source-scoped, so a re-run writes the
same bytes.

| Node kind  | Id                                        | Notes                                              |
| ---------- | ----------------------------------------- | -------------------------------------------------- |
| `source`   | `bun`                                     | `repo`, `path`, `revision` (the commit fetched)    |
| `document` | `bun:runtime/http/server.mdx`             | `title`, `description`, `path`                     |
| `section`  | `bun:runtime/http/server.mdx#basic-setup` | `path`, `depth`, `chunkIds`; `#_root` is the intro |

Edges: `CONTAINS` (source to document, document to its root section, section to sub-section) and
`LINKS_TO` (document to document, from internal links). A chunk id is `<section id>:<n>`; its
Qdrant point id is a UUIDv5 of it, and the payload holds `source`, `doc_id`, `section_id`,
`section_path`, `chunk_index`, `chunk_id` and `text`.

## Tests

`bun test packages/ingestion` runs offline. Two contract tests run only when their server is
configured: Qdrant when `QDRANT_URL` is set, the embeddings endpoint when `EMBEDDING_URL` and
`EMBEDDING_MODEL` are set.

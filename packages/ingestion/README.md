# @stage/ingestion

Ingestion pipelines for documentation corpora. Each corpus is fetched, normalized, split into
sections and chunks, embedded and stored in Qdrant, and described in a catalog file (documents,
sections and the links between them) that a graph database can load later.

```
fetch ─▶ docs-connector     ─▶ embed (OpenAI-compatible /v1/embeddings) ─▶ Qdrant       (chunks)
      └─ postgres-connector ─┴──────────────────────────────────────────▶ JSONL / Neo4j (catalog)
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

Needs Qdrant and, to embed, an OpenAI-compatible embeddings server (oMLX on the host). Optionally set `RERANK_MODEL` (plus `RERANK_URL` / `RERANK_API_KEY` if different from `EMBEDDING_URL` / `EMBEDDING_API_KEY`) to enable two-stage cross-encoder reranking (`POST /v1/rerank`: fetch 25 candidates in `search`, rerank to top 5). Set
`NEO4J_URL` (plus `NEO4J_USER` / `NEO4J_PASSWORD`) to also write the catalog graph to Neo4j.
`ingest imdb` queries Floci's `floci-gcp-cloudsql-floci-local-imdb` container via `docker exec` by
default (override with `--container` or `IMDB_DATABASE_URL`). Copy the `Ingestion` and
`Neo4j graph discovery` sections of `.env.example` into `.env`.

```sh
docker compose up -d qdrant neo4j               # from the repo root
bun --filter @stage/ingestion fetch all
bun --filter @stage/ingestion ingest all --dry-run          # counts only, no server needed
bun --filter @stage/ingestion ingest bun --limit 20         # a quick trial
bun --filter @stage/ingestion ingest all
bun --filter @stage/ingestion ingest imdb                   # Postgres metadata -> Neo4j & Qdrant
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

## Retrieval evaluation

`bun --filter @stage/ingestion eval` runs the judged questions in `eval/queries.json` against the
index and reports, per question, whether an acceptable document is in the top 5 (`hit`) and its best
rank, then recall@5 (the share of questions with a hit) and MRR (the mean of 1 / best rank, a miss
counting 0). A document counts at the position of its first chunk among the 40 best chunks. With
`EMBEDDING_QUERY_PREFIX` set it runs twice, with the instruction and plain, so the two can be
compared; when `RERANK_MODEL` is set, each variant also runs a `+ rerank` pass over those 40
chunks. Each `relevant` entry is a document id or a prefix ending in `*`; any one of them is a
good answer. Write a judgment from what the documents are about, before running the questions, and
note it when an entry is changed after seeing results.

## Catalog

`OUT_DIR/catalog/<source>.jsonl` is written only when a run completes (a failed run leaves the previous
file in place), and has one JSON object per line: all nodes first, as `{"node": ...}`,
then all edges, as `{"edge": ...}`. Ids are deterministic and source-scoped, so a re-run writes the
same bytes.

| Node kind  | Id                                        | Notes                                              |
| ---------- | ----------------------------------------- | -------------------------------------------------- |
| `source`   | `bun`, `postgres:imdb`                    | `repo`/`path`/`revision` or `engine`/`schemas`     |
| `document` | `bun:runtime/http/server.mdx`             | `title`, `description`, `path`                     |
| `section`  | `bun:runtime/http/server.mdx#basic-setup` | `path`, `depth`, `chunkIds`; `#_root` is the intro |
| `schema`   | `postgres:imdb:imdb`                      | `schema`                                           |
| `table`    | `postgres:imdb:imdb.title_basics`         | `schema`, `tableType`, `indexes`, `comment`        |
| `column`   | `postgres:imdb:imdb.title_basics.tconst`  | `table`, `dataType`, `nullable`, `primaryKey`      |

Edges: `CONTAINS` (source to document/schema, document to root section, section to sub-section,
schema to table, table to column), `LINKS_TO` (document to document, from internal links), and
`REFERENCES` (column to column, from declared FKs and logical IMDb joins). A chunk id is
`<section id>:<n>`; its Qdrant point id is a UUIDv5 of it, and the payload holds `source`, `doc_id`,
`section_id`, `section_path`, `chunk_index`, `chunk_id` and `text`.

## Tests

`bun test packages/ingestion` runs offline. Contract tests run only when their server is configured:
Qdrant when `QDRANT_URL` is set, the embeddings endpoint when `EMBEDDING_URL` and `EMBEDDING_MODEL`
are set, the reranker when `RERANK_MODEL` (plus `RERANK_URL` or `EMBEDDING_URL`) is set, and Neo4j when `NEO4J_URL` is set.

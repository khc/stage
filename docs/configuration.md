# Configuration

Every setting is an environment variable. This page lists them, explains how a model is chosen, and shows where each process reads its values.

## Where settings come from

- **`.env` in the repository root** (gitignored). Start from [`.env.example`](../.env.example), which lists every variable with a comment. Bun and `docker compose` both read it, and the service start and dev scripts and the dashboard (through Vite) load the root file even when Bun runs from a workspace directory.
- **Terraform** passes values to the agent jobs. `task tf:apply` reads `GEMINI_API_KEY`, `AGENT_MODEL`, `GOOGLE_GENAI_USE_VERTEXAI`, every `OTEL_*` variable and the knowledge job's Qdrant, embedding and Exa settings from `.env`. Change `.env`, then run `task tf:apply` again; the jobs do not read `.env` themselves.
- **Defaults** are in code. A variable not listed here uses the default shown, or is unset.

## Control service

| Variable                                    | Default                                          | Meaning                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GCP_PROJECT`, `GCP_REGION`                 | `floci-local`, `us-central1` (in `.env.example`) | The project and region that hold the agent jobs. Required                                                                                    |
| `AGENT_JOBS`                                | `*` (in `.env.example`)                          | Jobs that tasks may use: comma-separated names, or `*` for any job. Required. Use names, not `*`, anywhere that is not local                 |
| `PORT`, `HOST`                              | `3000`, `127.0.0.1`                              | Listen address. `HOST=0.0.0.0` exposes unauthenticated job execution to the network                                                          |
| `PUBSUB_TOPIC`                              | unset                                            | Topic the agents publish session events to. Without it, the messages stream sends stored events only                                         |
| `PLATFORM_EVENTS_TOPIC`                     | unset                                            | Topic for the service's own events and `GET /events`. Without it, `/events` answers `501`                                                    |
| `EXTRACT_URL`                               | unset                                            | Base URL of the extract service. Without it, document routes answer `501`                                                                    |
| `EXTRACT_AUDIENCE`                          | unset                                            | GCP only: the audience of the Google ID token sent to extract                                                                                |
| `AGENT_SERVICES`                            | unset                                            | JSON object of job name to quick-service URL. Without it, quick runs are unavailable                                                         |
| `AGENT_SERVICES_ID_TOKEN`                   | unset                                            | GCP only: send a Google ID token to the quick services (https only)                                                                          |
| `QUICK_BUDGET_MS`                           | `60000`                                          | Time limit of a quick run, at most `240000`. Keep it below the services' request timeout                                                     |
| `PUBLIC_URL`                                | origin of the request                            | The address A2A Agent Cards advertise                                                                                                        |
| `A2A_TIMEOUT_MS`                            | `240000`                                         | How long the A2A gateway waits for a delegated run, at most `250000`                                                                         |
| `SCHEDULER_TARGET_URL`, `SCHEDULER_INVOKER` | unset                                            | Reserved for task schedules. The config loads, but the schedule routes are not built yet (see the [scheduler plan](plans/scheduler-plan.md)) |

### Local emulators

With these set, the clients talk to Floci. Without them they use the real Google Cloud APIs and need Application Default Credentials.

| Variable                  | Local value                                              |
| ------------------------- | -------------------------------------------------------- |
| `FIRESTORE_EMULATOR_HOST` | `localhost:4588`                                         |
| `CLOUD_RUN_EMULATOR_HOST` | `localhost:4588`                                         |
| `PUBSUB_EMULATOR_HOST`    | `localhost:4588`                                         |
| `GOOGLE_CLOUD_PROJECT`    | `floci-local` (also the only project the Floci UI shows) |

Restart `bun run dev:service` after changing them. With `FIRESTORE_EMULATOR_HOST` set, `bun run test:integration` runs the Firestore integration tests, which fail if Floci is down. `bun run test` never runs them.

## Agent jobs

| Variable                    | Default            | Meaning                                                                                                                                                                                                                                    |
| --------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GEMINI_API_KEY`            | none               | Credential for Gemini. `GOOGLE_API_KEY` and `GOOGLE_GENAI_API_KEY` also work. Required for the default model                                                                                                                               |
| `AGENT_MODEL`               | `gemini-2.5-flash` | The default model of every agent                                                                                                                                                                                                           |
| `GOOGLE_GENAI_USE_VERTEXAI` | unset              | `true` selects Vertex AI. With an API key it is the express mode, for example `AGENT_MODEL=publishers/google/models/gemini-2.5-flash`. Without a key it needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Google Cloud credentials |
| `EXA_API_KEY`               | unset              | Web search for `discovery-assistant`. Rebuild the knowledge image and run `task tf:apply` after setting it                                                                                                                                 |

The job also gets `GOOGLE_CLOUD_PROJECT`, the emulator hosts, `PUBSUB_TOPIC`, `TASK_ID` (per run) and, for a resume, `SESSION_ID`. No prompt is stored in the job definition. Jobs reach Floci at `floci-gcp:4588` (`emulator_host` in `infra/envs/local`), and the topic is `agent_events_topic` (default `stage--agent-events--ps-lcl`).

> Floci stores `GEMINI_API_KEY` and `EXA_API_KEY` as plain job environment values, and in local Terraform state. Use throwaway keys. Floci cannot read Secret Manager into a job; see [Floci notes](floci-gcp.md#known-limits-verified-against-floci-gcp-0120).

ADK 2.4.0 cannot do Vertex express mode itself, so `packages/agents/src/model.ts` provides a small `Gemini` subclass.

## Models and providers

A run uses the first of these that is set:

1. The `model` in the run request (`POST /tasks/:taskId/run`).
2. The task's `defaultModel`, set when the task was created.
3. The job's `AGENT_MODEL`.

`model` and `defaultModel` are `{ providerId, model }`: ids only, never a key. A **provider** is a saved model endpoint that you manage in the dashboard under **Settings → Providers** or with `/providers`:

| Kind             | Use                                                                  |
| ---------------- | -------------------------------------------------------------------- |
| `google`         | Gemini API                                                           |
| `google-express` | Vertex AI express-mode key. Generation only, with no model-list call |
| `openai`         | Any OpenAI-compatible server, with a `baseUrl`                       |

A model is selectable when its provider is enabled, the model is in the provider's `models` list, and it is not in `disabledModels`. Otherwise the API answers `400 unknown_model`. A provider's API key is write-only: responses show `hasApiKey` and `apiKeyHint`.

## Event streaming

Set both topics for live updates in the dashboard:

```dotenv
PUBSUB_TOPIC=stage--agent-events--ps-lcl
PLATFORM_EVENTS_TOPIC=stage--platform-events--ps-lcl
```

Terraform creates the topics and sets `PUBSUB_TOPIC` on the jobs. The service must have the same topic names and the same `PUBSUB_EMULATOR_HOST`. See [API: events](api.md#events).

## Document extraction

Build and deploy the extract service with `task build:extract-service` and `task tf:create-extract` (which prints its URL), then set that URL as `EXTRACT_URL` for the service. It is a Cloud Run service owned by Terraform, so it is not in the compose file.

## Telemetry

`OTEL_*` variables turn on trace export. See [Observability](observability.md).

## Knowledge base, graph and IMDb

Used by `packages/ingestion` and the knowledge agents. All are optional. Setting `QDRANT_URL`, `EMBEDDING_URL` with `EMBEDDING_MODEL`, `RERANK_MODEL` or `NEO4J_URL` also turns on the matching contract tests in `bun run test`, which fail while that server is down.

| Variable                                                      | Meaning                                                                                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QDRANT_URL`, `QDRANT_COLLECTION`, `QDRANT_API_KEY`           | The vector index (`http://localhost:6333`, collection `docs`). Set the key in `QDRANT__SERVICE__API_KEY` too, with the same value, and never leave either empty |
| `EMBEDDING_URL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`       | An OpenAI-compatible embeddings server on the host, such as oMLX on port `8000`                                                                                 |
| `EMBEDDING_DOCUMENT_PREFIX`, `EMBEDDING_QUERY_PREFIX`         | Text added before each document or query, for models that expect an instruction                                                                                 |
| `RERANK_URL`, `RERANK_MODEL`, `RERANK_API_KEY`                | Optional reranker (`/v1/rerank`). `RERANK_URL` and the key default to the embedding ones                                                                        |
| `CHUNK_SIZE`, `CHUNK_OVERLAP`, `OUT_DIR`                      | Ingestion chunking and output folder                                                                                                                            |
| `NEO4J_URL`, `NEO4J_DATABASE`, `NEO4J_USER`, `NEO4J_PASSWORD` | The graph catalog. Set a password before `docker compose up -d neo4j`                                                                                           |
| `IMDB_DATABASE_URL`, `IMDB_CONTAINER`                         | Postgres for IMDb ingestion. Unset, it queries Floci's Postgres container with `docker exec`                                                                    |

`task tf:apply` passes `QDRANT_API_KEY`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `EMBEDDING_QUERY_PREFIX`, `RERANK_MODEL` and `RERANK_API_KEY` to the knowledge job. Its URLs and collection are Terraform variables (`qdrant_url`, `embedding_url`, `qdrant_collection` in `infra/envs/local`) that point at `host.docker.internal`. See [Agents](agents.md#knowledge-job).

## Running the control service

| Way                             | How                                                                          | Notes                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| On the host (recommended)       | `bun run dev:service`                                                        | Reads `.env`. Uses `localhost:4588` for Floci and listens on `127.0.0.1:3000`                                             |
| As a Cloud Run service in Floci | `task build:control-service`, then `task tf:create-service` (prints its URL) | Terraform owns it, and `task tf:remove-service` deletes it. Its image listens on `0.0.0.0:3000`. Use it to test the image |

The host process listens on `127.0.0.1`. A job that must call it, such as the orchestrator, reaches it at `GATEWAY_URL` (`gateway_url` in `infra/envs/local`, default `http://host.docker.internal:3000`), which needs `HOST=0.0.0.0` on the host.

## Dashboard

The Vite dev server proxies `/tasks`, `/jobs`, `/providers`, `/health`, `/events`, `/docs` and `/openapi.json` to `SERVICE_URL` (default `http://localhost:3000`). The nginx image does the same and takes `SERVICE_URL` as a bare `scheme://host:port` (default `http://host.docker.internal:3000`).

## See also

- [Getting Started](getting-started.md)
- [Infrastructure README](../infra/README.md): Terraform variables and GCP environments
- [`.env.example`](../.env.example): the full variable list

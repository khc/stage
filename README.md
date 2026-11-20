# stage

> New here? Follow the [Getting Started guide](docs/getting-started.md) to set up `.env`, Floci, Terraform, and the local API/dashboard.

Bun workspace monorepo with apps under `apps/`, agent apps under `agents/` and shared code under `packages/`:

- `@stage/http` (`packages/http`): what the Elysia apps share: the request id and request span plugins, the OpenTelemetry setup (`setupTelemetry`, also used by the agent jobs), a config loader (`createConfigLoader`, `PORT` and `HOST`) and a base error handler. It depends on `elysia` and OpenTelemetry only, not on the agents' Firestore and ADK code.
- `@stage/agents` (`packages/agents`): code shared by the agent apps: the job entrypoint (`runCli`: run a task, or `register`), the ADK runtime, the Firestore session store, the task-contract reader, the agent registry, the event publisher, and the model factory.
- `@stage/ingestion` (`packages/ingestion`): ingestion pipelines for documentation corpora (the Bun and DuckDB docs): fetch, normalize, chunk, embed through an OpenAI-compatible embeddings server and store in Qdrant, plus a catalog file of documents, sections and links for a graph. A CLI, not a service; see [its README](packages/ingestion/README.md).
- `@stage/tools` (`packages/tools`) contains the reusable ADK tool `search_web`, which returns public URLs and excerpts from Exa.
- `@stage/generic-agents` (`agents/generic`): a Cloud Run Job image with the general-purpose agents (`assistant`, which can tell the time in a city).
- `@stage/poet-agents` (`agents/poet`): a Cloud Run Job image with the poetry agents (`haiku`).
- `@stage/orchestrator-agents` (`agents/orchestrator`): a Cloud Run Job image with the `orchestrator` agent, which picks among the other registered agents by the request, calls them over A2A and answers from their replies. It only routes: its first model step of each turn is required to call an agent (function-calling mode `ANY`), so it cannot answer or decline a request on its own, and a greeting also goes to some agent. `apps/service` serves every registered agent as an A2A endpoint (`GET /a2a/:job/:agent/.well-known/agent-card.json` and `POST /a2a/:job/:agent`): a `message/send` creates an ordinary task, runs the job with the message queued, waits for the session to finish and returns the reply as an A2A task, so a delegated run shows up in the UI like any other run. Only the blocking `message/send` is supported: streaming, resubscribe and cancel answer with a JSON-RPC error, and `A2A_TIMEOUT_MS` (default 240 s, at most 250 s: the route raises Bun's idle limit to 255 s, and the service's own request timeout on GCP is 300 s) bounds the wait. At most 8 delegated runs are waited for at once (more are refused), a body over 64 KiB is refused, the gateway remembers only the last 200 tasks and not their message history, and a leading `Web search:` in an A2A message is rewritten so another agent cannot trigger the discovery agent's explicit-query path. A failed run answers with a fixed message; the error stays in the logs and the sessions API. The orchestrator tells the model to send JSON for agents with a structured input and leaves out agents that take no input (`document_analyser` reads task documents). `PUBLIC_URL` sets the address the cards advertise (default: the origin of the request). The job reads the agents from the registry when a run asks for its tools, leaves its own job out, and reaches the service at `GATEWAY_URL` (`gateway_url` in `infra/envs/local`, default `http://host.docker.internal:3000`; a service on the host needs `HOST=0.0.0.0`, and the local job sets `GATEWAY_ALLOW_INSECURE` because ADK refuses plaintext http to a non-loopback host otherwise). The gateway is as open as the rest of the service: there is no job-to-service authentication yet, so do not deploy the orchestrator on GCP until there is, and note that `HOST=0.0.0.0` exposes unauthenticated job execution to the network.
- `@stage/knowledge-agents` (`agents/knowledge`): a Cloud Run Job image with the `knowledge-assistant` agent, which answers questions from the Qdrant `docs` collection that `packages/ingestion` fills. Its `search_knowledge_base` tool embeds the query with the same embedding server as ingestion (oMLX), queries Qdrant, and—when `RERANK_MODEL` is set—fetches 25 candidates and reranks them via `/v1/rerank` down to the top 5; the job reaches both on the host through `host.docker.internal` (`qdrant_url`, `embedding_url` and `qdrant_collection` in `infra/envs/local`; `task tf:apply` also passes `EMBEDDING_MODEL`, `EMBEDDING_QUERY_PREFIX`, `RERANK_MODEL`, `RERANK_API_KEY`, and the optional API keys from `.env`, read with bun). `bun run --filter @stage/knowledge-agents smoke "<question>"` runs the agent live against the local Qdrant and embedding server and fails unless it searched and returned a valid `{ answer, sources }` reply.
- The knowledge job also holds `imdb-assistant`, which answers questions about films, series and people from the IMDb datasets (non-commercial use only). Load them with `task load-imdb` into the `imdb` Cloud SQL Postgres that Floci runs (`scripts/imdb-load.ts`, schema in `data/schemas/`; it also creates the indexes and grants read access to the `imdb_reader` role). The agent's `query_imdb` tool runs one model-written `SELECT` as `imdb_reader`, in a read-only transaction with a 10 s timeout and a 50-row cap. The job reaches the database through `IMDB_DATABASE_URL`, which `task tf:apply` sets on that job only (`imdb_db_host`, `imdb_reader_password`). The database has no host port: reach it with `docker exec floci-gcp-cloudsql-floci-local-imdb psql -U imdb -d imdb`.
- The knowledge job's `discovery-assistant` can search the public web. The agent writes a short public query for Exa from what you said, so a follow-up like "where does she live?" works. The tool accepts one model-written query per turn and refuses it once an internal tool (IMDb, Qdrant, the graph) has returned data in the same turn, so a lookup and a web search in one message need the prefix; a follow-up message can search freely, including about names from earlier results. To force an exact query, or to combine it with an internal question, put `Web search: <public query>` on the first line of the message: the tool then sends that line and ignores the model's. The agent lists the URLs it used in `sources`. Set `EXA_API_KEY` in `.env`, rebuild the knowledge job image, and run `task tf:apply`. Floci stores the key as a plain job environment value in local Terraform state.
- `@stage/service` (`apps/service`): the Elysia HTTP API with its OpenAPI/Scalar reference, laid out by feature ([PLAN.md](apps/service/PLAN.md)); it listens on `127.0.0.1:3000` (`0.0.0.0:3000` in its image, `task build:service`).
- `@stage/ui` (`apps/ui`): the React/Tailwind/shadcn dashboard, served by Vite on port `5173` (proxies API requests to `SERVICE_URL`, default `http://localhost:3000`). `task build:ui` builds it as an nginx image (`stage-ui:latest`, `docker/Dockerfile.ui`) that serves the build on port `8080` and proxies the API paths to the `SERVICE_URL` environment variable (a bare `scheme://host:port` with no path; default `http://host.docker.internal:3000`). The proxy forwards the whole API, including `/docs` and `/openapi.json`, without authentication or TLS: publish the port on `127.0.0.1` (`-p 127.0.0.1:8080:8080`) or run the image behind an authenticated ingress.
- `@stage/extract-service` (`apps/extract-service`): the Elysia service that turns an uploaded document into text for tasks (`POST /extract`, port `8080`; `task build:extract-service` builds its image).

To install dependencies:

```bash
bun install
```

To run in development:

```bash
bun run dev:service   # HTTP API service on http://localhost:3000
bun run dev:ui        # Dashboard on http://localhost:5173
```

To type check:

```bash
bun check
```

Run `bun run format` (oxfmt, configured in `.oxfmtrc.json`) to format the code, `bun run format:check` to only check it, and `bun run lint` / `bun run lint:fix` (oxlint, `.oxlintrc.json`) to lint.

## Local environment

```bash
docker compose up -d           # start Floci, Floci UI, MLflow and Qdrant (`docker compose up -d qdrant` starts only that)
docker compose down            # stop
bun run dev:service            # the API on http://localhost:3000 (runs on the host)
bun run dev:ui                 # the dashboard on http://localhost:5173
```

The extract service is not in the compose file: Terraform owns it as a Cloud Run service in Floci. Build its image with `task build:extract`, deploy it with `task tf:create-extract` (prints its URL), and set that URL as `EXTRACT_URL` for the service to turn on document upload.

- Configuration lives in `.env` (gitignored; Bun and `docker compose` both read it). Put your `GEMINI_API_KEY` there; the file lists every other variable the project uses. The service start/dev scripts and the UI (through Vite) explicitly load this root file even when Bun runs them from a workspace directory.
- MLflow (`mlflow`) is the tracking server on `http://localhost:5001` (host port 5001, since macOS uses 5000), with its SQLite database and artifacts on the named volume `mlflow-data` (`docker compose down -v` wipes it). It accepts OTLP traces at `http://localhost:5001/v1/traces` with the header `x-mlflow-experiment-id: <id>`: e.g. `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:5001/v1/traces`, `OTEL_EXPORTER_OTLP_TRACES_HEADERS=x-mlflow-experiment-id=0`, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/protobuf`. Agent jobs in Floci reach it at `mlflow:5000` only if they share its compose network.
- Telemetry: agent jobs export ADK's OpenTelemetry traces (ADK invocation, agent, LLM and tool spans, plus Firestore's) over OTLP when `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set; nothing is exported otherwise. Metrics and logs are not exported. `service.name` is `OTEL_SERVICE_NAME`, else `CLOUD_RUN_JOB` / `JOB_NAME`, else `stage-agents`. The provider is registered by `packages/agents/src/telemetry-init.ts` (calling `setupTelemetry` from `@stage/http/otel`), which every agent launch command loads with `bun --preload`, before `@google/adk`: ADK creates its tracer when it loads, and one created earlier never records. One job run is one trace: an `agent_job` root span (attributes `stage.task_id`, `gcp.vertex.agent.session_id`) wraps the task lookup, session setup, ADK's `invocation` and the run bookkeeping. Spans are flushed before the job exits. `task tf:apply` passes every `OTEL_*` variable in `.env` to the jobs (`otel_env` in `infra/envs/local`); `.env` points traces at MLflow through `host.docker.internal`. Rebuild the job images (`task build:agents`) after changing the telemetry code. The HTTP apps (`apps/service` and `apps/extract-service`) export one server span per request with the same `OTEL_*` variables, through the plugins in `@stage/http`: it continues a caller's `traceparent`, names the span after the route, and records the status and the request id, and the Firestore and Cloud Run calls made while handling the request are its children. `service.name` is `OTEL_SERVICE_NAME`, else `stage-service` (`stage-extract` for extract-service). Every response carries an `x-request-id` header (the caller's, if it is a short plain id, else a UUID), which the error log and the span repeat. Each app registers the provider in its own `src/telemetry-init.ts`, loaded with `bun --preload` in the `start` and `dev` scripts and in the image's entrypoint or command.
- Model: `AGENT_MODEL` picks it (default `gemini-2.5-flash`, Gemini API). With `GOOGLE_GENAI_USE_VERTEXAI=true` and an API key the agent uses Vertex AI in express mode, e.g. `AGENT_MODEL=publishers/google/models/gemini-2.5-flash`; ADK 2.4.0 cannot do this itself, so `packages/agents/src/model.ts` provides a small `Gemini` subclass. Without a key, the flag selects ADK's own Vertex mode (needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Google Cloud credentials).
- `service` (`docker/Dockerfile.service`, `apps/service`) is the Elysia HTTP service on `localhost:3000`: `GET /health`, `GET /jobs`, and the task-contract routes below. `curl localhost:3000/jobs` lists all Cloud Run Jobs in the configured `GCP_PROJECT` and `GCP_REGION`, returning `{ "jobs": [...] }` (or `{ "jobs": [] }`) and collecting all upstream pages automatically. Compose does not start it by default: run it on the host with `bun run dev:service` (point it at Floci with `FIRESTORE_EMULATOR_HOST=localhost:4588` and `CLOUD_RUN_EMULATOR_HOST=localhost:4588` in `.env`), or enable the commented `service` block in `docker-compose.yml` to run it in a container, where it uses `floci-gcp:4588` for both (REST without credentials). Do not run both, since they share port `3000`. Without `CLOUD_RUN_EMULATOR_HOST` it uses the real Cloud Run API and needs Application Default Credentials.
- With the stack up, `task tf:apply` (aliases `task tf:create-job` and `task tf:update-job`; needs [go-task](https://taskfile.dev), Terraform and [yq](https://github.com/mikefarah/yq); `GEMINI_API_KEY`, `AGENT_MODEL` and `GOOGLE_GENAI_USE_VERTEXAI` are read from `.env`) applies [infra/](infra/README.md) to Floci (run `task tf:init` first; `task tf:import` adopts resources created before Terraform (only ones that exist in Floci: `knowledge-agents` is created by the first `task tf:apply`, so it is not imported before that)): one Cloud Run job per agent app (`generic-agents`, `poet-agents`), the `extract` service and the Pub/Sub topics. It creates what is missing and updates job images and environment (`GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST`, `PUBSUB_EMULATOR_HOST`, `PUBSUB_TOPIC`, `GEMINI_API_KEY`, optional `AGENT_MODEL` / `GOOGLE_GENAI_USE_VERTEXAI`) from Terraform variables (which `tf:apply` fills from `.env`); `JOBS` does not narrow it. No prompt or task ID is stored in the job definition, and job containers reach Floci at `floci-gcp:4588` (`emulator_host`). Jobs set `max_retries = 0`: a run is not safe to repeat, since every attempt of a failed first run would create another session and a retried resume would append its message again, and Cloud Run Jobs otherwise retry a failed task 3 times. `task list-jobs` prints jobs as JSON (pipe to `jq`; `{}` when there are none). `task remove-job JOB=my-job` deletes one after confirmation (`--yes` skips it); it bypasses Terraform, so the next `task tf:apply` recreates it. Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.
- Each agent app is its own job image, built from the shared `docker/Dockerfile.agents` with the app as `APP` (`docker build -f docker/Dockerfile.agents --build-arg APP=poet -t stage-poet .`). `task build:agents` builds all of them, `task tf:apply` (aliases `tf:create-job` / `tf:update-job`) creates and updates the Floci jobs with Terraform (`generic-agents`, `poet-agents`, `knowledge-agents`; `agent_apps` in `infra/`), and `task register-agents` registers their agents. A new agent app needs its own `agents/<name>` entry plus its name in `JOBS` (Taskfile) and in the workspace `COPY` lines of the Dockerfiles.
- The root `package.json` `overrides` pin `@google/genai` (2.32.0), `google-gax` (6.17.0) and `@opentelemetry/semantic-conventions` (1.45.0) so the images carry one copy of each (about 25 MB less). They force one version onto packages that ask for others (`@google-cloud/vertexai` wants `@google/genai` 1.x, `@google-cloud/aiplatform` wants `google-gax` 5.x, `@google-cloud/pubsub` wants semantic-conventions 1.39), and `bun outdated` does not report them. After upgrading `@google/adk` or the Google Cloud clients, bump or drop the overrides and run one task on each agent image before relying on them.

- [Floci UI](https://hub.docker.com/r/floci/floci-ui) (`floci-ui`) is a web console on `http://localhost:4500` connected to Floci GCP. It only looks at Google Cloud project `floci-local` (region `us-central1`), which is why `floci-local` is this setup's default project: data written under another project does not show up in it. It lists Firestore collections; it does not list Cloud Run jobs (use `task list-jobs`).
- Floci keeps its data (Cloud Run jobs, Firestore documents) across `docker compose stop`, `restart` and `down`: it runs with `FLOCI_GCP_STORAGE_MODE=hybrid` and its data on the named volume `floci-gcp-data`. To wipe it, run `docker compose down -v`. Persistence of other Floci services (Pub/Sub, Storage and so on) was not tested.
- [Floci GCP](https://floci.io/floci-gcp/getting-started/quick-start/) listens on `localhost:4588` and emulates Firestore, among other GCP services.
- For native local development with Floci, enable `FIRESTORE_EMULATOR_HOST=localhost:4588` and `CLOUD_RUN_EMULATOR_HOST=localhost:4588` in the root `.env`. Restart `bun dev` after changing environment settings. Without these settings, the clients use the real Google Cloud APIs and require Application Default Credentials.
- The agent saves its ADK session (events and state) to Firestore, so it needs `FIRESTORE_EMULATOR_HOST` (local) or Application Default Credentials with Firestore access (deployed) when it runs.
- To include the Firestore session-service tests (skipped otherwise), run `FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local bun test` with the stack up.
- `floci-gcp` mounts the Docker socket (`/var/run/docker.sock`), which gives the container control of the host's Docker daemon. The port is bound to `127.0.0.1` only.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Tasks

Create a task with a prompt and the short Cloud Run job name. Creation only saves the contract:

```bash
curl -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"prompt":"hello","jobName":"generic-agents"}'
```

Returns HTTP 201 `{ "taskId": "<generated UUID>", "prompt": "hello", "jobName": "generic-agents" }` after saving these fields at Firestore `tasks/{taskId}`. Prompts are trimmed and must contain 1–10,000 characters after trimming. An optional `agentName` (letters, digits, underscores and hyphens, at most 64 characters, starting with a letter or underscore) selects which agent inside the job container runs the task, so one job image can hold several agents; it is stored with the contract, returned by the task routes, and also used when a session of the task is resumed. Omit it to run the job image's default agent (`assistant` in `@stage/generic-agents`, `haiku` in `@stage/poet-agents`). An unknown name makes the job exit 1 with `Unknown agent: <name>`; the service does not know which agents a container holds, so it validates only the format. Agents are declared in each app's `agents/<name>/src/agents.ts`. `jobName` is required, at most 63 characters, starts with a lowercase letter, contains lowercase letters/digits/hyphens, and ends in a letter or digit. It cannot be a full resource path or have surrounding spaces. Invalid/missing JSON input returns 400; extra properties are ignored.

Use the returned UUID to read or execute the task:

```bash
TASK_ID='paste-the-returned-UUID-here'
curl localhost:3000/tasks
curl "localhost:3000/tasks/$TASK_ID"
curl -X POST "localhost:3000/tasks/$TASK_ID/run"
```

`GET /tasks` returns HTTP 200 `{ "tasks": [{ "taskId": "<UUID>", "prompt": "hello", "jobName": "generic-agents" }] }`, or `{ "tasks": [] }`. It returns all contracts without pagination or guaranteed ordering. `GET /tasks/:taskId` returns the individual contract with HTTP 200. Invalid UUIDs return 400; valid UUIDs are normalized to lowercase. Missing tasks return 404 `{ "error": "task_not_found" }`. Firestore failures return 502 `{ "error": "task_error" }`.

`POST /tasks/:taskId/run` requires no body. It reads the stored jobName, starts that job in the service's `GCP_PROJECT` / `GCP_REGION`, and returns HTTP 202 `{ "operation": "<Cloud Run operation name>" }` after submission. A supplied body cannot override jobName or prompt. Only `TASK_ID` is passed as a per-execution environment override. The agent reads `tasks/{taskId}` from Firestore and runs its stored prompt; it never falls back to `AGENT_MESSAGE`. Invalid UUIDs return 400; absent tasks return 404 `task_not_found`; missing or invalid stored jobName returns 409 `{ "error": "task_not_executable" }`; Firestore lookup failures return 502 `task_error`; Cloud Run submission failures return 502 `{ "error": "job_error" }`.

HTTP 202 acknowledges submission, not agent success. Missing/invalid TASK_ID, missing contracts, invalid prompts, Firestore errors, or agent errors cause the job process to exit 1. No execution status or result is written to the task contract. Each job invocation creates a separate session with its own session ID and a top-level `taskId` field in the Firestore `sessions` document, linking it to the contract. The link is retained when sessions are loaded or listed. Older sessions can omit `taskId`. Repeated run requests can start multiple executions and sessions.

The former `/jobs/runs` routes and `POST /jobs/:name/run` URL are removed; use `/tasks` and `POST /tasks/:taskId/run`. Migrated prompt-only tasks remain readable but cannot be run without a jobName; recreate them with a jobName. Both the service and agent use the existing Firestore configuration (`GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST` locally, or Application Default Credentials when deployed), and must point to the same project/database.

For rollout, build the new agent images (`task build:agents`) and update the jobs (`task tf:update-job`) before using the new task run route. Then restart the local service (stop and re-run `bun run dev:service`, or `docker compose up -d --build service` if you enabled the compose block). Existing job definitions retain their Firestore/model credentials; execution input is supplied only by the new endpoint. For deployed jobs, apply the same agent-before-service sequence through the deployment tooling.

### Migrate existing runs

Stop task/run creation, execution requests, and active job attempts during migration so the source contracts and session documents stay stable. Point the commands at the same Firestore project/database used by the service and agent. For the local emulator:

```bash
# Preview counts without writing data.
FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local \
  bun scripts/migrate-runs-to-tasks.ts

# Apply after reviewing the dry-run result.
FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local \
  bun scripts/migrate-runs-to-tasks.ts --apply
```

For a deployed database, set its `GOOGLE_CLOUD_PROJECT` and use Application Default Credentials instead of `FIRESTORE_EMULATOR_HOST`.

The script copies `runs/{runId}` to `tasks/{taskId}` using the same UUID, replaces the contract's `runId` field with `taskId`, and preserves prompt, jobName, and other fields. It adds `taskId` to sessions linked through `runId`, retaining their old `runId` field for compatibility. Unlinked chat sessions are unchanged. Existing `runs` documents are retained; the new API reads and writes only `tasks`.

Matching tasks and session links are skipped, so the script can be rerun. Conflicting task contents, conflicting session links, or invalid legacy IDs stop the migration without overwriting those records. An apply can make partial progress before a later error; resolve the conflict and rerun. Each session update checks its read version to detect concurrent changes. The summary contains counts only, without prompts or credentials.

Deploy both new images together during the maintenance window: the service sends only `TASK_ID`, the agent loads `tasks/{taskId}`, and new sessions store `taskId`. Update job definitions with `task tf:update-job` to remove old static `AGENT_MESSAGE`, `RUN_ID`, and `TASK_ID` values before resuming requests. The agent no longer accepts `RUN_ID` as execution input. The migration is provided as tooling; it does not run automatically at service startup.

Resuming a session no longer passes the message to the job: the service queues it on the session in Firestore and starts the job with only `TASK_ID` and `SESSION_ID`. Rebuild the agent images (`task build:agents`), update the jobs (`task tf:update-job`) and restart the service together; an agent image from before this change fails a resume with `MESSAGE is required to resume a session`.

### Event publishing

The agent publishes every event the ADK runner yields (model responses, tool calls and results) to a Pub/Sub topic. The message data is the event as JSON; attributes are `eventId`, `sessionId`, and `taskId` (when the run belongs to a task). Publishing is on when `PUBSUB_TOPIC` is set. The Terraform jobs set it to `agent-events` by default (`agent_events_topic`) and set `PUBSUB_EMULATOR_HOST` to `floci-gcp:4588` (`emulator_host`). The topic is created on first publish if it does not exist. Without the emulator host the agent uses the real Pub/Sub API and Application Default Credentials. Publishing is best effort: a failure is logged and does not fail the run. Events are published in order but delivery to subscribers is at-least-once, so use `eventId` to de-duplicate. Run `task tf:update-job` and rebuild the agent image after upgrading. To read events locally, create a subscription on the topic through Floci's Pub/Sub REST API (`PUT /v1/projects/floci-local/subscriptions/<name>`).

### Deleting a session

`DELETE /tasks/:taskId/sessions/:sessionId` permanently removes the session and all its stored events, returning HTTP 204 with no body. Only a session linked to that task can be deleted: an absent session, one belonging to another task, or one with no `taskId` (older sessions) returns 404 `session_not_found`, and a missing task returns 404 `task_not_found`. Invalid parameters return 400; storage failures return 502 `session_error`. The task and its other sessions are unchanged. Open event streams for the deleted session are not closed.

### Session stats

`GET /tasks/:taskId/sessions/:sessionId/stats` returns `{ "events": n, "llmCalls": n, "tokens": { "prompt", "candidates", "thoughts", "toolUsePrompt", "cached", "total" } }`, summed from the model usage ADK records on the session's stored events. `llmCalls` counts events that carry usage. `cached` is part of `prompt`; `total` is the model-reported total, which also covers thoughts and tool-use prompt tokens. Streaming partial events are not stored and not counted. Errors match the other session routes (404 `task_not_found` / `session_not_found`, 400, 502 `session_error`). The dashboard shows these totals at the top of an open session and refreshes them as live events arrive.

### Streaming session events

`GET /tasks/:taskId/sessions/:sessionId/messages` is a Server-Sent Events stream (through the dashboard's dev server this is `http://localhost:5173/tasks/:taskId/sessions/:sessionId/messages`). It first replays the stored events in order, then streams events the agent publishes to Pub/Sub until the client disconnects. Each message has `id` = event ID and `data` = the event JSON, a duplicate event ID is sent once, and a comment line is sent every 5 seconds to keep the connection open. Missing tasks and sessions (or a session of another task) return 404 before the stream starts; a Firestore or Pub/Sub failure returns 502 `events_error`.

Live events need `PUBSUB_TOPIC` (and `PUBSUB_EMULATOR_HOST=localhost:4588` locally) in the service environment, matching the agent's topic (`agent-events` by default). The service creates one ephemeral subscription per process on the first stream and shares it between clients; it expires after 24 hours without a consumer. Without `PUBSUB_TOPIC` only the stored events are sent and the connection stays open (it never ends on its own, so `EventSource` does not reconnect in a loop). Events published before the first stream are served from Firestore, so nothing is missed. Browsers can read it with `new EventSource(url)`.

### Platform events

The service publishes lifecycle events to the Pub/Sub topic named by `PLATFORM_EVENTS_TOPIC` (for example `platform-events`; unset means off, and the topic is created on first publish). Types: `task.created`, `task.deleted`, `task.run_requested` (submission only, not completion), `document.added`, `document.removed` (only for an explicit document removal; `task.deleted` implies its sessions and any documents no other task uses are cleaned up, without separate events) and `job.registration_requested`. The message data is JSON `{ eventId, type, occurredAt, ... }` with `taskId`, `jobName`, `agentName`, `sessionId` or `documentId` where relevant. Attributes are `eventId`, `eventType` and `taskId` (when present), so subscribers can filter. An event is published after its operation succeeds; publishing is best effort and runs in the background (a failure is logged, and neither a failure nor a slow Pub/Sub delays or fails the request) and delivery is at-least-once, so de-duplicate on `eventId`. The topic is separate from the agent `PUBSUB_TOPIC`. Locally it needs the same `PUBSUB_EMULATOR_HOST` as the live events.

`GET /events` streams these events as Server-Sent Events (`id` = `eventId`, `data` = the event JSON; a comment line every 5 seconds keeps the connection open). The service creates one ephemeral subscription per process on the first client and shares it between clients. Events published while a client is not connected are not replayed. It returns 501 `{ "error": "not_supported" }` when `PLATFORM_EVENTS_TOPIC` is not set on the service, and 502 `events_error` on a Pub/Sub failure. The dashboard uses it to refresh tasks, sessions, documents and agents without polling; it falls back to polling every 15 seconds while the stream is unavailable.

### Agent registry

A job container can hold several agents; each agent app declares its set in `agents/<name>/src/agents.ts` (`agentSet`: the agents with their input and output schemas, and the default agent that runs when a task names none). The registry records which ones each job image holds, in the Firestore `agents` collection, so the service and dashboard can offer and check a task's `agentName`.

`task register-agents` records the agents of every app in `JOBS` without a Cloud Run execution: it runs `bun agents/<name>/src/main.ts register` with `JOB_NAME=<name>-agents` against Floci's Firestore (`FLOCI_HOST`, default `localhost:4588`) and writes each agent (name, description and schemas) for that job. The service does not need to run. Registration replaces the job's entries, so agents removed from the image disappear; run it again after the agents change, since `tf:update-job` does not. Against a real project, run the same command with `JOB_NAME` set and Application Default Credentials instead of `FIRESTORE_EMULATOR_HOST`.

`POST /jobs/:jobName/register` (the dashboard's "Register agents" button) does the same by starting the job in its `register` mode: the Cloud Run execution gets the argument `register` and `JOB_NAME`, and the container writes its agents. It returns HTTP 202 `{ "operation": "..." }`, which acknowledges submission only. Use it when the job's image, not your checkout, is the source of truth.

`GET /jobs/:jobName/agents/:agentName/card` returns the agent as an A2A-style Agent Card built from the registry: `name`, `description`, `capabilities`, `defaultInputModes` / `defaultOutputModes` (`text/plain` for a string schema, `application/json` otherwise) and one skill (`id` and `name` are the agent name, `tags` holds the job name). It has no endpoint, because this service does not implement the A2A protocol, and the JSON Schemas are under `x-stage`. An unknown agent returns 404 `agent_not_found`.

`GET /jobs/:jobName/agents` returns `{ "agents": [{ "name": "...", "description": "...", "inputSchema": {...}, "outputSchema": {...} }] }`, empty when the job was never registered. `inputSchema` and `outputSchema` are JSON Schema documents describing the message a task sends to the agent and the agent's final reply; they are declared with each agent in `agents/<name>/src/agents.ts` (as Zod schemas) and stored in the registry as JSON text. The `assistant` agent is free-text, so both its schemas are strings. The `haiku` agent is structured: its input is `{ "topic": string }` and its output is `{ "poem": string }`. The task prompt of a structured agent must be a JSON object matching its input schema; the agent checks this before calling the model and the job exits 1 with an error otherwise. A resume `message` is a follow-up turn and is free text: the schema is not checked for it. Its output schema is passed to the model, so the final reply is a JSON object, for example `{"poem": "## Autumn Rain  \n\nline one  \nline two  \nline three  "}`; the poem is Markdown, a `##` title heading followed by the three lines. The service does not validate against the schemas. The create-task dialog shows the selected agent's input and output under its dropdown, turns a structured agent's input schema into a form (a text, number, checkbox or dropdown control per property, with required markers and the schema's descriptions, minimums and maximums; nested values become JSON fields) and saves the form values as the JSON prompt. Agents with a text input keep the free-text prompt box. The task Output tab shows a JSON reply field by field. `POST /tasks` with an `agentName` then returns 400 `{ "error": "unknown_agent" }` if the job has registered agents and the name is not one of them; for an unregistered job any valid name is accepted. In the dashboard, clicking a job card (or its Details button) opens a job pane, like the task pane, with Overview (status, image, retries, timeout, CPU and memory, dates, execution count and environment variable names; values are never shown), Agents (each registered agent with its input and output) and Tasks (the tasks that use the job) tabs. Each job card also has a "Register agents" button (the same as `POST /jobs/:jobName/register`) and lists the job's registered agents, refreshing every 3 seconds for 30 seconds after you register; the create-task dialog picks the job and then the agent from dropdowns (the agent list shows the chosen job's registered agents, or just "Default agent" if none are registered).

### Resuming a session

`POST /tasks/:taskId/run` with `{ "sessionId": "...", "message": "..." }` resumes an existing session of that task and sends `message` as the next user turn, instead of creating a new session from the stored prompt. The service sends `SESSION_ID` and `MESSAGE` as per-execution overrides next to `TASK_ID`. `sessionId` and `message` must be sent together (400 otherwise); an absent session, or one linked to another task, returns 404 `session_not_found`. The agent rechecks that the session belongs to the task. A body without `sessionId` is ignored, as before.

### Deleting a task

`DELETE /tasks/:taskId` permanently removes the task contract and every session linked to it, with their events, and returns HTTP 204 with no body. Sessions are removed first, so if a step fails the task stays and the request can be repeated. A missing task returns 404 `task_not_found`; invalid UUIDs return 400; storage failures return 502 `task_error`. Executions that are already running are not stopped, and open event streams for the deleted sessions stay open until the client disconnects. In the dashboard, the trash button next to Run task in the task pane asks for confirmation inline, naming the number of sessions that go with it.

### Task sessions

```bash
curl "localhost:3000/tasks/$TASK_ID/sessions"
SESSION_ID='paste-a-session-id-here'
curl "localhost:3000/tasks/$TASK_ID/sessions/$SESSION_ID"
```

`GET /tasks/:taskId/sessions` returns HTTP 200 `{ "sessions": [...] }` with summaries containing `id`, `taskId`, `appName`, `userId`, and `lastUpdateTime`. The list includes only sessions linked to that task, is unpaginated with unspecified order, and returns `{ "sessions": [] }` when the task has no sessions. It does not load session state or events.

`GET /tasks/:taskId/sessions/:sessionId` returns HTTP 200 with the full ADK session, including `state`, ordered `events`, and `taskId`. Session IDs are matched exactly (including case), supporting custom ADK IDs. Both routes validate and normalize the task UUID. Invalid parameters return 400; missing tasks return 404 `{ "error": "task_not_found" }`; an absent session or a session belonging to another task returns 404 `{ "error": "session_not_found" }`. Storage failures return 502 `{ "error": "session_error" }`. Existing sessions require a stored `taskId` link to appear, including those linked by the migration above.

## API reference

Open [Scalar API docs](http://localhost:3000/docs) while the service is running. The OpenAPI 3.1 document is available at [openapi.json](http://localhost:3000/openapi.json), covering health, jobs, tasks, task execution, and task sessions. Request schemas are generated from the same Zod validators used by the routes. The documentation UI loads Scalar's browser bundle from its CDN.

## Web dashboard

Run `bun run dev:service` (port `3000`) and `bun run dev:ui` (port `5173`), then open [the dashboard](http://localhost:5173). `@stage/ui` is a Vite app (`apps/ui`) that proxies `/tasks`, `/jobs`, `/health`, `/events`, `/docs` and `/openapi.json` to `SERVICE_URL` (default `http://localhost:3000`), so the browser only talks to port `5173`. Both servers must be running. `bun run --filter @stage/ui build` produces a static bundle in `apps/ui/dist`; there is no Docker image for it yet.

The dashboard lists tasks and Cloud Run jobs, saves new tasks, submits task executions, and shows session summaries, state, and ordered events. Tasks, jobs, and visible sessions refresh every 15 seconds. An open session also streams new events live from the messages endpoint above (when the service has `PUBSUB_TOPIC`), its form can continue the session with a new message, and a trash button (with an inline confirmation) deletes it. Execution notices indicate submission only; they do not claim agent completion. Search tasks by prompt/job/ID, or use `/` to focus search. New-task creation saves without executing. API documentation remains at `/docs`.

### Appearance

Use the Light / Dark / System control in the dashboard top bar. System is the default and follows device appearance changes. Choices are saved in this browser and synchronized across tabs. If browser storage is unavailable, switching still works for the current page. The saved appearance is applied before styles load to avoid a theme flash.

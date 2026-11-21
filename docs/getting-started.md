# Getting Started

Run `stage` locally against [Floci](https://floci.io/floci-gcp/getting-started/quick-start/) (local GCP emulator for Firestore, Cloud Run, Pub/Sub, Cloud Scheduler, and Cloud SQL), MLflow, Qdrant, and Neo4j.

## Prerequisites

- [Bun](https://bun.com) (workspace uses Bun v1.4+)
- Docker and Docker Compose (Floci mounts `/var/run/docker.sock` to launch Cloud Run containers)
- [go-task](https://taskfile.dev) (`task` CLI)
- [Terraform](https://www.terraform.io/)
- [yq](https://github.com/mikefarah/yq) (used by `task tf:apply` to read `.env`)
- A Gemini API key (`GEMINI_API_KEY`)

## 1. Install dependencies and configure `.env`

```bash
bun install
cp .env.example .env
```

Edit `.env` for local development:

1. **Set credentials**:
   - `GEMINI_API_KEY` — your Gemini API key (used by agent jobs; local Terraform stores it as a plain env var in local state, so use a throwaway key).
   - `NEO4J_PASSWORD` — any local password if you plan to start the `neo4j` container.
2. **Uncomment the local Floci emulators**:
   ```dotenv
   FIRESTORE_EMULATOR_HOST=localhost:4588
   CLOUD_RUN_EMULATOR_HOST=localhost:4588
   PUBSUB_EMULATOR_HOST=localhost:4588
   ```
3. **Enable live event streaming (recommended for the dashboard)**:
   ```dotenv
   PUBSUB_TOPIC=agent-events
   PLATFORM_EVENTS_TOPIC=platform-events
   ```
4. **Optional local tracing**:
   - Uncomment the `OTEL_EXPORTER_OTLP_TRACES_*` lines to send OpenTelemetry traces to MLflow.

## 2. Start local infrastructure

Start the Compose services from the repository root:

```bash
# Full local stack (requires NEO4J_PASSWORD in .env)
docker compose up -d

# Or only the core GCP emulator, UI, and MLflow
docker compose up -d floci-gcp floci-ui mlflow
```

| Service     | Purpose                               | Local URL               |
| ----------- | ------------------------------------- | ----------------------- |
| `floci-gcp` | Emulated Firestore, Cloud Run, etc.   | `http://localhost:4588` |
| `floci-ui`  | Web console for Floci (`floci-local`) | `http://localhost:4500` |
| `mlflow`    | OpenTelemetry trace viewer            | `http://localhost:5001` |
| `qdrant`    | Vector database for knowledge docs    | `http://localhost:6333` |
| `neo4j`     | Graph database for ingestion catalog  | `http://localhost:7474` |

## 3. Build images, provision Floci, and register agents

Build the container images that Terraform deploys into Floci (`task build:control-service` is needed because `infra/envs/local/main.tf` sets `deploy_service = true`):

```bash
task build:agents
task build:extract-service
task build:control-service
```

`task build` runs all of them (and `build:ui`, the dashboard image, which Terraform does not deploy).

Initialize and apply the local Terraform configuration (`infra/envs/local`), then record each agent app's agents in Firestore:

```bash
task tf:init
task tf:apply
task register-agents
```

`task tf:apply` creates the Pub/Sub topics (`agent-events`, `platform-events`), the Cloud Run jobs (`generic-agents`, `poet-agents`, `knowledge-agents`), the `extract` and `service` Cloud Run services, and the local `imdb` Cloud SQL instance. When developing the API on the host in Step 4 (`bun run dev:service`, which reads `AGENT_JOBS=*` from `.env`), you interact with the host process rather than the Floci-deployed `service` container (you can also remove the Floci `service` container with `task tf:remove-service`).

> **Optional — document uploads in host dev mode:** Copy the deployed extract service URL into `.env` (`EXTRACT_URL`) so `bun run dev:service` can extract uploaded documents:
>
> ```bash
> terraform -chdir=infra/envs/local output -raw extract_url
> ```

Verify the jobs exist in Floci:

```bash
task list-jobs
```

## 4. Start the API service and dashboard

Run the HTTP API (`apps/control-service`) and web dashboard (`apps/ui`) in two terminals:

```bash
# Terminal 1: HTTP API on http://localhost:3000 (Scalar API docs at /docs)
bun run dev:service

# Terminal 2: React dashboard on http://localhost:5173
bun run dev:ui
```

Open `http://localhost:5173` in your browser for the dashboard, or `http://localhost:3000/docs` for the OpenAPI reference.

## 5. Create and run your first task

You can create and run tasks from the dashboard at `http://localhost:5173`, or with `curl`:

```bash
# 1. Create a task contract
curl -X POST http://localhost:3000/tasks \
  -H 'content-type: application/json' \
  -d '{"prompt":"What time is it in Tokyo?","jobName":"generic-agents"}'
```

Copy the returned `taskId` and run it:

```bash
TASK_ID='<paste-taskId-here>'

# 2. Trigger a Cloud Run job execution (returns HTTP 202)
curl -X POST "http://localhost:3000/tasks/$TASK_ID/run"

# 3. Inspect created sessions and messages
curl "http://localhost:3000/tasks/$TASK_ID/sessions"
```

Once a session appears, fetch its full event history with:

```bash
SESSION_ID='<paste-sessionId-here>'
curl "http://localhost:3000/tasks/$TASK_ID/sessions/$SESSION_ID"
```

## Optional: Knowledge base and IMDb agents

- **Documentation search (`knowledge-assistant` / `discovery-assistant`)**: Uses Qdrant, Neo4j, and an OpenAI-compatible embeddings server (such as oMLX on port `8000`). See [packages/ingestion/README.md](../packages/ingestion/README.md) to fetch and ingest the Bun and DuckDB docs.
- **IMDb queries (`imdb-assistant`)**: Load the non-commercial IMDb datasets into Floci's Postgres instance with:
  ```bash
  task load-imdb
  ```

## Everyday checks and cleanup

```bash
bun test                 # Run tests (keep floci-gcp — plus Qdrant/Neo4j/embeddings if set in .env — running)
bun check                # Type check root workspace (excludes apps/ui per tsconfig.json)
bun run typecheck        # Type check scripts and all workspaces (recommended)
bun run lint             # Lint with oxlint
bun run format:check     # Check formatting with oxfmt
```

> With `FIRESTORE_EMULATOR_HOST=localhost:4588` uncommented in `.env`, `bun test` runs Firestore contract tests that fail if `floci-gcp` is stopped (and likewise for Qdrant, Neo4j, or embedding contract tests if their env vars are set).

Stop the local containers when done (data persists in Docker volumes):

```bash
docker compose down      # Stop containers, keep volumes
docker compose down -v   # Stop containers and wipe local state
```

## Further reading

- [Project README](../README.md) — workspace layout, API behavior, event streaming, and agent registry details
- [Infrastructure README](../infra/README.md) — local Floci and GCP (`dev` / `prod`) Terraform roots
- [Floci GCP notes](floci-gcp.md) — emulator capabilities and quirks
- [Ingestion README](../packages/ingestion/README.md) — documentation corpus ingestion, retrieval evals, and Neo4j catalog

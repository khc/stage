# Getting Started

Set up `stage` on your machine and run your first agent task. Allow about 20 minutes, most of it spent building images.

**At the end you will have:** Floci (a local GCP emulator) running Firestore, Cloud Run and Pub/Sub; four agent jobs deployed to it; the control service on <http://localhost:3000>; and the dashboard on <http://localhost:5173>.

## Prerequisites

| Tool                                   | Why                                                                         | Check                                         |
| -------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| [Bun](https://bun.com) 1.4+            | Runs the services, tests and scripts                                        | `bun --version`                               |
| Docker with Compose                    | Runs Floci, which launches the job containers (it mounts the Docker socket) | `docker compose version`                      |
| [go-task](https://taskfile.dev)        | The `task` commands                                                         | `task --version`                              |
| [Terraform](https://www.terraform.io/) | Creates the jobs and topics in Floci                                        | `terraform version`                           |
| [yq](https://github.com/mikefarah/yq)  | `task tf:apply` reads `.env` with it                                        | `yq --version`                                |
| A Gemini API key                       | The default model for the agents                                            | [Get one](https://aistudio.google.com/apikey) |

## 1. Install and configure

```bash
bun install
cp .env.example .env
```

Edit `.env`:

1. Set `GEMINI_API_KEY`. Local Terraform stores it as a plain value in its state, so use a throwaway key.
2. Uncomment the three Floci emulator lines:

   ```dotenv
   FIRESTORE_EMULATOR_HOST=localhost:4588
   CLOUD_RUN_EMULATOR_HOST=localhost:4588
   PUBSUB_EMULATOR_HOST=localhost:4588
   ```

3. Uncomment the two topics, so the dashboard streams runs live:

   ```dotenv
   PUBSUB_TOPIC=stage--agent-events--ps-lcl
   PLATFORM_EVENTS_TOPIC=stage--platform-events--ps-lcl
   ```

4. Optional: uncomment the `OTEL_EXPORTER_OTLP_TRACES_*` lines to send traces to MLflow (see [Observability](observability.md)).

The other variables are listed in [Configuration](configuration.md).

## 2. Start the local stack

```bash
docker compose up -d floci-gcp floci-ui mlflow
```

| Service     | Purpose                                | URL                     |
| ----------- | -------------------------------------- | ----------------------- |
| `floci-gcp` | Emulated Firestore, Cloud Run, Pub/Sub | <http://localhost:4588> |
| `floci-ui`  | Web console for Floci                  | <http://localhost:4500> |
| `mlflow`    | Trace viewer                           | <http://localhost:5001> |

`docker compose up -d` with no names also starts `qdrant` (<http://localhost:6333>) and `neo4j` (<http://localhost:7474>). They are only needed for the [knowledge agents](agents.md#knowledge-job), and Neo4j needs `NEO4J_PASSWORD` in `.env`.

**You should see:** `docker compose ps` lists the services as running, and `floci-gcp` as healthy.

## 3. Build the images and deploy to Floci

```bash
task build              # agents, extract service, control service and dashboard images
task tf:init            # once
task tf:apply           # create the jobs, services and topics in Floci
task register-agents    # record each job's agents in Firestore
```

`task tf:apply` creates the Pub/Sub topics, one Cloud Run job per agent app, the extract and control services, and a local Cloud SQL instance. The jobs are `stage--generic-agents--job-lcl`, `stage--poet-agents--job-lcl`, `stage--knowledge-agents--job-lcl` and `stage--orchestrator-agents--job-lcl`.

**You should see:** `task list-jobs` prints a JSON document that names the four jobs.

> You will run the API on the host in the next step. The copy of the control service that Terraform deployed into Floci is not used for that; `task tf:remove-service` removes it.

Optional: to enable document upload, put the extract service's address in `.env` as `EXTRACT_URL`:

```bash
terraform -chdir=infra/envs/local output -raw extract_url
```

## 4. Start the API and the dashboard

In two terminals:

```bash
bun run dev:service     # API on http://localhost:3000, API reference at /docs
bun run dev:ui          # dashboard on http://localhost:5173
```

**You should see:** `curl localhost:3000/health` answers, and <http://localhost:5173> shows the dashboard.

## 5. Run your first task

### In the dashboard

1. Open <http://localhost:5173/tasks> and choose **New task**.
2. Pick the job `stage--generic-agents--job-lcl` and the `assistant` agent.
3. Enter the prompt `What time is it in Tokyo?` and save.
4. Open the task and choose **Run task**. The session appears and its events stream in live.

### With curl

```bash
# 1. Create a task. This only saves it.
curl -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"name":"Time in Tokyo","prompt":"What time is it in Tokyo?","jobName":"stage--generic-agents--job-lcl"}'
```

The reply has a `taskId`. Use it to run the task:

```bash
TASK_ID='<paste the taskId>'

# 2. Start a job execution. The reply is HTTP 202 with the operation and the session id.
curl -X POST "localhost:3000/tasks/$TASK_ID/run"

# 3. List the task's sessions, then read one, state and events included.
curl "localhost:3000/tasks/$TASK_ID/sessions"
curl "localhost:3000/tasks/$TASK_ID/sessions/<sessionId>"

# 4. Optional: follow the events live as server-sent events.
curl -N "localhost:3000/tasks/$TASK_ID/sessions/<sessionId>/messages"
```

**Reading the result:** the `202` means the job was submitted, not that the agent succeeded. The session's `run` field shows `running`, `succeeded` or `failed`, and the last model event holds the answer. To ask a follow-up, run the task again with `{"sessionId": "...", "message": "..."}` (see [API](api.md#resume-a-session)).

## Troubleshooting

| Symptom                                                        | Cause and fix                                                                                                  |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `task tf:apply` fails with 409 `alreadyExists`                 | A resource was created outside Terraform. Run `task tf:import`, then apply again                               |
| `GET /jobs` is empty, or creating a task answers `unknown_job` | The jobs are not deployed. Run `task tf:apply`, and check `AGENT_JOBS` in `.env`                               |
| The agent list in the new-task dialog is empty                 | Agents are not registered. Run `task register-agents`                                                          |
| `bun run dev:service` fails with `EADDRINUSE` on port 3000     | Another process owns port 3000, perhaps an earlier `bun run dev:service`. Stop it, or set `PORT` in `.env`     |
| Requests fail with Application Default Credentials errors      | The emulator lines in `.env` are still commented out. Uncomment them and restart the service                   |
| `bun test` fails after you stop Floci                          | With `FIRESTORE_EMULATOR_HOST` set, the Firestore contract tests need Floci. Start it, or comment the line out |
| The run stays `running` and no events appear                   | Check `docker ps` for the job container and its logs. Confirm `PUBSUB_TOPIC` is set for the service            |

More cases are in [Operations](operations.md#troubleshooting).

## Optional setups

- **Knowledge base and discovery agents:** need Qdrant, Neo4j and an embeddings server. See [Agents](agents.md#knowledge-job) and the [ingestion README](../packages/ingestion/README.md).
- **IMDb agent:** run `task load-imdb` to load the datasets into Floci's Postgres. See [Agents](agents.md#imdb-assistant).
- **Other models:** add a provider in the dashboard under Settings. See [Configuration](configuration.md#models-and-providers).

## Everyday checks

```bash
bun test                 # unit tests
bun run typecheck        # type check scripts and all workspaces
bun run lint             # oxlint
bun run format:check     # oxfmt
```

Stop the stack when you are done. The data stays in Docker volumes unless you add `-v`:

```bash
docker compose down      # stop, keep data
docker compose down -v   # stop and wipe local state
```

## Next steps

- [Architecture](architecture.md): how the pieces fit together
- [API](api.md): every route
- [Agents](agents.md): what each agent does and how to add one
- [Infrastructure README](../infra/README.md): Terraform for Floci and GCP

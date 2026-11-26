# Agents

An **agent app** is a Cloud Run job image that holds one or more agents. This page lists the apps and agents, explains the registry that tells the service what each image holds, and describes the two run modes and the A2A gateway.

## Agent apps

Each app lives in `agents/<name>` and declares its agents in `agents/<name>/src/agents.ts` (`agentSet`: the agents with their input and output schemas, and the default agent that runs when a task names none). It is built from the shared `docker/Dockerfile.agents`, with the app name as the build argument `APP`.

| App            | Job                                   | Agents (default first)                                                                      |
| -------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `generic`      | `stage--generic-agents--job-lcl`      | `assistant` (can tell the time in a city), `document-analyser` (reads the task's documents) |
| `poet`         | `stage--poet-agents--job-lcl`         | `haiku-poet`, `limerick-poet`                                                               |
| `knowledge`    | `stage--knowledge-agents--job-lcl`    | `knowledge-assistant`, `imdb-assistant`, `discovery-assistant`                              |
| `orchestrator` | `stage--orchestrator-agents--job-lcl` | `orchestrator`                                                                              |

A task without an `agentName` runs the job's default agent. An unknown name makes the job exit 1 with `Unknown agent: <name>`.

### Add an agent app

1. Create `agents/<name>` with a `src/agents.ts` and a `src/main.ts`, modelled on an existing app.
2. Add the name to `JOBS` in the root `Taskfile.yml`, and to the workspace `COPY` lines of the Dockerfiles.
3. Add it to `agent_apps` in `infra/`, then run `task build:agents`, `task tf:apply` and `task register-agents`.

Follow [Naming rules](naming-rules.md) for the job and image names.

## Registry

A job can hold several agents, so the platform records which ones each job image has. The registry is the Firestore `agents` collection. The service and the dashboard use it to offer and check a task's `agentName`.

Each entry holds the agent's `name`, `description`, an `inputSchema` and an `outputSchema` (JSON Schema, declared as Zod schemas in `agents.ts`), and the run `modes` it supports.

### Register agents

| Way                | Command                                                           | Use when                                                                             |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| From your checkout | `task register-agents`                                            | The agents changed in your code. Needs no running service and no Cloud Run execution |
| From the job image | `POST /jobs/:jobName/register`, or the **Register agents** button | The image, not your checkout, is the source of truth                                 |

`task register-agents` runs `bun agents/<name>/src/main.ts register` for each app in `JOBS` against Floci's Firestore (`FLOCI_HOST`, default `localhost:4588`), with `JOB_NAME=stage--<name>-agents--job-lcl`. Registration replaces the job's entries, so removed agents disappear. Run it again after the agents change, since `task tf:apply` does not. Against a real project, run the same command with `JOB_NAME` set and Application Default Credentials.

### Input and output schemas

- A free-text agent, such as `assistant`, has string schemas.
- A structured agent has object schemas. `haiku-poet` takes `{ "topic": string }` and replies `{ "poem": string }`, where the poem is Markdown with a `##` title and three lines.
- A task's first prompt for a structured agent must be a JSON object that matches its input schema. The agent checks this before calling the model, and the job exits 1 otherwise. The service does not validate against the schemas.
- A resume message is a follow-up turn and is free text. Its schema is not checked.
- The output schema is passed to the model, so the final reply is a JSON object.

The new-task dialog shows the selected agent's input and output, and turns an input schema into a form: a control per property, with required markers and the schema's descriptions, minimums and maximums. Nested values become JSON fields. The task's Output tab shows a JSON reply field by field.

### Agent Cards

`GET /jobs/:jobName/agents/:agentName/card` returns the agent as an A2A-style card built from the registry: `name`, `description`, `capabilities`, `defaultInputModes` and `defaultOutputModes` (`text/plain` for a string schema, `application/json` otherwise), and one skill (`id` and `name` are the agent's name, `tags` holds the job name). It has no endpoint. The JSON Schemas are under `x-stage`, with the `modes`. For a card you can call, use the [A2A gateway](#a2a-gateway).

## Run modes

A request picks where the agent runs: `quick` or `workflow`.

|          | `workflow` (default)                             | `quick`                                                               |
| -------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Host     | The Cloud Run **job**, started in the background | A Cloud Run **service** of the same agent image, started with `serve` |
| Best for | Multi-step or long work                          | A lookup or a single answer                                           |
| Limit    | The job timeout                                  | `QUICK_BUDGET_MS` (default 60 s, at most 240 s)                       |
| Answer   | `202` at once, follow the session                | `202` at once, follow the session                                     |

Both run the same code on the same Firestore session state and run lease.

- **Choose a mode:** `POST /tasks/:taskId/run` with `"mode": "quick"` in the body, alone or together with `message`, `sessionId` and `model`. Quick answers `202` with the session id as soon as the session exists; the service holds the call to the agent open in the background.
- **Failures:** a quick run that fails on the agent, or never reached it, is recorded as a failed run on its session. A lease conflict clears the queued message instead. A run over its budget is stopped and recorded as failed with "stopped at its time budget".
- **Which agents support it:** an agent lists the modes it supports as `modes` in its spec. Every agent of `generic` (except `document-analyser`, which reads task documents), `poet`, `knowledge` and `orchestrator` supports both. Unset means job only. They show in the registry and under `x-stage.modes` in the Agent Card.
- **`AGENT_QUICK`:** `register` keeps `quick` only when `AGENT_QUICK=true`, which Terraform sets on the job of every app in `agent_service_apps`. Run `task register-agents` with `AGENT_QUICK=true` for such an app, or register through the API, which uses the job's own environment.
- **The agent service:** it runs `bun agents/<name>/src/main.ts serve` on `PORT` (default 8080) and answers `POST /run` with `{ taskId, sessionId?, budgetMs? }`: `200 { reply }`, `409` for a run in progress, `504 { error: "quick_timeout" }` when stopped at its budget, `400` for a bad body. A missing or larger `budgetMs` gets the 10-minute maximum, and a caller that disconnects stops the run.

### Quick service setup

Terraform owns the services. `agent_service_apps` in `infra/modules/stage` (all four apps in `infra/envs/local`) creates `stage--<name>-agents--svc-lcl` from the job's image, environment and secrets, with `args = ["serve"]`, and gives the control service `AGENT_SERVICES`.

- The control service reads `AGENT_SERVICES`, `AGENT_SERVICES_ID_TOKEN` and `QUICK_BUDGET_MS` (see [Configuration](configuration.md#control-service)). URLs must be http or https, an ID token is sent only to https URLs, and redirects are refused.
- Keep `QUICK_BUDGET_MS` below `agent_service_timeout` (90 s by default).
- The services have no authentication of their own: Cloud Run IAM is the gate, so the local Floci services are open. Each takes `agent_service_concurrency` (10) runs per instance and defaults to internal-only ingress. With `service_service_account` set, the module grants it `roles/run.invoker` on each. Use `set_agent_services_audience` and `service_vpc_access` so the control service can reach them.
- A service running on the host takes its value from `terraform -chdir=infra/envs/local output -raw agent_services`.
- On GCP the service needs always-allocated CPU (`cpu_idle = false`), because it keeps working after it has answered. `infra/envs/gcp` does not set `agent_service_apps` yet, so there only `workflow` is offered.
- If a run cannot be stopped after a timeout, the session stays leased for `RUN_LEASE_MS` (10 minutes).

## A2A gateway

The control service serves every registered agent as an [A2A](https://a2a-protocol.org) endpoint:

| Route                                              | Purpose                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /a2a/:job/:agent/.well-known/agent-card.json` | The Agent Card, with the endpoint it advertises                                                                                                               |
| `POST /a2a/:job/:agent`                            | JSON-RPC. `message/send` creates an ordinary task, runs the job with the message queued, waits for the session to finish and returns the reply as an A2A task |

A delegated run shows up in the dashboard like any other run, as a sub-task of the caller's task.

- **Only the blocking `message/send` is supported.** Streaming, resubscribe and cancel answer with a JSON-RPC error.
- **Parent links:** the caller names its task and session in the A2A message (`stage:parent`). The gateway stores `parentTaskId` and `parentSessionId` on the new task only when that task exists and the session is still running; an unverified claim is ignored. `POST /tasks` cannot set a parent.
- **Mode:** `stage:mode` in the message metadata chooses it. `quick` runs on the agent's service and answers with the reply; a run over its budget, or an agent with no service, fails the A2A task with a message that says to ask again with `workflow`. `workflow` starts the job and answers at once with a receipt (`Started workflow task <taskId> ...`); the A2A task is `completed` and the run goes on in the background. With no `stage:mode`, the gateway starts the job and waits for the reply.
- **Limits:**
  - `A2A_TIMEOUT_MS` (default 240 s, at most 250 s) bounds the wait. The route raises Bun's idle limit to 255 s, and the service's own request timeout on GCP is 300 s.
  - At most 8 delegated runs are waited for at once; more are refused.
  - At most 20 workflow runs start per minute across the gateway.
  - A body over 64 KiB is refused with `413 payload_too_large`.
  - The gateway remembers only the last 200 tasks, and not their message history.
- **Safety:** a leading `Web search:` in an A2A message is rewritten, so another agent cannot trigger the discovery agent's explicit-query path. A failed run answers with a fixed message; the error stays in the logs and the sessions API.
- **`PUBLIC_URL`** sets the address the cards advertise. The default is the origin of the request.
- **Deleting** a task deletes its sub-tasks, and theirs, with their sessions. A task with more than 500 sub-tasks is refused with `409`. The dashboard shows sub-tasks indented under their parent and names the count in the delete confirmation.

> The gateway is as open as the rest of the service: there is no job-to-service authentication yet. Do not deploy the orchestrator on GCP until there is. `HOST=0.0.0.0` exposes unauthenticated job execution to the network.

## Orchestrator

The `orchestrator` picks among the other registered agents by the request, calls them over A2A, and answers from their replies. It only routes: its first model step of each turn must call an agent (function-calling mode `ANY`), so it cannot answer or decline on its own, and a greeting also goes to some agent.

- **Tools:** the job reads the agents from the registry when a run asks for its tools, and leaves its own job out. It tells the model to send JSON to agents with a structured input, and leaves out agents that take no input (`document-analyser`).
- **Mode:** each agent that has `modes` gets a `mode` argument limited to the modes it supports. The model is told to use `quick` for a lookup or a single answer and `workflow` for multi-step or long work, to retry a quick run that missed its budget as `workflow`, and to report a workflow receipt (the task id) instead of presenting it as the answer. The orchestrator does not wait for a workflow run or resume when it finishes.
- **Reaching the service:** the job uses `GATEWAY_URL` (`gateway_url` in `infra/envs/local`, default `http://host.docker.internal:3000`). A service on the host needs `HOST=0.0.0.0`. The local job sets `GATEWAY_ALLOW_INSECURE`, because ADK refuses plaintext http to a non-loopback host otherwise.

## Knowledge job

The `knowledge` job holds three agents that read data you load first.

### knowledge-assistant

Answers questions from the Qdrant `docs` collection that `packages/ingestion` fills (the Bun and DuckDB docs). Its `search_knowledge_base` tool embeds the query with the same embedding server as ingestion (oMLX), queries Qdrant, and, when `RERANK_MODEL` is set, fetches 25 candidates and reranks them through `/v1/rerank` down to the top 5. The job reaches both servers on the host through `host.docker.internal`.

- Set `qdrant_url`, `embedding_url` and `qdrant_collection` in `infra/envs/local`. `task tf:apply` also passes `EMBEDDING_MODEL`, `EMBEDDING_QUERY_PREFIX`, `RERANK_MODEL`, `RERANK_API_KEY` and the optional API keys from `.env`.
- To ingest the docs, see the [ingestion README](../packages/ingestion/README.md).
- Smoke test: `bun run --filter @stage/knowledge-agents smoke "<question>"` runs the agent live against the local Qdrant and embedding server. It fails unless the agent searched and returned a valid `{ answer, sources }` reply.

### imdb-assistant

Answers questions about films, series and people from the IMDb datasets (non-commercial use only).

1. Load the data: `task load-imdb`. It downloads about 1.9 GB into the `stage--imdb--db-lcl` Cloud SQL Postgres that Floci runs (`scripts/imdb-load.ts`, schema in `data/schemas/`). It also creates the indexes and grants read access to the `imdb_reader` role.
2. The agent's `query_imdb` tool runs one model-written `SELECT` as `imdb_reader`, in a read-only transaction with a 10 s timeout and a 50-row cap.
3. The job reaches the database through `IMDB_DATABASE_URL`, which `task tf:apply` sets on that job only (`imdb_db_host`, `imdb_reader_password`).

The database has no host port. To open a shell in it: `docker exec -it floci-gcp-cloudsql-floci-local-stage--imdb--db-lcl psql -U imdb -d imdb`.

### discovery-assistant

Combines the internal sources (IMDb, Qdrant, the Neo4j graph) with a public web search.

- The agent writes a short public query for Exa from what you said, so a follow-up like "where does she live?" works.
- The tool accepts one model-written query per turn. It refuses the query once an internal tool has returned data in the same turn, so a lookup and a web search in one message need the prefix. A follow-up message can search freely, including about names from earlier results.
- To force an exact query, or to combine it with an internal question, put `Web search: <public query>` on the first line of the message. The tool then sends that line and ignores the model's.
- The agent lists the URLs it used in `sources`.
- Setup: set `EXA_API_KEY` in `.env`, rebuild the knowledge job image (`task build:agents JOBS=knowledge`), and run `task tf:apply`. Floci stores the key as a plain job environment value in local Terraform state.

## See also

- [API](api.md): task and run routes
- [Configuration](configuration.md): models and environment variables
- [Evals](../evals/README.md): end-to-end checks of these agents
- [ADK documentation](https://google.github.io/adk-docs/)

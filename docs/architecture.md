# Architecture

How `stage` is put together: the components, what happens when a task runs, and where the code lives. The diagram source is [architecture.drawio](architecture.drawio) ([PDF](architecture.drawio.pdf)).

## Components

```
Dashboard (apps/ui) ─► Control service (apps/control-service) ─► Cloud Run job, one image per agent app (agents/*)
                           │      │                                  │  └─ ADK runner ─► model (Gemini, OpenAI-compatible)
                           │      └─► Extract service (document ─► text)
                           └─► Firestore: tasks, sessions, documents, agent registry, providers
                               Pub/Sub:   agent events, platform events ─► server-sent events
```

| Component           | Role                                                                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Control service** | A thin control plane. It stores tasks, starts job executions, reads Firestore and relays Pub/Sub as server-sent events. It never runs an agent itself                              |
| **Agent jobs**      | One Cloud Run job image per agent app. A job loads the task, runs the agent with the [ADK](https://google.github.io/adk-docs/), and writes the session and its events to Firestore |
| **Quick services**  | The same agent image, started with `serve`, for short runs that should answer in seconds. See [run modes](agents.md#run-modes)                                                     |
| **Extract service** | Turns an uploaded document into text for a task                                                                                                                                    |
| **Dashboard**       | A React app that talks to the control service only                                                                                                                                 |
| **Floci**           | The local emulator for Firestore, Cloud Run, Pub/Sub and Cloud SQL. On GCP these are the real services                                                                             |

## What happens when a task runs

1. `POST /tasks` saves the task contract (name, prompt, job, optional agent and model) to Firestore. Nothing runs yet.
2. `POST /tasks/:taskId/run` checks the task and starts the job's Cloud Run execution. The only per-run input is `TASK_ID`, plus `SESSION_ID` when it resumes a session. A resume message is queued on the session in Firestore, not passed in the environment. The call answers `202` as soon as the execution is submitted.
3. The job reads `tasks/{taskId}`, takes a lease on the session, and runs the agent. Each ADK event is written to Firestore and published to the agent-events topic.
4. The control service replays the stored events and then streams new ones to the client as server-sent events (`GET /tasks/:taskId/sessions/:sessionId/messages`).
5. The job records the run as `succeeded` or `failed` on the session and exits.

Design choices behind this flow:

- **Firestore is the source of truth.** Pub/Sub is best effort: a failed publish never fails a run, and events published before a client connects are read from Firestore.
- **A run is one-shot and never retried.** Jobs set `max_retries = 0`, because a retry would create another session or append a resume message twice.
- **One run per session.** A lease with a heartbeat, plus a run id that fences stale writers, stops two executions from working on one session. A resume of a running session answers `409 run_in_progress`.
- **The control service has no authentication yet.** Do not expose it beyond your machine. See [Operations](operations.md#security-notes).

## Repository layout

| Path                       | Package                             | What it holds                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/control-service`     | `@stage/control-service`            | The Elysia API, laid out by feature (see below)                                                                                                                                                                                      |
| `apps/extract-service`     | `@stage/extract-service`            | Elysia service for `POST /extract` (port 8080)                                                                                                                                                                                       |
| `apps/ui`                  | `@stage/ui`                         | React, Tailwind and shadcn dashboard, built with Vite                                                                                                                                                                                |
| `agents/generic`           | `@stage/generic-agents`             | `assistant` and `document-analyser`                                                                                                                                                                                                  |
| `agents/poet`              | `@stage/poet-agents`                | `haiku-poet` and `limerick-poet`                                                                                                                                                                                                     |
| `agents/knowledge`         | `@stage/knowledge-agents`           | `knowledge-assistant`, `imdb-assistant`, `discovery-assistant`                                                                                                                                                                       |
| `agents/orchestrator`      | `@stage/orchestrator-agents`        | `orchestrator`, which delegates to the other agents                                                                                                                                                                                  |
| `packages/agents`          | `@stage/agents`                     | Job entrypoint (`runCli`), ADK runtime, Firestore session store, task-contract reader, agent registry, event publisher, model factory                                                                                                |
| `packages/http`            | `@stage/http`                       | What both Elysia apps share: request id, request spans, OpenTelemetry setup (`setupTelemetry`, also used by the agent jobs), config loader (`createConfigLoader`), base error handler. It depends on `elysia` and OpenTelemetry only |
| `packages/tools`           | `@stage/tools`                      | Reusable ADK tools, such as `search_web` (Exa)                                                                                                                                                                                       |
| `packages/ingestion`       | `@stage/ingestion`                  | CLI that fetches, chunks and embeds documentation into Qdrant and a Neo4j catalog. See its [README](../packages/ingestion/README.md)                                                                                                 |
| `packages/evals`, `evals/` | `@stage/evals`, `@stage/eval-suite` | The eval harness and the scenarios. See the [evals README](../evals/README.md)                                                                                                                                                       |
| `infra/`                   |                                     | Terraform: `modules/stage` (shared), `envs/local` (Floci), `envs/gcp`                                                                                                                                                                |
| `docker/`                  |                                     | One Dockerfile per image and the `build:*` tasks                                                                                                                                                                                     |
| `scripts/`                 |                                     | Maintenance scripts: IMDb load, data migrations, dependency checks                                                                                                                                                                   |

Each app declares its agents in `agents/<name>/src/agents.ts`.

### Control service layout

The control service is organised by feature, following [Elysia's best practice](https://elysiajs.com/essential/best-practice.html):

```
apps/control-service/src/
  index.ts  app.ts  config.ts
  http/       shared error handling
  platform/   clients for external systems (Firestore, Cloud Run, Pub/Sub, extract)
  modules/
    tasks/      tasks-controller.ts  tasks-service.ts  tasks-model.ts  tasks-store.ts
      sessions/   documents/        children live inside their parent
    agents/  events/  providers/  a2a/  health/
```

- A **controller** is an Elysia instance that parses the request and calls a service.
- A **service** holds an operation that needs more than one store or client, and returns a status for each expected outcome. It throws `DependencyError` when a dependency fails.
- A **store** wraps one Firestore collection with `create`, `list`, `get` and `delete`.
- Services, stores and clients are factories (`createTasksStore(firestore)`), not classes.

The conventions are in [AGENTS.md](../AGENTS.md#repository-conventions) and the design history is in [apps/control-service/PLAN.md](../apps/control-service/PLAN.md).

## Dependency overrides

The root `package.json` pins `@google/genai` (2.32.0), `google-gax` (6.17.0) and `@opentelemetry/semantic-conventions` (1.45.0), so each image carries one copy of each (about 25 MB less). The pins force one version on packages that ask for others, and `bun outdated` does not report them. After upgrading `@google/adk` or a Google Cloud client, bump or drop the overrides and run one task on each agent image before relying on them.

## See also

- [Configuration](configuration.md): environment variables
- [API](api.md): the routes the dashboard uses
- [Agents](agents.md): agent apps, registry and run modes
- [Naming rules](naming-rules.md): resource, image and agent names

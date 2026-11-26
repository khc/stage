# API

The control service is an HTTP API on `http://localhost:3000`. While it runs, the interactive reference (Scalar) is at <http://localhost:3000/docs> and the OpenAPI 3.1 document is at <http://localhost:3000/openapi.json>. Both are generated from the routes, and the dashboard's types come from the same source. This page explains how the routes fit together; the generated reference lists every field.

- **There is no authentication yet.** Keep the service on `127.0.0.1`.
- **Errors** are JSON: `{ "error": "<code>" }` with a snake_case code. A failing dependency (Firestore, Cloud Run, Pub/Sub) answers `502` with a short code and no detail, which is logged on the server. Every response carries an `x-request-id` header.
- **Ids** in paths must be UUIDs, except session ids, which are matched exactly. Task ids are normalised to lowercase. An invalid id answers `400`.

## Routes

| Group                               | Routes                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Tasks](#tasks)                     | `POST /tasks`, `GET /tasks`, `GET /tasks/:taskId`, `DELETE /tasks/:taskId`, `POST /tasks/:taskId/run`                                   |
| [Sessions](#sessions)               | `GET /tasks/:taskId/sessions`, `GET .../:sessionId`, `GET .../:sessionId/stats`, `GET .../:sessionId/messages`, `DELETE .../:sessionId` |
| [Documents](#documents)             | `GET`, `POST /tasks/:taskId/documents`, `GET`, `DELETE .../:documentId`                                                                 |
| [Jobs and agents](#jobs-and-agents) | `GET /jobs`, `GET /jobs/:jobName/agents`, `GET /jobs/:jobName/agents/:agentName/card`, `POST /jobs/:jobName/register`                   |
| [Providers](#providers)             | `GET`, `POST /providers`, `GET`, `PATCH`, `DELETE /providers/:providerId`, `POST /providers/models`                                     |
| [Events](#events)                   | `GET /events`, `GET /tasks/:taskId/sessions/:sessionId/messages`                                                                        |
| [A2A](agents.md#a2a-gateway)        | `GET /a2a/:job/:agent/.well-known/agent-card.json`, `POST /a2a/:job/:agent`                                                             |
| Health                              | `GET /health`                                                                                                                           |

## Tasks

A task is a saved contract: a prompt, the job that runs it and, optionally, the agent and the model. Creating a task saves it and starts nothing.

### Create a task

```bash
curl -X POST localhost:3000/tasks -H 'content-type: application/json' \
  -d '{"name":"Time in Tokyo","prompt":"What time is it in Tokyo?","jobName":"stage--generic-agents--job-lcl"}'
```

The reply is `201` with the task, which carries a generated `taskId`.

| Field          | Required | Rules                                                                                                                                                                                                   |
| -------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`         | yes      | 1 to 200 characters, trimmed                                                                                                                                                                            |
| `prompt`       | yes      | 1 to 10,000 characters, trimmed                                                                                                                                                                         |
| `jobName`      | yes      | A job allowed by `AGENT_JOBS`. At most 63 characters: lowercase letters, digits and hyphens, starting with a letter and ending with a letter or digit. Not a resource path                              |
| `agentName`    | no       | Which agent in the job runs the task: lowercase letters, digits and hyphens, at most 64 characters. Omit it for the job's default agent. If the job has registered agents, the name must be one of them |
| `defaultModel` | no       | `{ "providerId", "model" }` from [Providers](#providers)                                                                                                                                                |

A structured agent (for example `haiku-poet`) expects its prompt to be a JSON object that matches its input schema. See [Agents](agents.md#registry).

Errors: `400` for invalid input, `unknown_job`, `unknown_agent` or `unknown_model`; `502 task_error`.

### Read and delete

| Request                 | Success                                                                                           | Errors                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /tasks`            | `200 { "tasks": [...] }`, unpaginated and unordered                                               |                                                               |
| `GET /tasks/:taskId`    | `200` the task                                                                                    | `404 task_not_found`                                          |
| `DELETE /tasks/:taskId` | `204`. Removes the task, its sessions and events, its sub-tasks, and documents no other task uses | `404 task_not_found`, `409 too_many_subtasks` (more than 500) |

Deleting does not stop runs in progress, and open event streams stay open until the client disconnects. A sub-task is a task started by the orchestrator (see [A2A](agents.md#a2a-gateway)).

### Run a task

`POST /tasks/:taskId/run` needs no body. It starts the task's job and answers `202`:

```json
{ "operation": "<Cloud Run operation name>", "sessionId": "<session id>" }
```

`202` means the run was submitted, not that it succeeded. Follow it on the [session stream](#events) or read the session's `run` field (`running`, `succeeded` or `failed`). Each plain run creates a new session, so repeating the request starts another execution.

The optional JSON body picks the host and the model:

| Field                  | Meaning                                                                                                                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                 | `workflow` (default) starts the Cloud Run job in the background. `quick` calls the agent's service. See [run modes](agents.md#run-modes) |
| `model`                | `{ "providerId", "model" }` for this run only                                                                                            |
| `sessionId`, `message` | Resume a session, see below                                                                                                              |

A body that is not JSON, or a `mode` in the query string, answers `400 invalid_request`. A body with an invalid `mode` answers `400 invalid_mode`.

#### Resume a session

```bash
curl -X POST "localhost:3000/tasks/$TASK_ID/run" -H 'content-type: application/json' \
  -d '{"sessionId":"<sessionId>","message":"Now in Paris?"}'
```

The service queues `message` on the session in Firestore and starts the job with only `TASK_ID` and `SESSION_ID`. The message is a free-text follow-up: a structured agent's input schema is not checked for it. A `message` without `sessionId` starts a new session from that message.

#### Run errors

| Status | Code                                  | Meaning                                                                         |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------- |
| 400    | `invalid_resume`                      | The message is blank, or the `sessionId` is invalid                             |
| 400    | `unknown_model`                       | The model's provider is disabled, or the model is not listed or is switched off |
| 404    | `task_not_found`, `session_not_found` | No such task, or the session belongs to another task                            |
| 409    | `task_not_executable`                 | The task has no valid `jobName`, or its job is not allowed                      |
| 409    | `run_in_progress`                     | The session is running                                                          |
| 409    | `message_pending`                     | A message queued less than 60 seconds ago has not been picked up                |
| 409    | `quick_unavailable`                   | The job has no quick service                                                    |
| 429    | `too_many_quick_runs`                 | Too many quick runs are still in flight                                         |
| 502    | `job_error`, `task_error`             | Cloud Run or Firestore failed                                                   |

If Cloud Run rejects the job, the service clears the queued message.

## Sessions

A session is one conversation of a task: the ADK state and its ordered events. Each job execution creates one, linked to its task by `taskId`. Older sessions without a `taskId` do not appear.

| Request                                  | Success                     | Notes                                                                                                       |
| ---------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /tasks/:taskId/sessions`            | `200 { "sessions": [...] }` | Summaries: `id`, `taskId`, `appName`, `userId`, `lastUpdateTime`, and the run state. No events. Unpaginated |
| `GET /tasks/:taskId/sessions/:sessionId` | `200` the full session      | `state`, ordered `events` and the `run` state                                                               |
| `GET .../:sessionId/stats`               | `200` usage totals          | See below                                                                                                   |
| `DELETE .../:sessionId`                  | `204`                       | Removes the session and its events. Open streams stay open                                                  |

Errors: `400` invalid ids, `404 task_not_found` or `session_not_found` (also for a session of another task), `502 session_error`.

### Session stats

```json
{
  "events": 12,
  "llmCalls": 3,
  "tokens": {
    "prompt": 0,
    "candidates": 0,
    "thoughts": 0,
    "toolUsePrompt": 0,
    "cached": 0,
    "total": 0
  }
}
```

The totals are summed from the model usage on the stored events. `llmCalls` counts events that carry usage. `cached` is part of `prompt`. `total` is the model-reported total, which also covers thoughts and tool-use prompt tokens. Streaming partial events are not stored, so they are not counted.

## Documents

Attach a file to a task and the agent can read it. Needs `EXTRACT_URL`; without it every document route answers `501 not_supported`.

| Request                                                   | Success                          | Errors                                                                                              |
| --------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /tasks/:taskId/documents` (multipart, field `file`) | `201` the document summary       | `400 file_required`, `413 file_too_large` or `document_too_large`, `422` the file could not be read |
| `GET /tasks/:taskId/documents`                            | `200 { "documents": [...] }`     |                                                                                                     |
| `GET .../:documentId`                                     | `200` the document with its text | `404 document_not_found`                                                                            |
| `DELETE .../:documentId`                                  | `204`                            | `404 document_not_found`                                                                            |

## Jobs and agents

| Request                                     | Success                                                                                  | Errors                |
| ------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| `GET /jobs`                                 | `200 { "jobs": [...] }`. The jobs in `GCP_PROJECT` and `GCP_REGION`, all pages collected |                       |
| `GET /jobs/:jobName/agents`                 | `200 { "agents": [...] }`, empty if the job was never registered                         |                       |
| `GET /jobs/:jobName/agents/:agentName/card` | `200` an A2A-style Agent Card                                                            | `404 agent_not_found` |
| `POST /jobs/:jobName/register`              | `202 { "operation" }`. Runs the job in `register` mode so it records its agents          | `400 unknown_job`     |

See [Agents](agents.md#registry) for what the registry holds.

## Providers

Saved model endpoints. Keys are write-only.

| Request                                        | Success                                                                                                                                                                    | Errors                   |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `GET /providers`, `GET /providers/:providerId` | `200`                                                                                                                                                                      | `404 provider_not_found` |
| `POST /providers`                              | `201` the provider. Body: `name`, `kind` (`google`, `google-express`, `openai`), and optionally `apiKey`, `baseUrl`, `defaultModel`, `models`, `disabledModels`, `enabled` | `400`                    |
| `PATCH /providers/:providerId`                 | `200`. Send `null` to clear an optional field                                                                                                                              | `404`, `400`             |
| `DELETE /providers/:providerId`                | `204`                                                                                                                                                                      | `404`                    |
| `POST /providers/models`                       | `200 { "models": [...] }`. Asks the provider's API which models it offers                                                                                                  | `400`, `404`             |

See [Configuration](configuration.md#models-and-providers) for how a model is chosen.

## Events

Two Server-Sent Events streams show what is happening.

### Session events

`GET /tasks/:taskId/sessions/:sessionId/messages` first replays the stored events in order, then streams the events the agent publishes until the client disconnects. In a browser, use `new EventSource(url)`.

- Each message has `id` set to the event id and `data` set to the event JSON. A duplicate event id is sent once.
- A `keepalive` event is sent every 5 seconds when the stream is idle.
- A missing task or session (or a session of another task) answers `404` before the stream starts. A Firestore or Pub/Sub failure answers `502 events_error`.
- Live events need `PUBSUB_TOPIC` on the service, matching the agent's topic. Without it only stored events are sent, and the connection stays open without ending, so `EventSource` does not reconnect in a loop.
- The service creates one ephemeral Pub/Sub subscription per process on the first stream and shares it between clients. It expires after 24 hours without a consumer. Events published before the first stream are served from Firestore, so none is missed.

Through the dashboard's dev server the same stream is at `http://localhost:5173/tasks/:taskId/sessions/:sessionId/messages`.

### Platform events

`GET /events` streams the events the service publishes about itself.

| Type                                 | When                                                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `task.created`, `task.deleted`       | A task was created or deleted. Deleting also removes its sessions and unused documents, without separate events |
| `task.run_requested`                 | A run was submitted, not completed                                                                              |
| `document.added`, `document.removed` | A document was attached or explicitly removed                                                                   |
| `job.registration_requested`         | `POST /jobs/:jobName/register` was called                                                                       |

- The message data is `{ eventId, type, occurredAt, ... }` with `taskId`, `jobName`, `agentName`, `sessionId` or `documentId` where they apply. Pub/Sub attributes are `eventId`, `eventType` and `taskId`, so subscribers can filter.
- An event is published after its operation succeeds. Publishing is best effort and runs in the background: a failure is logged and never delays or fails the request. Delivery is at-least-once, so de-duplicate on `eventId`.
- Events published while no client is connected are not replayed.
- It needs `PLATFORM_EVENTS_TOPIC` on the service (the topic is created on first publish) and answers `501 not_supported` without it, and `502 events_error` on a Pub/Sub failure.
- The dashboard uses it to refresh without polling, and falls back to polling every 15 seconds while the stream is down.

### Agent events

The agent publishes every ADK event (model responses, tool calls and results) to the topic named by `PUBSUB_TOPIC` on the job. The message data is the event JSON, and the attributes are `eventId`, `sessionId` and `taskId`. Publishing is best effort, so a failure is logged and does not fail the run. Terraform sets the topic to `stage--agent-events--ps-lcl`. The job creates a missing topic on its first publish. To read the events yourself locally, create a subscription with Floci's Pub/Sub REST API (`PUT /v1/projects/floci-local/subscriptions/<name>`).

## See also

- [Agents](agents.md): registry, run modes and A2A
- [Operations](operations.md): rollout order and data migrations
- [Architecture](architecture.md#what-happens-when-a-task-runs): the run flow

# stage

Bun workspace monorepo with apps under `apps/`, agent apps under `agents/` and shared code under `packages/`:

- `@stage/agents` (`packages/agents`): code shared by the agent apps: the job entrypoint (`runCli`: run a task, or `register`), the ADK runtime, the Firestore session store, the task-contract reader, the agent registry, the event publisher, and the model factory.
- `@stage/generic-agents` (`agents/generic`): a Cloud Run Job image with the general-purpose agents (`assistant`, which can tell the time in a city).
- `@stage/poet-agents` (`agents/poet`): a Cloud Run Job image with the poetry agents (`haiku`).
- `@stage/service` (`apps/service`): Hono HTTP API and OpenAPI/Scalar reference on port `3000`.
- `@stage/web` (`apps/web`): Standalone React/Tailwind dashboard server on port `3001` (proxies API requests to `SERVICE_URL`, default `http://localhost:3000`).

To install dependencies:

```bash
bun install
```

To run in development:

```bash
bun run dev:service   # HTTP API service on http://localhost:3000
bun run dev:web       # Web dashboard on http://localhost:3001
```

To type check:

```bash
bun check
```

Run `bun run format` (oxfmt, configured in `.oxfmtrc.json`) to format the code, `bun run format:check` to only check it, and `bun run lint` / `bun run lint:fix` (oxlint, `.oxlintrc.json`) to lint.

## Local environment

```bash
docker compose up -d --build   # start (builds the service image)
docker compose down            # stop
```

- Configuration lives in `.env` (gitignored; Bun and `docker compose` both read it). Put your `GEMINI_API_KEY` there; the file lists every other variable the project uses. The service and web start/dev scripts explicitly load this root file even when Bun runs them from a workspace directory.
- Model: `AGENT_MODEL` picks it (default `gemini-2.5-flash`, Gemini API). With `GOOGLE_GENAI_USE_VERTEXAI=true` and an API key the agent uses Vertex AI in express mode, e.g. `AGENT_MODEL=publishers/google/models/gemini-2.5-flash`; ADK 2.4.0 cannot do this itself, so `packages/agents/src/model.ts` provides a small `Gemini` subclass. Without a key, the flag selects ADK's own Vertex mode (needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Google Cloud credentials).
- `service` (`Dockerfile.service`, `apps/service`) is the Hono HTTP service on `localhost:3000`: `GET /health`, `GET /jobs`, and the task-contract routes below. `curl localhost:3000/jobs` lists all Cloud Run Jobs in the configured `GCP_PROJECT` and `GCP_REGION`, returning `{ "jobs": [...] }` (or `{ "jobs": [] }`) and collecting all upstream pages automatically. In compose the service uses Floci for Firestore (`FIRESTORE_EMULATOR_HOST=floci-gcp:4588`) and Cloud Run jobs (`CLOUD_RUN_EMULATOR_HOST=floci-gcp:4588`, REST without credentials). Without `CLOUD_RUN_EMULATOR_HOST` it uses the real Cloud Run API and needs Application Default Credentials.
- With the stack up, `task create-job` (needs [go-task](https://taskfile.dev)) creates the agent Cloud Run job in Floci. Override with `task create-job JOB=my-job`; it fails if the job already exists. Creation reads `.env` through Bun and supplies `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST`, `GEMINI_API_KEY` (required), and optional `AGENT_MODEL` / `GOOGLE_GENAI_USE_VERTEXAI`. No prompt or task ID is stored in the job definition. Job containers use `floci-gcp:4588` for Firestore; set `JOB_FIRESTORE_EMULATOR_HOST` to override that container-visible address. `task update-job` updates the existing job image/environment and removes legacy `AGENT_MESSAGE` and static `RUN_ID` / `TASK_ID` entries from the agent container; running executions keep their original settings. These commands print only the resource name to avoid exposing credentials. `task list-jobs` prints jobs as JSON (pipe to `jq`; `{}` when there are none). `task remove-job JOB=my-job` deletes one after confirmation (`--yes` skips it). Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.
- Each agent app is its own job image, built from the shared `Dockerfile.agents` with the app as `APP` (`docker build -f Dockerfile.agents --build-arg APP=poet -t stage-poet .`). `task rebuild` builds all of them, `task create-job` / `task update-job` create and update one Floci job per app (`generic`, `poet`; narrow with e.g. `JOBS=poet`), and `task register-agents` registers their agents. A new agent app needs its own `agents/<name>` entry plus its name in `JOBS` (Taskfile) and in the workspace `COPY` lines of the Dockerfiles.

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
  -d '{"prompt":"hello","jobName":"my-agent-job"}'
```

Returns HTTP 201 `{ "taskId": "<generated UUID>", "prompt": "hello", "jobName": "my-agent-job" }` after saving these fields at Firestore `tasks/{taskId}`. Prompts are trimmed and must contain 1–10,000 characters after trimming. An optional `agentName` (an identifier of letters, digits and underscores, at most 64 characters, not starting with a digit) selects which agent inside the job container runs the task, so one job image can hold several agents; it is stored with the contract, returned by the task routes, and also used when a session of the task is resumed. Omit it to run the job image's default agent (`assistant` in `@stage/generic-agents`, `haiku` in `@stage/poet-agents`). An unknown name makes the job exit 1 with `Unknown agent: <name>`; the service does not know which agents a container holds, so it validates only the format. Agents are declared in each app's `agents/<name>/src/agents.ts`. `jobName` is required, at most 63 characters, starts with a lowercase letter, contains lowercase letters/digits/hyphens, and ends in a letter or digit. It cannot be a full resource path or have surrounding spaces. Invalid/missing JSON input returns 400; extra properties are ignored.

Use the returned UUID to read or execute the task:

```bash
TASK_ID='paste-the-returned-UUID-here'
curl localhost:3000/tasks
curl "localhost:3000/tasks/$TASK_ID"
curl -X POST "localhost:3000/tasks/$TASK_ID/run"
```

`GET /tasks` returns HTTP 200 `{ "tasks": [{ "taskId": "<UUID>", "prompt": "hello", "jobName": "my-agent-job" }] }`, or `{ "tasks": [] }`. It returns all contracts without pagination or guaranteed ordering. `GET /tasks/:taskId` returns the individual contract with HTTP 200. Invalid UUIDs return 400; valid UUIDs are normalized to lowercase. Missing tasks return 404 `{ "error": "task_not_found" }`. Firestore failures return 502 `{ "error": "task_error" }`.

`POST /tasks/:taskId/run` requires no body. It reads the stored jobName, starts that job in the service's `GCP_PROJECT` / `GCP_REGION`, and returns HTTP 202 `{ "operation": "<Cloud Run operation name>" }` after submission. A supplied body cannot override jobName or prompt. Only `TASK_ID` is passed as a per-execution environment override. The agent reads `tasks/{taskId}` from Firestore and runs its stored prompt; it never falls back to `AGENT_MESSAGE`. Invalid UUIDs return 400; absent tasks return 404 `task_not_found`; missing or invalid stored jobName returns 409 `{ "error": "task_not_executable" }`; Firestore lookup failures return 502 `task_error`; Cloud Run submission failures return 502 `{ "error": "job_error" }`.

HTTP 202 acknowledges submission, not agent success. Missing/invalid TASK_ID, missing contracts, invalid prompts, Firestore errors, or agent errors cause the job process to exit 1. No execution status or result is written to the task contract. Each job invocation creates a separate session with its own session ID and a top-level `taskId` field in the Firestore `sessions` document, linking it to the contract. The link is retained when sessions are loaded or listed. Older sessions can omit `taskId`. Repeated run requests can start multiple executions and sessions.

The former `/jobs/runs` routes and `POST /jobs/:name/run` URL are removed; use `/tasks` and `POST /tasks/:taskId/run`. Migrated prompt-only tasks remain readable but cannot be run without a jobName; recreate them with a jobName. Both the service and agent use the existing Firestore configuration (`GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST` locally, or Application Default Credentials when deployed), and must point to the same project/database.

For rollout, build the new agent images (`task rebuild`) and update the jobs (`task update-job`) before using the new task run route. Then rebuild/restart the local service (`docker compose up -d --build service`). Existing job definitions retain their Firestore/model credentials; execution input is supplied only by the new endpoint. For deployed jobs, apply the same agent-before-service sequence through the deployment tooling.

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

Deploy both new images together during the maintenance window: the service sends only `TASK_ID`, the agent loads `tasks/{taskId}`, and new sessions store `taskId`. Update job definitions with `task update-job` to remove old static `AGENT_MESSAGE`, `RUN_ID`, and `TASK_ID` values before resuming requests. The agent no longer accepts `RUN_ID` as execution input. The migration is provided as tooling; it does not run automatically at service startup.

Resuming a session no longer passes the message to the job: the service queues it on the session in Firestore and starts the job with only `TASK_ID` and `SESSION_ID`. Rebuild the agent images (`task rebuild`), update the jobs (`task update-job`) and restart the service together; an agent image from before this change fails a resume with `MESSAGE is required to resume a session`.

### Event publishing

The agent publishes every event the ADK runner yields (model responses, tool calls and results) to a Pub/Sub topic. The message data is the event as JSON; attributes are `eventId`, `sessionId`, and `taskId` (when the run belongs to a task). Publishing is on when `PUBSUB_TOPIC` is set. `task create-job` / `task update-job` set it to `agent-events` by default (override with `PUBSUB_TOPIC` in `.env`) and set `PUBSUB_EMULATOR_HOST` to `floci-gcp:4588` (override with `JOB_PUBSUB_EMULATOR_HOST`). The topic is created on first publish if it does not exist. Without the emulator host the agent uses the real Pub/Sub API and Application Default Credentials. Publishing is best effort: a failure is logged and does not fail the run. Events are published in order but delivery to subscribers is at-least-once, so use `eventId` to de-duplicate. Run `task update-job` and rebuild the agent image after upgrading. To read events locally, create a subscription on the topic through Floci's Pub/Sub REST API (`PUT /v1/projects/floci-local/subscriptions/<name>`).

### Deleting a session

`DELETE /tasks/:taskId/sessions/:sessionId` permanently removes the session and all its stored events, returning HTTP 204 with no body. Only a session linked to that task can be deleted: an absent session, one belonging to another task, or one with no `taskId` (older sessions) returns 404 `session_not_found`, and a missing task returns 404 `task_not_found`. Invalid parameters return 400; storage failures return 502 `session_error`. The task and its other sessions are unchanged. Open event streams for the deleted session are not closed.

### Session stats

`GET /tasks/:taskId/sessions/:sessionId/stats` returns `{ "events": n, "llmCalls": n, "tokens": { "prompt", "candidates", "thoughts", "toolUsePrompt", "cached", "total" } }`, summed from the model usage ADK records on the session's stored events. `llmCalls` counts events that carry usage. `cached` is part of `prompt`; `total` is the model-reported total, which also covers thoughts and tool-use prompt tokens. Streaming partial events are not stored and not counted. Errors match the other session routes (404 `task_not_found` / `session_not_found`, 400, 502 `session_error`). The dashboard shows these totals at the top of an open session and refreshes them as live events arrive.

### Streaming session events

`GET /tasks/:taskId/sessions/:sessionId/messages` is a Server-Sent Events stream (via the dashboard server this is `http://localhost:3001/tasks/:taskId/sessions/:sessionId/messages`). It first replays the stored events in order, then streams events the agent publishes to Pub/Sub until the client disconnects. Each message has `id` = event ID and `data` = the event JSON, a duplicate event ID is sent once, and a comment line is sent every 5 seconds to keep the connection open. Missing tasks and sessions (or a session of another task) return 404 before the stream starts; a Firestore or Pub/Sub failure returns 502 `events_error`.

Live events need `PUBSUB_TOPIC` (and `PUBSUB_EMULATOR_HOST=localhost:4588` locally) in the service environment, matching the agent's topic (`agent-events` by default). The service creates one ephemeral subscription per process on the first stream and shares it between clients; it expires after 24 hours without a consumer. Without `PUBSUB_TOPIC` only the stored events are sent and the connection stays open (it never ends on its own, so `EventSource` does not reconnect in a loop). Events published before the first stream are served from Firestore, so nothing is missed. Browsers can read it with `new EventSource(url)`.

### Platform events

The service publishes lifecycle events to the Pub/Sub topic named by `PLATFORM_EVENTS_TOPIC` (for example `platform-events`; unset means off, and the topic is created on first publish). Types: `task.created`, `task.deleted`, `task.run_requested` (submission only, not completion), `document.added`, `document.removed` (only for an explicit document removal; `task.deleted` implies its sessions and any documents no other task uses are cleaned up, without separate events) and `job.registration_requested`. The message data is JSON `{ eventId, type, occurredAt, ... }` with `taskId`, `jobName`, `agentName`, `sessionId` or `documentId` where relevant. Attributes are `eventId`, `eventType` and `taskId` (when present), so subscribers can filter. An event is published after its operation succeeds; publishing is best effort and runs in the background (a failure is logged, and neither a failure nor a slow Pub/Sub delays or fails the request) and delivery is at-least-once, so de-duplicate on `eventId`. The topic is separate from the agent `PUBSUB_TOPIC`. Locally it needs the same `PUBSUB_EMULATOR_HOST` as the live events.

`GET /events` streams these events as Server-Sent Events (`id` = `eventId`, `data` = the event JSON; a comment line every 5 seconds keeps the connection open). The service creates one ephemeral subscription per process on the first client and shares it between clients. Events published while a client is not connected are not replayed. It returns 501 `{ "error": "not_supported" }` when `PLATFORM_EVENTS_TOPIC` is not set on the service, and 502 `events_error` on a Pub/Sub failure. The dashboard uses it to refresh tasks, sessions, documents and agents without polling; it falls back to polling every 15 seconds while the stream is unavailable.

### Agent registry

A job container can hold several agents; each agent app declares its set in `agents/<name>/src/agents.ts` (`agentSet`: the agents with their input and output schemas, and the default agent that runs when a task names none). The registry records which ones each job image holds, in the Firestore `agents` collection, so the service and dashboard can offer and check a task's `agentName`.

`POST /jobs/:jobName/register` (or `task register-agents`, which calls it for every job in `JOBS`) starts the job in its `register` mode: the Cloud Run execution gets the argument `register` and `JOB_NAME`, and the container writes its agents (name and description) for that job instead of running a task. Registration replaces the job's entries, so agents removed from the image disappear. It returns HTTP 202 `{ "operation": "..." }`, which acknowledges submission only; run it again after every image change, since `update-job` does not. The same mode runs by hand as `bun apps/<name>/src/main.ts register` with `JOB_NAME` set.

`GET /jobs/:jobName/agents` returns `{ "agents": [{ "name": "...", "description": "...", "inputSchema": {...}, "outputSchema": {...} }] }`, empty when the job was never registered. `inputSchema` and `outputSchema` are JSON Schema documents describing the message a task sends to the agent and the agent's final reply; they are declared with each agent in `agents/<name>/src/agents.ts` (as Zod schemas) and stored in the registry as JSON text. The `assistant` agent is free-text, so both its schemas are strings. The `haiku` agent is structured: its input is `{ "topic": string }` and its output is `{ "poem": string }`. A message to a structured agent (the task prompt, or a resume `message`) must be a JSON object matching its input schema; the agent checks this before calling the model and the job exits 1 with an error otherwise. Its output schema is passed to the model, so the final reply is a JSON object, for example `{"poem": "## Autumn Rain  \n\nline one  \nline two  \nline three  "}`; the poem is Markdown, a `##` title heading followed by the three lines. The service does not validate against the schemas. The create-task dialog shows the selected agent's input and output under its dropdown, turns a structured agent's input schema into a form (a text, number, checkbox or dropdown control per property, with required markers and the schema's descriptions, minimums and maximums; nested values become JSON fields) and saves the form values as the JSON prompt. Agents with a text input keep the free-text prompt box. The task Output tab shows a JSON reply field by field. `POST /tasks` with an `agentName` then returns 400 `{ "error": "unknown_agent" }` if the job has registered agents and the name is not one of them; for an unregistered job any valid name is accepted. In the dashboard, clicking a job card (or its Details button) opens a job pane, like the task pane, with Overview (status, image, retries, timeout, CPU and memory, dates, execution count and environment variable names; values are never shown), Agents (each registered agent with its input and output) and Tasks (the tasks that use the job) tabs. Each job card also has a "Register agents" button (the same as `POST /jobs/:jobName/register`) and lists the job's registered agents, refreshing every 3 seconds for 30 seconds after you register; the create-task dialog picks the job and then the agent from dropdowns (the agent list shows the chosen job's registered agents, or just "Default agent" if none are registered).

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

Run `bun run dev:service` (port `3000`) and `bun run dev:web` (port `3001`), then open [the dashboard](http://localhost:3001/web). The root URL `/` on the web server also serves the dashboard. `@stage/web` runs as a standalone Bun server (`apps/web/src/index.ts`, `Dockerfile.web`) that bundles the React/Tailwind frontend via Bun's HTML routes and proxies API requests to `SERVICE_URL` (default `http://localhost:3000`). Browser network requests therefore use port `3001`; the web server forwards them to the API on port `3000`. Both servers must be running.

The dashboard lists tasks and Cloud Run jobs, saves new tasks, submits task executions, and shows session summaries, state, and ordered events. Tasks, jobs, and visible sessions refresh every 15 seconds. An open session also streams new events live from the messages endpoint above (when the service has `PUBSUB_TOPIC`), its form can continue the session with a new message, and a trash button (with an inline confirmation) deletes it. Execution notices indicate submission only; they do not claim agent completion. Search tasks by prompt/job/ID, or use `/` to focus search. New-task creation saves without executing. API documentation remains at `/docs`.

The original `apps/web/src/dash.html` is retained as an unused design reference. The app entrypoint is `apps/web/src/index.html` with `dashboard.tsx`. `bunfig.toml` enables the Tailwind plugin.

### Appearance

Use the Light / Dark / System control in the dashboard top bar. System is the default and follows device appearance changes. Choices are saved in this browser and synchronized across tabs. If browser storage is unavailable, switching still works for the current page. The saved appearance is applied before styles load to avoid a theme flash.

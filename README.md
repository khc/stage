# agent-jobs

Bun workspace monorepo with three packages under `apps/`:

- `@agent-jobs/agent` (`apps/agent`): ADK agent, Firestore session store, and task-contract reader (`src/main.ts` Cloud Run Job entrypoint).
- `@agent-jobs/service` (`apps/service`): Hono HTTP API and OpenAPI/Scalar reference on port `3000`.
- `@agent-jobs/web` (`apps/web`): Standalone React/Tailwind dashboard server on port `3001` (proxies API requests to `SERVICE_URL`, default `http://localhost:3000`).

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

Run `bun fmt` to format the code.

## Local environment

```bash
docker compose up -d --build   # start (builds the service image)
docker compose down            # stop
```

- Configuration lives in `.env` (gitignored; Bun and `docker compose` both read it). Put your `GEMINI_API_KEY` there; the file lists every other variable the project uses. The service and web start/dev scripts explicitly load this root file even when Bun runs them from a workspace directory.
- Model: `AGENT_MODEL` picks it (default `gemini-2.5-flash`, Gemini API). With `GOOGLE_GENAI_USE_VERTEXAI=true` and an API key the agent uses Vertex AI in express mode, e.g. `AGENT_MODEL=publishers/google/models/gemini-2.5-flash`; ADK 2.4.0 cannot do this itself, so `apps/agent/src/model.ts` provides a small `Gemini` subclass. Without a key, the flag selects ADK's own Vertex mode (needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Google Cloud credentials).
- `service` (`Dockerfile.service`, `apps/service`) is the Hono HTTP service on `localhost:3000`: `GET /health`, `GET /jobs`, and the task-contract routes below. `curl localhost:3000/jobs` lists all Cloud Run Jobs in the configured `GCP_PROJECT` and `GCP_REGION`, returning `{ "jobs": [...] }` (or `{ "jobs": [] }`) and collecting all upstream pages automatically. In compose the service uses Floci for Firestore (`FIRESTORE_EMULATOR_HOST=floci-gcp:4588`) and Cloud Run jobs (`CLOUD_RUN_EMULATOR_HOST=floci-gcp:4588`, REST without credentials). Without `CLOUD_RUN_EMULATOR_HOST` it uses the real Cloud Run API and needs Application Default Credentials.
- With the stack up, `task create-job` (needs [go-task](https://taskfile.dev)) creates the agent Cloud Run job in Floci. Override with `task create-job JOB=my-job`; it fails if the job already exists. Creation reads `.env` through Bun and supplies `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST`, `GEMINI_API_KEY` (required), and optional `AGENT_MODEL` / `GOOGLE_GENAI_USE_VERTEXAI`. No prompt or task ID is stored in the job definition. Job containers use `floci-gcp:4588` for Firestore; set `JOB_FIRESTORE_EMULATOR_HOST` to override that container-visible address. `task update-job` updates the existing job image/environment and removes legacy `AGENT_MESSAGE` and static `RUN_ID` / `TASK_ID` entries from the agent container; running executions keep their original settings. These commands print only the resource name to avoid exposing credentials. `task list-jobs` prints jobs as JSON (pipe to `jq`; `{}` when there are none). `task remove-job JOB=my-job` deletes one after confirmation (`--yes` skips it). Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.
- The agent job image is built from `Dockerfile.agent` (`docker build -f Dockerfile.agent -t agent-jobs-agent .`).

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

Returns HTTP 201 `{ "taskId": "<generated UUID>", "prompt": "hello", "jobName": "my-agent-job" }` after saving these fields at Firestore `tasks/{taskId}`. Prompts are trimmed and must contain 1–10,000 characters after trimming. `jobName` is required, at most 63 characters, starts with a lowercase letter, contains lowercase letters/digits/hyphens, and ends in a letter or digit. It cannot be a full resource path or have surrounding spaces. Invalid/missing JSON input returns 400; extra properties are ignored.

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

For rollout, build the new agent image (`docker build -f Dockerfile.agent -t agent-jobs-agent .`) and update the job (`task update-job JOB=my-agent-job`) before using the new task run route. Then rebuild/restart the local service (`docker compose up -d --build service`). Existing job definitions retain their Firestore/model credentials; execution input is supplied only by the new endpoint. For deployed jobs, apply the same agent-before-service sequence through the deployment tooling.

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

### Resuming a session

`POST /tasks/:taskId/run` with `{ "sessionId": "...", "message": "..." }` resumes an existing session of that task and sends `message` as the next user turn, instead of creating a new session from the stored prompt. The service sends `SESSION_ID` and `MESSAGE` as per-execution overrides next to `TASK_ID`. `sessionId` and `message` must be sent together (400 otherwise); an absent session, or one linked to another task, returns 404 `session_not_found`. The agent rechecks that the session belongs to the task. A body without `sessionId` is ignored, as before.

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

Run `bun run dev:service` (port `3000`) and `bun run dev:web` (port `3001`), then open [the dashboard](http://localhost:3001/web). The root URL `/` on the web server also serves the dashboard. `@agent-jobs/web` runs as a standalone Bun server (`apps/web/src/index.ts`, `Dockerfile.web`) that bundles the React/Tailwind frontend via Bun's HTML routes and proxies API requests to `SERVICE_URL` (default `http://localhost:3000`). Browser network requests therefore use port `3001`; the web server forwards them to the API on port `3000`. Both servers must be running.

The dashboard lists tasks and Cloud Run jobs, saves new tasks, submits task executions, and shows session summaries, state, and ordered events. Tasks, jobs, and visible sessions refresh every 15 seconds. Execution notices indicate submission only; they do not claim agent completion. Search tasks by prompt/job/ID, or use `/` to focus search. New-task creation saves without executing. API documentation remains at `/docs`.

The original `apps/web/src/dash.html` is retained as an unused design reference. The app entrypoint is `apps/web/src/index.html` with `dashboard.tsx`. `bunfig.toml` enables the Tailwind plugin.

### Appearance

Use the Light / Dark / System control in the dashboard top bar. System is the default and follows device appearance changes. Choices are saved in this browser and synchronized across tabs. If browser storage is unavailable, switching still works for the current page. The saved appearance is applied before styles load to avoid a theme flash.

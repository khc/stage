# agent-jobs

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
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

- Configuration lives in `.env` (gitignored; Bun and `docker compose` both read it). Put your `GEMINI_API_KEY` there; the file lists every other variable the project uses.
- Model: `AGENT_MODEL` picks it (default `gemini-2.5-flash`, Gemini API). With `GOOGLE_GENAI_USE_VERTEXAI=true` and an API key the agent uses Vertex AI in express mode, e.g. `AGENT_MODEL=publishers/google/models/gemini-2.5-flash`; ADK 2.4.0 cannot do this itself, so `src/agent/model.ts` provides a small `Gemini` subclass. Without a key, the flag selects ADK's own Vertex mode (needs `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and Google Cloud credentials).
- `service` (`Dockerfile.service`) is the Hono HTTP service on `localhost:3000`: `GET /health`, `POST /chat`, `GET /jobs`, and the run-contract routes below. `curl localhost:3000/jobs` lists all Cloud Run Jobs in the configured `GCP_PROJECT` and `GCP_REGION`, returning `{ "jobs": [...] }` (or `{ "jobs": [] }`) and collecting all upstream pages automatically. `POST /chat` accepts `{ "message": "..." }`, trimmed to 1–10,000 characters. In compose the service uses Floci for Firestore (`FIRESTORE_EMULATOR_HOST=floci-gcp:4588`) and Cloud Run jobs (`CLOUD_RUN_EMULATOR_HOST=floci-gcp:4588`, REST without credentials). Without `CLOUD_RUN_EMULATOR_HOST` it uses the real Cloud Run API and needs Application Default Credentials.
- With the stack up, `task create-job` (needs [go-task](https://taskfile.dev)) creates the agent Cloud Run job in Floci. Override with `task create-job JOB=my-job`; it fails if the job already exists. Creation reads `.env` through Bun and supplies `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST`, `GEMINI_API_KEY` (required), and optional `AGENT_MODEL` / `GOOGLE_GENAI_USE_VERTEXAI`. No prompt or run ID is stored in the job definition. Job containers use `floci-gcp:4588` for Firestore; set `JOB_FIRESTORE_EMULATOR_HOST` to override that container-visible address. `task update-job` updates the existing job image/environment and removes legacy `AGENT_MESSAGE` and static `RUN_ID` entries from the agent container; running executions keep their original settings. These commands print only the resource name to avoid exposing credentials. `task list-jobs` prints jobs as JSON (pipe to `jq`; `{}` when there are none). `task remove-job JOB=my-job` deletes one after confirmation (`--yes` skips it). Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.
- The agent job image is built from `Dockerfile.agent` (`docker build -f Dockerfile.agent -t agent-jobs-agent .`).

- [Floci UI](https://hub.docker.com/r/floci/floci-ui) (`floci-ui`) is a web console on `http://localhost:4500` connected to Floci GCP. It only looks at Google Cloud project `floci-local` (region `us-central1`), which is why `floci-local` is this setup's default project: data written under another project does not show up in it. It lists Firestore collections; it does not list Cloud Run jobs (use `task list-jobs`).
- Floci keeps its data (Cloud Run jobs, Firestore documents) across `docker compose stop`, `restart` and `down`: it runs with `FLOCI_GCP_STORAGE_MODE=hybrid` and its data on the named volume `floci-gcp-data`. To wipe it, run `docker compose down -v`. Persistence of other Floci services (Pub/Sub, Storage and so on) was not tested.
- [Floci GCP](https://floci.io/floci-gcp/getting-started/quick-start/) listens on `localhost:4588` and emulates Firestore, among other GCP services.
- Firestore: set `FIRESTORE_EMULATOR_HOST=localhost:4588`.
- The agent saves its ADK session (events and state) to Firestore, so it needs `FIRESTORE_EMULATOR_HOST` (local) or Application Default Credentials with Firestore access (deployed) when it runs.
- To include the Firestore session-service tests (skipped otherwise), run `FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local bun test` with the stack up.
- `floci-gcp` mounts the Docker socket (`/var/run/docker.sock`), which gives the container control of the host's Docker daemon. The port is bound to `127.0.0.1` only.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Run contracts

Create a run with a prompt and the short Cloud Run job name. Creation only saves the contract:

```bash
curl -X POST localhost:3000/jobs/runs -H 'content-type: application/json' \
  -d '{"prompt":"hello","jobName":"my-agent-job"}'
```

Returns HTTP 201 `{ "runId": "<generated UUID>", "prompt": "hello", "jobName": "my-agent-job" }` after saving these fields at Firestore `runs/{runId}`. Prompts are trimmed and must contain 1–10,000 characters after trimming. `jobName` is required, at most 63 characters, starts with a lowercase letter, contains lowercase letters/digits/hyphens, and ends in a letter or digit. It cannot be a full resource path or have surrounding spaces. Invalid/missing JSON input returns 400; extra properties are ignored.

Use the returned UUID to read or execute the run:

```bash
RUN_ID='paste-the-returned-UUID-here'
curl localhost:3000/jobs/runs
curl "localhost:3000/jobs/runs/$RUN_ID"
curl -X POST "localhost:3000/jobs/runs/$RUN_ID/exec"
```

`GET /jobs/runs` returns HTTP 200 `{ "runs": [{ "runId": "<UUID>", "prompt": "hello", "jobName": "my-agent-job" }] }`, or `{ "runs": [] }`. It returns all contracts without pagination or guaranteed ordering. `GET /jobs/runs/:runId` returns the individual contract with HTTP 200. Invalid UUIDs return 400; valid UUIDs are normalized to lowercase. Missing runs return 404 `{ "error": "run_not_found" }`. Firestore failures return 502 `{ "error": "run_error" }`.

`POST /jobs/runs/:runId/exec` requires no body. It reads the stored jobName, starts that job in the service's `GCP_PROJECT` / `GCP_REGION`, and returns HTTP 202 `{ "operation": "<Cloud Run operation name>" }` after submission. A supplied body cannot override jobName or prompt. Only `RUN_ID` is passed as a per-execution environment override. The agent reads `runs/{runId}` from Firestore and runs its stored prompt; it never falls back to `AGENT_MESSAGE`. Invalid UUIDs return 400; absent runs return 404 `run_not_found`; missing or invalid stored jobName returns 409 `{ "error": "run_not_executable" }`; Firestore lookup failures return 502 `run_error`; Cloud Run submission failures return 502 `{ "error": "job_error" }`.

HTTP 202 acknowledges submission, not agent success. Missing/invalid RUN_ID, missing contracts, invalid prompts, Firestore errors, or agent errors cause the job process to exit 1. No execution status or result is written to the run contract. Each job invocation creates a separate session with its own session ID and a top-level `runId` field in the Firestore `sessions` document, linking it to the contract. The link is retained when sessions are loaded or listed. `/chat` sessions and older sessions can omit `runId`. Repeated exec requests can start multiple executions and sessions.

The former `POST /jobs/:name/run` URL is removed. Existing prompt-only contracts remain readable but cannot be submitted through exec; recreate them with a jobName. There is no automatic backfill. Both the service and agent use the existing Firestore configuration (`GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST` locally, or Application Default Credentials when deployed), and must point to the same project/database.

For rollout, build the new agent image (`docker build -f Dockerfile.agent -t agent-jobs-agent .`) and update the job (`task update-job JOB=my-agent-job`) before using the new execution route. Then rebuild/restart the local service (`docker compose up -d --build service`). Existing job definitions retain their Firestore/model credentials; execution input is supplied only by the new endpoint. For deployed jobs, apply the same agent-before-service sequence through the deployment tooling.

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
- `service` (`Dockerfile.service`) is the Hono HTTP service on `localhost:3000`: `GET /health`, `POST /chat`, `GET /jobs`, `POST /jobs/:name/run`. List all Cloud Run Jobs in the configured `GCP_PROJECT` and `GCP_REGION` with `curl localhost:3000/jobs`: the response is `{ "jobs": [...] }` (or `{ "jobs": [] }` when none exist), collecting all upstream pages automatically. The job endpoint takes an optional JSON body `{"message": "..."}` that overrides the job's `AGENT_MESSAGE` for that run only (1 to 10,000 characters after trimming; the same limit applies to `POST /chat`): `curl -X POST localhost:3000/jobs/my-agent-job/run -H 'content-type: application/json' -d '{"message":"hello"}'`. In compose it uses Floci for Firestore (`FIRESTORE_EMULATOR_HOST=floci-gcp:4588`) and for Cloud Run jobs (`CLOUD_RUN_EMULATOR_HOST=floci-gcp:4588`, REST without credentials). Without `CLOUD_RUN_EMULATOR_HOST` the service uses the real Cloud Run API and needs Application Default Credentials.
- With the stack up, `task create-job` (needs [go-task](https://taskfile.dev)) creates the agent's Cloud Run job in Floci. Override with e.g. `task create-job JOB=my-job AGENT_MESSAGE="hi"`; it fails if the job already exists. Job creation reads `.env` through Bun and supplies `AGENT_MESSAGE`, `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_EMULATOR_HOST`, `GEMINI_API_KEY` (required), and optional `AGENT_MODEL` / `GOOGLE_GENAI_USE_VERTEXAI`. Job containers use `floci-gcp:4588` for Firestore; set `JOB_FIRESTORE_EMULATOR_HOST` to override that container-visible address. Run `task update-job` to apply the image and environment to an existing job before its next execution; running executions keep their original settings. These commands print only the resource name to avoid exposing credentials. `task list-jobs` prints the jobs as JSON (pipe to `jq`; `{}` when there are none). `task remove-job JOB=my-job` deletes one after a confirmation prompt (`--yes` skips it). Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.
- The agent job image is built from `Dockerfile.agent` (`docker build -f Dockerfile.agent -t agent-jobs-agent .`).

- [Floci UI](https://hub.docker.com/r/floci/floci-ui) (`floci-ui`) is a web console on `http://localhost:4500` connected to Floci GCP. It only looks at Google Cloud project `floci-local` (region `us-central1`), which is why `floci-local` is this setup's default project: data written under another project does not show up in it. It lists Firestore collections; it does not list Cloud Run jobs (use `task list-jobs`).
- Floci keeps its data (Cloud Run jobs, Firestore documents) across `docker compose stop`, `restart` and `down`: it runs with `FLOCI_GCP_STORAGE_MODE=hybrid` and its data on the named volume `floci-gcp-data`. To wipe it, run `docker compose down -v`. Persistence of other Floci services (Pub/Sub, Storage and so on) was not tested.
- [Floci GCP](https://floci.io/floci-gcp/getting-started/quick-start/) listens on `localhost:4588` and emulates Firestore, among other GCP services.
- Firestore: set `FIRESTORE_EMULATOR_HOST=localhost:4588`.
- The agent saves its ADK session (events and state) to Firestore, so it needs `FIRESTORE_EMULATOR_HOST` (local) or Application Default Credentials with Firestore access (deployed) when it runs.
- To include the Firestore session-service tests (skipped otherwise), run `FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local bun test` with the stack up.
- `floci-gcp` mounts the Docker socket (`/var/run/docker.sock`), which gives the container control of the host's Docker daemon. The port is bound to `127.0.0.1` only.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

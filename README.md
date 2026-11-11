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
- `service` (`Dockerfile.service`) is the Hono HTTP service on `localhost:3000`: `GET /health`, `POST /chat`, `POST /jobs/:name/run`. The job endpoint takes an optional JSON body `{"message": "..."}` that overrides the job's `AGENT_MESSAGE` for that run only (1 to 10,000 characters after trimming; the same limit applies to `POST /chat`): `curl -X POST localhost:3000/jobs/my-agent-job/run -H 'content-type: application/json' -d '{"message":"hello"}'`. In compose it uses Floci for Firestore (`FIRESTORE_EMULATOR_HOST=floci-gcp:4588`) and for Cloud Run jobs (`CLOUD_RUN_EMULATOR_HOST=floci-gcp:4588`, REST without credentials). Without `CLOUD_RUN_EMULATOR_HOST` the service uses the real Cloud Run API and needs Application Default Credentials.
- With the stack up, `task create-job` (needs [go-task](https://taskfile.dev)) creates the agent's Cloud Run job in Floci. Override with e.g. `task create-job JOB=my-job AGENT_MESSAGE="hi"`; it fails if the job already exists. `task list-jobs` prints the jobs as JSON (pipe to `jq`; `{}` when there are none). `task remove-job JOB=my-job` deletes one after a confirmation prompt (`--yes` skips it). Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.
- The agent job image is built from `Dockerfile.agent` (`docker build -f Dockerfile.agent -t agent-jobs-agent .`).

- [Floci GCP](https://floci.io/floci-gcp/getting-started/quick-start/) listens on `localhost:4588` and emulates Firestore, among other GCP services.
- Firestore: set `FIRESTORE_EMULATOR_HOST=localhost:4588`.
- The agent saves its ADK session (events and state) to Firestore, so it needs `FIRESTORE_EMULATOR_HOST` (local) or Application Default Credentials with Firestore access (deployed) when it runs.
- To include the Firestore session-service tests (skipped otherwise), run `FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=demo bun test` with the stack up.
- `floci-gcp` mounts the Docker socket (`/var/run/docker.sock`), which gives the container control of the host's Docker daemon. The port is bound to `127.0.0.1` only.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

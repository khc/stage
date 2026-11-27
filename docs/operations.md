# Operations

Build, deploy, migrate and troubleshoot the local stack. For GCP environments, see the [infrastructure README](../infra/README.md).

## Build and deploy

All infrastructure goes through Terraform. Do not create or change resources with direct Floci or `gcloud` calls: they leave resources outside the state and cause `409 alreadyExists` on the next apply. Direct calls are fine for reading (`task list-jobs`) and for removing a resource from the emulator; run `task tf:apply` afterwards.

| Task                                                                        | What it does                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `task build`                                                                | Builds every image: agents, extract service, control service, dashboard                                                              |
| `task build:agents`                                                         | One image per agent app in `JOBS` (`stage/<name>-agents:latest`). `JOBS=poet` narrows it                                             |
| `task build:extract-service`, `task build:control-service`, `task build:ui` | One service image each                                                                                                               |
| `task tf:init`                                                              | Initialise Terraform in `infra/envs/local`. Once, and after provider or module changes                                               |
| `task tf:apply`                                                             | Create what is missing and update job images and environment. Aliases: `tf:create-job`, `tf:update-job`. `JOBS` does not narrow it   |
| `task deploy -- -auto-approve`                                              | Replace services whose local image changed, and register agents. `FORCE=true` replaces all                                           |
| `task tf:import`                                                            | Adopt resources created before Terraform                                                                                             |
| `task tf:create-extract`, `tf:create-service`                               | Create or update the extract or control service in Floci and print its URL                                                           |
| `task tf:remove-extract`, `tf:remove-service`                               | Delete one of them                                                                                                                   |
| `task register-agents`                                                      | Record each agent app's agents in Firestore                                                                                          |
| `task list-jobs`                                                            | Print the Floci jobs as JSON (pipe to `jq`)                                                                                          |
| `task remove-job JOB=<name>`                                                | Delete a job after confirmation. It bypasses Terraform, so the next apply recreates it                                               |
| `task clean`                                                                | Delete every task and session (with their documents and events) from Floci's Firestore, after confirmation. `--yes` skips the prompt |
| `task load-imdb`                                                            | Download the IMDb datasets and load them into Floci's Postgres                                                                       |

`task tf:apply` needs [go-task](https://taskfile.dev), Terraform and [yq](https://github.com/mikefarah/yq). Run `task --list` for the full set. Floci supports the Cloud Run v2 REST API only, not `gcloud run jobs`.

### What Terraform creates locally

- one Cloud Run job per agent app, `stage--<name>-agents--job-lcl`
- the services `stage--extract-service--svc-lcl` and `stage--control-service--svc-lcl`, and a quick service per agent app (`stage--<name>-agents--svc-lcl`)
- the topics `stage--agent-events--ps-lcl` and `stage--platform-events--ps-lcl`
- the `stage--imdb--db-lcl` Cloud SQL instance

Jobs set `max_retries = 0`. A run is not safe to repeat: each attempt of a failed first run would create another session, and a retried resume would append its message again. A new agent image or resource must also be added in `infra/` ([naming rules](naming-rules.md) apply).

### Rollout order

When a change touches both the agent and the service, build and update the agents first, then restart the service:

1. `task build:agents`
2. `task tf:apply`
3. Restart `bun run dev:service`

For deployed jobs, apply the same agent-before-service order through your deployment tooling. An agent image from before the queued-message change fails a resume with `MESSAGE is required to resume a session`. Rebuild the agent images, update the jobs and restart the service together.

## Floci

- **Ports:** Floci listens on `localhost:4588`, bound to `127.0.0.1` only. The [Floci UI](https://hub.docker.com/r/floci/floci-ui) is at <http://localhost:4500>. It shows the project `floci-local` (region `us-central1`) only, so data written under another project does not appear. It lists Firestore collections but not Cloud Run jobs; use `task list-jobs`.
- **Persistence:** Floci runs with `FLOCI_GCP_STORAGE_MODE=hybrid` and keeps its data (Cloud Run jobs, Firestore documents) on the volume `stage--floci-gcp--vol-lcl` across `docker compose stop`, `restart` and `down`. `docker compose down -v` wipes it. Persistence of other Floci services (Pub/Sub, Storage and so on) was not tested.
- **Docker socket:** Floci mounts `/var/run/docker.sock`, which gives the container control of the host's Docker daemon. Treat it as trusted.
- **Limits:** see [Floci notes](floci-gcp.md). The main one: Cloud Run jobs cannot read Secret Manager, so keys are plain environment values locally.
- **Integration tests:** with Floci up (`docker compose up -d --wait floci-gcp`), run `FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local bun run test:integration`. These are the `*.integration.test.ts` files. Without the variables they skip.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, pull requests and manual runs:

| Job                     | What it runs                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| lint, format, typecheck | `bun run lint --deny-warnings`, `bun run format:check`, `bun run typecheck`                                                                  |
| ui build                | `bun run --filter @stage/ui build`, after the three checks                                                                                   |
| unit tests              | `bun run test`, no services                                                                                                                  |
| integration tests       | Starts Floci with `docker compose up -d --wait floci-gcp`, then `bun run test:integration`                                                   |
| images                  | Only on a version tag, after every job above passes: builds the seven images for `linux/amd64` and `linux/arm64` and pushes them (see below) |

Actions are pinned to commit SHAs and updated by Dependabot (`.github/dependabot.yml`). The Bun version is in `.bun-version`.

### Publish the images

Pull requests and pushes to `main` build no images. To release, tag a commit that is on `main` and push the tag:

```bash
git tag v1.2.3
git push origin v1.2.3
```

CI runs every check on the tag, then `.github/workflows/ci-image.yml` builds and pushes one image per entry of the `images` matrix in `ci.yml`, tagged `1.2.3` (not `latest`):

| Image                                                                                        | Dockerfile                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ghcr.io/khc/stage/generic-agents`, `poet-agents`, `knowledge-agents`, `orchestrator-agents` | `docker/Dockerfile.agents`, with `APP=generic`, `poet`, `knowledge` or `orchestrator` |
| `ghcr.io/khc/stage/control-service`                                                          | `docker/Dockerfile.control-service`                                                   |
| `ghcr.io/khc/stage/extract-service`                                                          | `docker/Dockerfile.extract-service`                                                   |
| `ghcr.io/khc/stage/ui`                                                                       | `docker/Dockerfile.ui`                                                                |

- A tag that is not on `main` fails with `<tag> is not on main`. This only catches mistakes; to restrict who may release, add a repository tag ruleset for `v*`.
- The arm64 layers build under QEMU, so a release takes tens of minutes. Each image has a 45-minute limit.
- The packages are private until you change their visibility in the package settings on GitHub.
- To add an image, add a `build:*` task (see [docker/Taskfile.yml](../docker/Taskfile.yml)) and an entry in the `images` matrix.

## Migrations

### Runs to tasks

Older data used `runs/{runId}`. The script copies each run to `tasks/{taskId}` with the same UUID, replaces `runId` with `taskId`, and adds `taskId` to the sessions linked through `runId` (keeping the old field). Existing `runs` documents are kept; the API reads and writes only `tasks`.

1. Stop task creation, run requests and active job attempts, so the source data stays stable.
2. Point the commands at the same Firestore project as the service and the agent. Preview first, then apply:

   ```bash
   FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local \
     bun scripts/migrate-runs-to-tasks.ts

   FIRESTORE_EMULATOR_HOST=localhost:4588 GOOGLE_CLOUD_PROJECT=floci-local \
     bun scripts/migrate-runs-to-tasks.ts --apply
   ```

   For a deployed database, set `GOOGLE_CLOUD_PROJECT` and use Application Default Credentials instead of the emulator host.

3. Deploy both new images together. The service sends only `TASK_ID`, the agent loads `tasks/{taskId}`, and new sessions store `taskId`. Run `task tf:update-job` to remove the old static `AGENT_MESSAGE`, `RUN_ID` and `TASK_ID` values before you resume requests.

The script can be rerun: matching tasks and links are skipped. Conflicting task contents, conflicting session links or invalid legacy ids stop the migration without overwriting anything, and an apply can make partial progress before a later error, so resolve the conflict and rerun. Each session update checks its read version to detect concurrent changes. The summary has counts only, with no prompts or credentials. It does not run at service startup.

After the migration, the old `/jobs/runs` routes and `POST /jobs/:name/run` no longer exist. Prompt-only tasks stay readable but cannot run without a `jobName`: recreate them with one. The agent no longer accepts `RUN_ID` as input.

### Other scripts

The `scripts/` folder also has `migrate-legacy-task-names.ts` and `remove-orphaned-sessions.ts`. Read the header of each before running it.

## Troubleshooting

| Symptom                                                                      | Cause and fix                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `409 alreadyExists` from `task tf:apply`                                     | A resource exists outside Terraform. `task tf:import` adopts it                                                                                                                                                       |
| A quick run fails with `HTTP 503` (`Cloud Run service has no ready runtime`) | The service's container exited (for example after Docker restarted) and Floci still lists it as ready. `task deploy` replaces a service only when its image changed, so run `task deploy FORCE=true -- -auto-approve` |
| A job is missing after `task remove-job`                                     | It bypasses Terraform. Run `task tf:apply`                                                                                                                                                                            |
| `GET /jobs` is empty                                                         | Run `task tf:apply`, and check `GCP_PROJECT`, `GCP_REGION` and `CLOUD_RUN_EMULATOR_HOST`                                                                                                                              |
| Agents are missing in the dashboard                                          | `task register-agents` (also after you change an agent)                                                                                                                                                               |
| Live events do not arrive                                                    | `PUBSUB_TOPIC` and `PUBSUB_EMULATOR_HOST` must match between the service and the jobs. Rebuild the agent image and run `task tf:apply` after upgrading                                                                |
| An orchestrator run cannot reach the service                                 | Set `HOST=0.0.0.0` for the host service, and check `gateway_url` in `infra/envs/local`                                                                                                                                |
| A resume answers `409 run_in_progress`                                       | The session is still running, or its lease has not expired (10 minutes after a lost run)                                                                                                                              |

## Security notes

The local stack trusts everything on your machine.

- The control service has no authentication, and `HOST=0.0.0.0` exposes job execution to the network. Do not deploy it publicly.
- Local Terraform state holds `GEMINI_API_KEY` and `EXA_API_KEY` in plain text. Use throwaway keys, and never put secrets in `infra/envs/local/terraform.tfvars`, which is committed.
- The dashboard image proxies the whole API without authentication or TLS.
- The review in [plans/review.md](plans/review.md) lists the security findings for an earlier version of the service. Check it before you expose anything.

## See also

- [Getting Started](getting-started.md)
- [Infrastructure README](../infra/README.md)
- [Naming rules](naming-rules.md)

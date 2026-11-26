# Resource Naming Rules

Naming convention and character/length constraints for GCP, Docker, and internal identifiers in `stage`.

## Core Rules

1. **Default format everywhere possible:** lowercase kebab-case (`a-z`, `0-9`, `-`), starting with `a-z` and ending with `a-z0-9`.
2. **Never use `_` (or `__`) in GCP or Docker resource names** unless a resource explicitly forbids `-` (GCP Custom IAM Roles) or lives inside SQL/ADK. Cloud Run, VPCs, Service Accounts, Cloud SQL, Firestore IDs, and Artifact Registry repositories all reject `_`.
3. **Structural separator (`--`):** use double hyphens to separate project prefix, resource name, and type/environment (`stage--{name}--{type}-{env}`), and single hyphens (`-`) within each segment.
4. **Environments (`{env}`):** uniform 3-letter codes — `lcl` (local), `dev`, `uat`, `stg`, `prd`.

---

## Cloud Run (`stage--{name}--{type}-{env}`)

Cloud Run services and jobs share one pattern so the workload, runtime type, and environment are unambiguous in consoles, URLs, logs, and IAM conditions:

```text
stage--{name}--{type}-{env}
```

- **Allowed `{type}` values:** `svc` for Cloud Run Services (`service`), and `job` for Cloud Run Jobs (`job`).

| Workload            | `{name}`              | `{type}` | Example (`lcl`)                       | Length |
| ------------------- | --------------------- | -------- | ------------------------------------- | ------ |
| Agent quick service | `orchestrator-agents` | `svc`    | `stage--orchestrator-agents--svc-lcl` | 35     |
| Agent batch job     | `orchestrator-agents` | `job`    | `stage--orchestrator-agents--job-lcl` | 35     |
| Control API         | `control-service`     | `svc`    | `stage--control-service--svc-lcl`     | 31     |
| Extract API         | `extract-service`     | `svc`    | `stage--extract-service--svc-lcl`     | 31     |

### Length budgets to watch

- **Cloud Run v2 Services — 49 chars max:** GCP appends a hash/region suffix to form a ≤63-char DNS label. Fixed framing `stage--` (7) + `--svc-{env}` (9) = **16 chars**, leaving **33 chars** for `{name}` (e.g. `orchestrator-agents` is 19 chars → 14 chars headroom; `control-service` is 15 chars → 18 chars headroom).
- **Cloud Run v2 Jobs — 63 chars max:** also validated by `JOB_NAME_PATTERN` (`^[a-z]([-a-z0-9]*[a-z0-9])?$`, max 63) in [agents-model.ts](../apps/control-service/src/modules/agents/agents-model.ts#L4-L7) and [remote-agents.ts](../agents/orchestrator/src/remote-agents.ts#L17-L21).
- **Gemini tool names — 64 chars max:** [remote-agents.ts](../agents/orchestrator/src/remote-agents.ts) exposes each remote agent to the orchestrator as `<jobName>__<agentName>`. Keep `<agentName>` short enough that `<jobName>__<agentName>` stays ≤64 chars (e.g. `stage--knowledge-agents--job-lcl__discovery-assistant` is 53 chars).

---

## Docker & Container Registry (`stage/{name}:{version}`)

```text
{image_prefix}stage/{name}:{version}
{image_prefix}stage/{name}@sha256:{digest}
```

- `{name}` matches the `{name}` segment of `stage--{name}--{type}-{env}` (`orchestrator-agents`, `control-service`, `extract-service`, `ui`).
- `{image_prefix}` is empty locally (`lcl`) and `<region>-docker.pkg.dev/<project>/<repo>/` on GCP. The images CI publishes from a version tag use `ghcr.io/khc/` (for example `ghcr.io/khc/stage/control-service:1.2.3`). Name `<repo>` without `stage` (e.g. `stage--containers--ar-{env}` or `containers`) so paths do not double into `.../stage/stage/{name}`.

| Target                          | Pattern / Example                                                                         | Allowed Characters                                                                                | `_` Allowed? | Notes                                                                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| **Image name**                  | `stage/orchestrator-agents`, `stage/control-service`, `stage/extract-service`, `stage/ui` | `a-z`, `0-9`, `.`, `_`, `__`, `-`, `/` (max 255; segments cannot start/end with `.`, `_`, or `-`) | Yes          | Uppercase is forbidden; `..` and `//` are invalid. Keep segments to `a-z`, `0-9`, `-`. |
| **Image tag (`{version}`)**     | `latest` (`lcl`), `0.1.0`, `v0.1.0`, `sha-abc1234`                                        | `a-z`, `A-Z`, `0-9`, `_`, `.`, `-` (max 128; cannot start with `.` or `-`; `+` forbidden)         | Yes          | Digests omit `:tag` and use `@sha256:{digest}` via `local.image_sep` in Terraform.     |
| **Artifact Registry repo**      | `stage--containers--ar-{env}` (or `containers`)                                           | `a-z`, `0-9`, `-` (1–63; starts `a-z`, ends `a-z0-9`)                                             | **No**       | Repository name cannot contain `_`.                                                    |
| **Container / Compose service** | `floci-gcp`, `floci-ui`, `mlflow`, `qdrant`, `neo4j`                                      | `a-z`, `A-Z`, `0-9`, `_`, `.`, `-`                                                                | Yes          | Stick to `a-z`, `0-9`, `-` so Docker internal DNS hostnames remain RFC-1123 valid.     |
| **Compose named volume**        | `stage--{service}--vol-lcl` (`stage--neo4j--vol-lcl`, `stage--floci-gcp--vol-lcl`)        | `a-z`, `A-Z`, `0-9`, `_`, `.`, `-`                                                                | Yes          | Set explicit `name:` in `docker-compose.yml` so Compose does not prepend `stage_`.     |

---

## GCP Resource Reference (`infra/`)

| GCP Resource                       | Allowed Characters                                                                 | `_` Allowed?            | Length    | Pattern (`stage--{name}--{type}-{env}` where allowed)                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------- | ----------------------- | --------- | --------------------------------------------------------------------------------------- |
| **Cloud Run Service**              | `a-z`, `0-9`, `-` (starts `a-z`, ends `a-z0-9`)                                    | **No**                  | **1–49**  | `stage--{name}--svc-{env}`                                                              |
| **Cloud Run Job**                  | `a-z`, `0-9`, `-` (starts `a-z`, ends `a-z0-9`)                                    | **No**                  | **1–63**  | `stage--{name}--job-{env}`                                                              |
| **Service Account (`account_id`)** | `a-z`, `0-9`, `-` (starts `a-z`, ends `a-z0-9`)                                    | **No**                  | **6–30**  | `stage--{role}--sa-{env}` (`{role}` ≤ 15 chars, e.g. `stage--scheduler--sa-dev`)        |
| **VPC Network & Subnet**           | `a-z`, `0-9`, `-` (starts `a-z`, ends `a-z0-9`)                                    | **No**                  | **1–63**  | `stage--{name}--vpc-{env}`, `stage--{name}--subnet-{env}`                               |
| **Cloud SQL Instance**             | `a-z`, `0-9`, `-` (starts `a-z`)                                                   | **No**                  | **1–98**  | `stage--{db}--db-{env}` (e.g. `stage--imdb--db-lcl`)                                    |
| **Firestore Database ID**          | `(default)` or `a-z`, `0-9`, `-` (cannot start with `goog` or be a UUID)           | **No**                  | **4–63**  | `(default)`                                                                             |
| **GCS Bucket**                     | `a-z`, `0-9`, `-`, `_`, `.` (globally unique)                                      | Discouraged             | **3–63**  | `{project}--{purpose}--gcs-{env}` (e.g. `{project}--tfstate--gcs-prd`; avoid `_` / `.`) |
| **Pub/Sub Topic / Subscription**   | `a-z`, `A-Z`, `0-9`, `-`, `_`, `.`, `~`, `+`, `%` (starts with letter, not `goog`) | Yes                     | **3–255** | `stage--{topic}--ps-{env}` (ephemeral subs: `stage-service-*`)                          |
| **Cloud Scheduler Job**            | `a-z`, `A-Z`, `0-9`, `-`, `_`                                                      | Yes                     | **1–500** | `task-{id}` (IAM-scoped)                                                                |
| **Secret Manager Secret ID**       | `a-z`, `A-Z`, `0-9`, `-`, `_`                                                      | Yes                     | **1–255** | `stage--{secret}--sec-{env}`                                                            |
| **Custom IAM Role (`role_id`)**    | `a-z`, `A-Z`, `0-9`, `_`, `.`                                                      | **Yes (`-` forbidden)** | **3–64**  | `stage{Env}{RoleName}` (e.g. `stageDevPubsubTopic`)                                     |
| **GCP Labels (key / value)**       | `a-z`, `0-9`, `-`, `_` (keys start `a-z`)                                          | Yes                     | **1–63**  | Keys `1–63` (`a-z` start); values `0–63` (lowercase kebab-case or snake_case)           |

> **Service Account length cap (30 chars):** `stage--` (7) + `--sa-{env}` (8) = 15 fixed chars, so `{role}` must be ≤ 15 chars (`agents`, `control`, `extract`, `scheduler` all fit: e.g. `stage--scheduler--sa-dev` is 24 chars).
>
> **Why Custom IAM Roles use PascalCase:** GCP forbids `-` in `role_id`, so [gcp-foundation/main.tf](../infra/modules/gcp-foundation/main.tf#L3) uses `stage${title(var.environment)}` (`stageDevPubsubTopic`).
>
> **IAM-coupled prefixes (`stage-service-*`, `task-*`):** Ephemeral Pub/Sub subscriptions (`stage-service-*`) are hardcoded in [session-event-stream.ts](../apps/control-service/src/platform/session-event-stream.ts#L23) and [platform-event-stream.ts](../apps/control-service/src/platform/platform-event-stream.ts#L16) to match the IAM condition in [gcp-app/main.tf](../infra/modules/gcp-app/main.tf#L83), and Cloud Scheduler jobs (`task-*`) match [gcp-app/main.tf](../infra/modules/gcp-app/main.tf#L96). Keep these prefixes aligned with those IAM conditions.

---

## Non-GCP Identifiers

Identifiers inside Postgres or application code are not subject to GCP hostname rules:

- **PostgreSQL users, tables, columns:** `snake_case` (e.g. `imdb_reader`).
- **Firestore & Qdrant collections:** lowercase plural nouns (`tasks`, `sessions`, `events`, `documents`, `providers`, `agents`, Qdrant `docs`).
- **OpenTelemetry `service.name`:** match the Cloud Run resource name (`stage--{name}--{type}-{env}`) via `OTEL_SERVICE_NAME` / `JOB_NAME` (current local fallbacks are `stage-service`, `stage-extract`, `stage-agents`).
- **ADK `FunctionTool` names:** `snake_case` (e.g. `get_current_time`).
- **ADK `agentName`:** lowercase kebab-case `^[a-z]([a-z0-9-]*[a-z0-9])?$`, max 64 chars (e.g. `discovery-assistant`, `haiku-poet`, `document-analyser`). Keeps `-` distinct from the `__` separator in `<jobName>__<agentName>` and matches `/a2a/:jobName/:agentName` URLs.

---

## Migration Status

- **Completed:** `document_analyser` → `document-analyser` (and kebab-case `agentName` validation in [spec.ts](../packages/agents/src/spec.ts#L9-L12) and [agents-model.ts](../apps/control-service/src/modules/agents/agents-model.ts#L10)), Docker image names (`stage/{name}:{version}` in [docker/Taskfile.yml](../docker/Taskfile.yml)), Compose volumes (`stage--{service}--vol-lcl` in [docker-compose.yml](../docker-compose.yml)), Terraform modules and envs (`stage--{name}--{type}-{env}` across [infra/](../infra/README.md)), [Taskfile.yml](../Taskfile.yml), and [infra/Taskfile.yml](../infra/Taskfile.yml).
- **Remaining / cleanup notes:**
  - `stage_*` legacy Docker images and Compose volumes on the host can be removed once you are satisfied with the migrated data (`docker volume rm stage_floci-gcp-data stage_mlflow-data stage_qdrant-data stage_neo4j-data`).
  - Existing Firestore `tasks` created under legacy `jobName` values (`generic-agents`, etc.) or `agentName: "document_analyser"` will need updating or recreating before re-running.
  - [README.md](../README.md) and historical design docs ([review.md](plans/review.md), [platform-evolution.md](plans/platform-evolution.md)) still mention the legacy names in prose.

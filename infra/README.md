# Infra

```
modules/stage/           Cloud Run jobs, extract service, the Elysia service (service, off by default) and Pub/Sub topics (shared)
modules/gcp-foundation/  GCP project APIs, VPC/subnet with Private Google Access, Firestore, Secret Manager, service accounts, custom roles
modules/gcp-app/         GCP workload layer wiring modules/stage with Direct VPC egress and resource-scoped IAM
envs/local/              Floci (local GCP emulator): provider endpoints, plain env values
envs/gcp/dev/            GCP dev environment split into foundation/ and app/ roots (remote GCS backend)
envs/gcp/prod/           GCP prod environment split into foundation/ and app/ roots (remote GCS backend)
```

Each environment and lifecycle layer is its own Terraform root with its own state, so foundation/stateful resources (`foundation/`) are isolated from routine application deploys (`app/`), and `local`, `dev`, and `prod` never share state or collide on resource names. Tasks `tf:apply`, `tf:create-job`, `tf:update-job`, `tf:create-extract` and `tf:remove-extract` run Terraform in `envs/local`; they do not narrow by `JOBS`. See [docs/naming-rules.md](../docs/naming-rules.md) for GCP and Docker resource naming conventions.

## Floci

    docker compose up -d floci-gcp
    # task tf:apply reads GEMINI_API_KEY, AGENT_MODEL and GOOGLE_GENAI_USE_VERTEXAI from .env (yq);
    # by hand: export TF_VAR_gemini_api_key=... (and optionally TF_VAR_agent_model, TF_VAR_use_vertexai)
    # it is a plain env value in local state: use a throwaway key
    task tf:init && task tf:apply   # or: cd envs/local && terraform init && terraform apply

If the topics or jobs already exist in Floci (created by the old scripts), `task tf:import` adopts them into the state first; `apply` fails with 409 otherwise.

The `stage--imdb--db-lcl` Cloud SQL instance (PostgreSQL 17, `envs/local/imdb.tf`) is a Postgres container that Floci runs; it has no host port, and other containers on the compose network reach it as `floci-gcp-cloudsql-floci-local-stage--imdb--db-lcl:5432`. `task tf:apply` creates the instance and two users, `imdb` (loads the data) and `imdb_reader` (read-only, used by the knowledge agent). Terraform does not create the database: `bun scripts/imdb-load.ts` creates it (owned by `imdb`) and applies `data/schemas/*.sql`, including the grants of `imdb_reader` (`--no-data` runs only those database steps). `imdb_db_password` and `imdb_reader_password` are throwaway local defaults.

Floci's Cloud Run emulation rejects secret references (`valueSource`), so the jobs get the key as a plain env value; see [docs/floci-gcp.md](../docs/floci-gcp.md).

`envs/local/terraform.tfvars` is committed and must never hold secrets.

## GCP (`dev` / `prod`)

Each GCP environment has two roots under `envs/gcp/<env>/`:

1. **`foundation/`** — enables GCP APIs, creates the VPC and Private Google Access subnet for Cloud Run Direct VPC egress, creates Firestore (`prevent_destroy = true`), creates `stage--gemini-api-key--sec-<env>` in Secret Manager (no secret value in Terraform state), and provisions all service accounts and permanent custom IAM roles.
2. **`app/`** — reads `foundation` outputs via `terraform_remote_state`, deploys `modules/stage` (with Direct VPC egress `ALL_TRAFFIC` on `service` so it can call internal-only `extract`), and binds topic/job/service-scoped IAM.

Bootstrap an environment (`env=dev` or `env=prd`) without `-target`:

    # 1. Foundation layer
    cd envs/gcp/dev/foundation
    cp backend.hcl.example backend.hcl         # set GCS state bucket & prefix
    cp terraform.tfvars.example terraform.tfvars
    terraform init -backend-config=backend.hcl
    terraform apply

    # 2. Populate Secret Manager once (out of Terraform state)
    printf %s "$GEMINI_API_KEY" | gcloud secrets versions add stage--gemini-api-key--sec-dev --data-file=-

    # 3. Application layer
    cd ../app
    cp backend.hcl.example backend.hcl         # set GCS state bucket & prefix
    cp terraform.tfvars.example terraform.tfvars
    terraform init -backend-config=backend.hcl
    terraform apply

State files are gitignored, and GCP roots use `backend "gcs" {}` with restricted bucket IAM. Both `extract` and `service` reject `allUsers`/`allAuthenticatedUsers` in Terraform validation; `extract` defaults to `INGRESS_TRAFFIC_INTERNAL_ONLY` and is reached by `service` over Direct VPC egress.

Only `terraform fmt` / `terraform validate` have run against the GCP modules: nothing has been planned or applied to a live GCP project yet, and the Pub/Sub, Scheduler, and IAM condition expressions have not been verified against a project.

Floci's Firestore needs no resource (documents only). Images are built by `task build:agents`, `task build:extract-service` and `task build:control-service`.

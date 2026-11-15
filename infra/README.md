# Infra

```
modules/stage/   Cloud Run jobs, extract service, the Elysia service (service, off by default) and Pub/Sub topics (shared)
envs/local/      Floci (local GCP emulator): provider endpoints, plain env values
envs/gcp/        Real GCP: APIs, Firestore, service accounts, IAM, Secret Manager
```

Each env is its own Terraform root with its own state, so one can never be applied with the other's variables. The Cloud Run jobs, `extract` service and topics are the same module in both. Tasks `tf:apply`, `tf:create-job`, `tf:update-job`, `tf:create-extract` and `tf:remove-extract` run Terraform in `envs/local`; they do not narrow by `JOBS`.

## Floci

    docker compose up -d floci-gcp
    # task tf:apply reads GEMINI_API_KEY, AGENT_MODEL and GOOGLE_GENAI_USE_VERTEXAI from .env (yq);
    # by hand: export TF_VAR_gemini_api_key=... (and optionally TF_VAR_agent_model, TF_VAR_use_vertexai)
    # it is a plain env value in local state: use a throwaway key
    task tf:init && task tf:apply   # or: cd envs/local && terraform init && terraform apply

If the topics or jobs already exist in Floci (created by the old scripts), `task tf:import` adopts them into the state first; `apply` fails with 409 otherwise.

Floci's Cloud Run emulation rejects secret references (`valueSource`), so the jobs get the key as a plain env value; see [docs/floci-gcp.md](../docs/floci-gcp.md).

`envs/local/terraform.tfvars` is committed and must never hold secrets.

## GCP

    cd envs/gcp
    cp terraform.tfvars.example terraform.tfvars   # then edit
    terraform init
    # 1. create the secret (and the APIs it needs) first: jobs cannot start without a version
    terraform apply -target=google_secret_manager_secret.gemini
    # 2. give it a value
    printf %s "$GEMINI_API_KEY" | gcloud secrets versions add gemini-api-key --data-file=-
    # 3. everything else
    terraform apply

The GCP apply also enables the APIs, creates the Firestore database, dedicated service accounts (Pub/Sub publisher on the agent-events topic, Firestore user) and the `gemini-api-key` secret, which holds no value until you add a version, so the key stays out of state. `extract` is internal-only and callable only by `extract_invokers`. `deletion_protection` is on by default, and images need `image_prefix` and a pinned `image_tag` (not `latest`; a `sha256:` digest is supported).

State files are gitignored. Before sharing GCP state, add a `gcs` backend to `envs/gcp` with restricted IAM.

The Elysia service (`apps/service`) is the module's optional `service` Cloud Run service, switched on with `deploy_service`. `envs/local` turns it on and gives it the emulator hosts (`service_extra_env`); `task build:service` builds its image first, and `task tf:apply` creates it. `envs/gcp` leaves it off: it still needs a service account and IAM (Firestore, Pub/Sub, running the agent jobs, invoking extract) before it can be deployed there.

Floci's Firestore needs no resource (documents only). Images are built by `task build:agents`, `task build:extract` and `task build:service`.

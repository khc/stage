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

The Elysia service (`apps/service`) is the module's optional `service` Cloud Run service, switched on with `deploy_service`. `envs/local` turns it on and gives it the emulator hosts (`service_extra_env`); `task build:service` builds its image first, and `task tf:apply` creates it. `task tf:create-service` (or `task tf:remove-service`) does the same for the service alone. In Floci the service reaches Firestore, Pub/Sub and the Cloud Run job API through the emulator hosts, but it cannot reach extract at the address Floci publishes for it (`*.run.localhost.floci.io` resolves to the container's own loopback), so a document upload through the Floci-hosted service answers 502 `document_error`; run the service on the host (`bun run dev:service`, with `EXTRACT_URL` from `task tf:create-extract`) to use documents locally. `envs/gcp` leaves it off until `deploy_service = true`, which also creates its service account `stage-service` and these bindings, each for one thing the service does: `roles/datastore.user` (Firestore, project-wide like the agents'), a custom role `stageServicePubsub` (publish platform events, and create, consume and delete the ephemeral subscription each process makes on the events topics: `pubsub.topics.get`, `publish`, `attachSubscription`, `pubsub.subscriptions.create`, `get`, `consume`, `delete`), `roles/run.viewer` (list the jobs), `roles/run.jobsExecutorWithOverrides` on each agent job only (start an execution with overrides), and `roles/run.invoker` on extract. The service calls extract with a Google ID token for extract's URL (`EXTRACT_AUDIENCE`, set by `service_extract_auth`), which the module turns on for GCP and not for Floci. Nobody may call the service until you list members in `service_invokers` (no `allUsers`: the service has no authentication of its own). Only `terraform validate` has run against `envs/gcp`: nothing has been planned or applied there, and the Pub/Sub permission names and `actAs` needs were not checked against a project.

Task schedules (see [docs/scheduler-plan.md](../docs/scheduler-plan.md)) are off until `envs/gcp` gets `scheduler_target_url` (the service's URL as Cloud Scheduler reaches it, with `deploy_service = true`; it is a variable because the service cannot read its own `uri` in its own env). That turns on the Cloud Scheduler API, creates the account `stage-scheduler` that Scheduler signs its ID token as, lets it call the service (it joins the `service_invoker` members), gives the service account a custom role `stageServiceScheduler` (`cloudscheduler.jobs.create`, `get`, `update`, `delete`) plus `roles/iam.serviceAccountUser` on `stage-scheduler`, and sets `SCHEDULER_TARGET_URL` and `SCHEDULER_INVOKER` on the service. Terraform declares no Scheduler jobs: the service creates one per task. `envs/local` adds nothing: Floci ignores IAM and the API setting, and a Floci-hosted service cannot be reached by Floci's Scheduler at a stable address, so locally run the service on the host (`bun run dev:service`) with `SCHEDULER_TARGET_URL=http://host.docker.internal:3000` in `.env`. Only `terraform validate` has run for this; the Scheduler permission names were not checked against a project.

Floci's Firestore needs no resource (documents only). Images are built by `task build:agents`, `task build:extract-service` and `task build:service`.

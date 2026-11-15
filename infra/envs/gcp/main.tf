variable "project" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "image_prefix" {
  type        = string
  description = "Registry prefix for images, e.g. us-central1-docker.pkg.dev/<project>/stage/."

  validation {
    condition     = var.image_prefix != ""
    error_message = "image_prefix is required when targeting GCP."
  }
}

variable "image_tag" {
  type        = string
  description = "Image tag, or a digest starting with sha256: (joined with @). latest is rejected."

  validation {
    condition     = var.image_tag != "latest"
    error_message = "A pinned (not latest) image_tag is required when targeting GCP."
  }
}

variable "agent_apps" {
  type    = set(string)
  default = ["generic", "poet"]
}

variable "agent_events_topic" {
  type    = string
  default = "agent-events"
}

variable "platform_events_topic" {
  type    = string
  default = "platform-events"
}

variable "agent_model" {
  type    = string
  default = null
}

variable "use_vertexai" {
  type    = string
  default = null
}

variable "extract_ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_INTERNAL_ONLY"
}

variable "extract_invokers" {
  type        = set(string)
  default     = []
  description = "IAM members allowed to invoke extract, e.g. serviceAccount:svc@project.iam.gserviceaccount.com."
}

variable "deploy_service" {
  type        = bool
  default     = false
  description = "Deploy the Elysia HTTP service (apps/service) with its service account and IAM."
}

variable "service_ingress" {
  type    = string
  default = null
}

variable "service_invokers" {
  type        = set(string)
  default     = []
  description = "IAM members allowed to call the service, e.g. the account the UI's proxy runs as. Nobody is allowed by default, and there is no allUsers: the service has no authentication of its own."
}

variable "deletion_protection" {
  type    = bool
  default = true
}

provider "google" {
  project = var.project
  region  = var.region
}

resource "google_project_service" "apis" {
  for_each = toset([
    "iam.googleapis.com",
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_firestore_database" "default" {
  name        = "(default)"
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]
}

resource "google_service_account" "agents" {
  account_id   = "stage-agents"
  display_name = "Stage agent jobs"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "extract" {
  account_id   = "stage-extract"
  display_name = "Stage extract service"
  depends_on   = [google_project_service.apis]
}

# The Elysia HTTP service (apps/service) and what it may do, only when deploy_service is on.
resource "google_service_account" "service" {
  count        = var.deploy_service ? 1 : 0
  account_id   = "stage-service"
  display_name = "Stage HTTP service"
  depends_on   = [google_project_service.apis]
}

locals {
  # Known at plan time (unlike the resource's email), so it can key a for_each.
  service_member = "serviceAccount:stage-service@${var.project}.iam.gserviceaccount.com"
}

# Firestore has no per-database IAM here, so this one is project-wide.
resource "google_project_iam_member" "agents_firestore" {
  project = var.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.agents.email}"
}

resource "google_pubsub_topic_iam_member" "agents_publisher" {
  topic  = module.stage.agent_events_topic
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.agents.email}"
}

# The secret holds no value here, so the key never enters Terraform state.
# Add it once: printf %s "$KEY" | gcloud secrets versions add gemini-api-key --data-file=-
resource "google_secret_manager_secret" "gemini" {
  secret_id = "gemini-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "agents" {
  secret_id = google_secret_manager_secret.gemini.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agents.email}"
}

resource "google_project_iam_member" "service_firestore" {
  count   = var.deploy_service ? 1 : 0
  project = var.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.service[0].email}"
}

# The service creates one ephemeral subscription per process on each events topic, receives from
# it and publishes platform events. Creating a subscription is a project-level permission, which
# no predefined role below Pub/Sub Editor grants, so this custom role lists just what is used.
resource "google_project_iam_custom_role" "service_pubsub" {
  count       = var.deploy_service ? 1 : 0
  role_id     = "stageServicePubsub"
  title       = "Stage service Pub/Sub"
  description = "Publish platform events and stream events through ephemeral subscriptions."
  permissions = [
    "pubsub.topics.get",
    "pubsub.topics.publish",
    "pubsub.topics.attachSubscription",
    "pubsub.subscriptions.create",
    "pubsub.subscriptions.get",
    "pubsub.subscriptions.consume",
    "pubsub.subscriptions.delete",
  ]
}

resource "google_project_iam_member" "service_pubsub" {
  count   = var.deploy_service ? 1 : 0
  project = var.project
  role    = google_project_iam_custom_role.service_pubsub[0].id
  member  = "serviceAccount:${google_service_account.service[0].email}"
}

# GET /jobs lists the jobs of the project and region.
resource "google_project_iam_member" "service_run_viewer" {
  count   = var.deploy_service ? 1 : 0
  project = var.project
  role    = "roles/run.viewer"
  member  = "serviceAccount:${google_service_account.service[0].email}"
}

# Starting an execution with overrides (TASK_ID, SESSION_ID, `register`), on the agent jobs only.
resource "google_cloud_run_v2_job_iam_member" "service_executor" {
  for_each = var.deploy_service ? toset(module.stage.agent_job_names) : toset([])
  name     = each.key
  location = var.region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.service[0].email}"
}

module "stage" {
  source = "../../modules/stage"

  project               = var.project
  region                = var.region
  agent_apps            = var.agent_apps
  agent_events_topic    = var.agent_events_topic
  platform_events_topic = var.platform_events_topic
  image_prefix          = var.image_prefix
  image_tag             = var.image_tag
  agent_model           = var.agent_model
  use_vertexai          = var.use_vertexai
  deletion_protection   = var.deletion_protection

  secret_env              = { GEMINI_API_KEY = google_secret_manager_secret.gemini.secret_id }
  agent_service_account   = google_service_account.agents.email
  extract_service_account = google_service_account.extract.email
  extract_ingress         = var.extract_ingress

  deploy_service          = var.deploy_service
  service_service_account = var.deploy_service ? google_service_account.service[0].email : null
  service_ingress         = var.service_ingress
  service_extract_auth    = true

  depends_on = [google_project_service.apis, google_secret_manager_secret_iam_member.agents]
}

# No allUsers: only the members listed in extract_invokers may call extract.
resource "google_cloud_run_v2_service_iam_member" "extract_invoker" {
  for_each = setunion(var.extract_invokers, var.deploy_service ? [local.service_member] : [])
  name     = module.stage.extract_name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.key
}

output "extract_url" {
  value = module.stage.extract_url
}

# No allUsers: only the members listed in service_invokers may call the service.
resource "google_cloud_run_v2_service_iam_member" "service_invoker" {
  for_each = var.deploy_service ? var.service_invokers : toset([])
  name     = module.stage.service_name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.key
}

output "service_url" {
  value = module.stage.service_url
}

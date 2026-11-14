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

  depends_on = [google_project_service.apis, google_secret_manager_secret_iam_member.agents]
}

# No allUsers: only the members listed in extract_invokers may call extract.
resource "google_cloud_run_v2_service_iam_member" "extract_invoker" {
  for_each = var.extract_invokers
  name     = module.stage.extract_name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.key
}

output "extract_url" {
  value = module.stage.extract_url
}

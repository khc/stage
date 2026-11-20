locals {
  prefix      = "stage-${var.environment}-"
  role_prefix = "stage${title(var.environment)}"
}

resource "google_project_service" "apis" {
  for_each = toset([
    "compute.googleapis.com",
    "iam.googleapis.com",
    "run.googleapis.com",
    "pubsub.googleapis.com",
    "firestore.googleapis.com",
    "secretmanager.googleapis.com",
    "cloudscheduler.googleapis.com",
  ])
  service            = each.key
  disable_on_destroy = false
}

resource "google_compute_network" "vpc" {
  name                    = "${local.prefix}vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "run" {
  name                     = "${local.prefix}run-subnet"
  ip_cidr_range            = var.subnet_cidr
  region                   = var.region
  network                  = google_compute_network.vpc.id
  private_ip_google_access = true
}

resource "google_firestore_database" "default" {
  count       = var.manage_firestore ? 1 : 0
  name        = var.firestore_database_id
  location_id = var.region
  type        = "FIRESTORE_NATIVE"
  depends_on  = [google_project_service.apis]

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_service_account" "agents" {
  account_id   = "${local.prefix}agents"
  display_name = "Stage ${var.environment} agent jobs"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "extract" {
  account_id   = "${local.prefix}extract"
  display_name = "Stage ${var.environment} extract service"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "service" {
  account_id   = "${local.prefix}service"
  display_name = "Stage ${var.environment} HTTP service"
  depends_on   = [google_project_service.apis]
}

resource "google_service_account" "scheduler" {
  account_id   = "${local.prefix}scheduler"
  display_name = "Stage ${var.environment} task schedules"
  depends_on   = [google_project_service.apis]
}

# Firestore has no per-database IAM binding here, so this binding is project-wide.
resource "google_project_iam_member" "agents_firestore" {
  project = var.project
  role    = "roles/datastore.user"
  member  = "serviceAccount:${google_service_account.agents.email}"
}

# The secret holds no value here, so the key never enters Terraform state.
# Add it once: printf %s "$KEY" | gcloud secrets versions add <secret_id> --data-file=-
resource "google_secret_manager_secret" "gemini" {
  secret_id = "${local.prefix}gemini-api-key"
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_iam_member" "agents_gemini" {
  secret_id = google_secret_manager_secret.gemini.id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.agents.email}"
}

# Custom IAM roles live permanently in foundation to avoid GCP's 7-to-37-day soft-delete collisions.
resource "google_project_iam_custom_role" "service_pubsub_topic" {
  role_id     = "${local.role_prefix}PubsubTopic"
  title       = "Stage ${var.environment} Pub/Sub topic attach"
  description = "Inspect and attach ephemeral subscriptions on Stage Pub/Sub topics."
  permissions = [
    "pubsub.topics.get",
    "pubsub.topics.attachSubscription",
  ]
  depends_on = [google_project_service.apis]
}

resource "google_project_iam_custom_role" "service_pubsub_subscriptions" {
  role_id     = "${local.role_prefix}PubsubSubscriptions"
  title       = "Stage ${var.environment} Pub/Sub ephemeral subscriptions"
  description = "Create, consume, and delete ephemeral streaming subscriptions."
  permissions = [
    "pubsub.subscriptions.create",
    "pubsub.subscriptions.get",
    "pubsub.subscriptions.consume",
    "pubsub.subscriptions.delete",
  ]
  depends_on = [google_project_service.apis]
}

resource "google_project_iam_custom_role" "service_scheduler" {
  role_id     = "${local.role_prefix}Scheduler"
  title       = "Stage ${var.environment} service Scheduler"
  description = "Manage the Cloud Scheduler jobs that run tasks."
  permissions = [
    "cloudscheduler.jobs.create",
    "cloudscheduler.jobs.get",
    "cloudscheduler.jobs.update",
    "cloudscheduler.jobs.delete",
  ]
  depends_on = [google_project_service.apis]
}

resource "google_project_iam_custom_role" "service_run_list" {
  role_id     = "${local.role_prefix}RunList"
  title       = "Stage ${var.environment} Cloud Run job lister"
  description = "List Cloud Run jobs without reading service configurations or unrelated jobs."
  permissions = [
    "run.jobs.list",
  ]
  depends_on = [google_project_service.apis]
}

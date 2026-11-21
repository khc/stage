locals {
  scheduler_enabled = var.deploy_service && var.scheduler_target_url != null
  service_member    = "serviceAccount:${var.service_service_account_email}"
  scheduler_member  = "serviceAccount:${var.scheduler_service_account_email}"
}

module "stage" {
  source = "../stage"

  project               = var.project
  region                = var.region
  env                   = var.env
  agent_apps            = var.agent_apps
  agent_events_topic    = var.agent_events_topic
  platform_events_topic = var.platform_events_topic
  image_prefix          = var.image_prefix
  image_tag             = var.image_tag
  agent_model           = var.agent_model
  use_vertexai          = var.use_vertexai
  deletion_protection   = var.deletion_protection

  agent_secret_env        = { GEMINI_API_KEY = var.gemini_secret_id }
  agent_service_account   = var.agent_service_account_email
  extract_service_account = var.extract_service_account_email
  extract_ingress         = var.extract_ingress

  deploy_service          = var.deploy_service
  service_service_account = var.deploy_service ? var.service_service_account_email : null
  service_ingress         = var.service_ingress
  set_extract_audience    = true
  service_vpc_access = {
    network    = var.vpc_id
    subnetwork = var.run_subnet_id
    egress     = "ALL_TRAFFIC"
  }
  service_env = local.scheduler_enabled ? {
    SCHEDULER_TARGET_URL = var.scheduler_target_url
    SCHEDULER_INVOKER    = var.scheduler_service_account_email
  } : {}
}

resource "google_pubsub_topic_iam_member" "agents_publisher" {
  topic  = module.stage.agent_events_topic
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${var.agent_service_account_email}"
}

resource "google_project_iam_member" "service_firestore" {
  count   = var.deploy_service ? 1 : 0
  project = var.project
  role    = "roles/datastore.user"
  member  = local.service_member
}

resource "google_pubsub_topic_iam_member" "service_platform_publisher" {
  count  = var.deploy_service ? 1 : 0
  topic  = module.stage.platform_events_topic
  role   = "roles/pubsub.publisher"
  member = local.service_member
}

resource "google_pubsub_topic_iam_member" "service_topic_attach" {
  for_each = var.deploy_service ? toset(["agent_events", "platform_events"]) : toset([])
  topic    = each.key == "agent_events" ? module.stage.agent_events_topic : module.stage.platform_events_topic
  role     = var.service_pubsub_topic_role_id
  member   = local.service_member
}

resource "google_project_iam_member" "service_pubsub_subscriptions" {
  count   = var.deploy_service ? 1 : 0
  project = var.project
  role    = var.service_pubsub_subscriptions_role_id
  member  = local.service_member

  condition {
    title       = "Stage service ephemeral subscriptions"
    description = "Restrict subscription lifecycle permissions to stage-service-* subscriptions."
    expression  = "resource.name.matches(\"^projects/[^/]+/subscriptions/stage-service-\")"
  }
}

resource "google_project_iam_member" "service_scheduler" {
  count   = local.scheduler_enabled ? 1 : 0
  project = var.project
  role    = var.service_scheduler_role_id
  member  = local.service_member

  condition {
    title       = "Stage task schedules"
    description = "Restrict Cloud Scheduler permissions to task-* jobs in the configured region."
    expression  = "resource.name.matches(\"^projects/[^/]+/locations/${var.region}/jobs/task-\")"
  }
}

resource "google_service_account_iam_member" "service_acts_as_scheduler" {
  count              = local.scheduler_enabled ? 1 : 0
  service_account_id = var.scheduler_service_account_name
  role               = "roles/iam.serviceAccountUser"
  member             = local.service_member
}

resource "google_project_iam_member" "service_run_list" {
  count   = var.deploy_service ? 1 : 0
  project = var.project
  role    = var.service_run_list_role_id
  member  = local.service_member
}

resource "google_cloud_run_v2_job_iam_member" "service_job_viewer" {
  for_each = var.deploy_service ? var.agent_apps : toset([])
  name     = "stage--${each.key}-agents--job-${var.env}"
  location = var.region
  role     = "roles/run.viewer"
  member   = local.service_member

  depends_on = [module.stage]
}

resource "google_cloud_run_v2_job_iam_member" "service_executor" {
  for_each = var.deploy_service ? var.agent_apps : toset([])
  name     = "stage--${each.key}-agents--job-${var.env}"
  location = var.region
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = local.service_member

  depends_on = [module.stage]
}

resource "google_cloud_run_v2_service_iam_member" "extract_invoker" {
  for_each = setunion(var.extract_invokers, var.deploy_service ? [local.service_member] : [])
  name     = module.stage.extract_name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.key
}

resource "google_cloud_run_v2_service_iam_member" "service_invoker" {
  for_each = var.deploy_service ? setunion(var.service_invokers, local.scheduler_enabled ? [local.scheduler_member] : []) : toset([])
  name     = module.stage.service_name
  location = var.region
  role     = "roles/run.invoker"
  member   = each.key
}

output "project" {
  value = var.project
}

output "region" {
  value = var.region
}

output "environment" {
  value = var.environment
}

output "name_prefix" {
  value = local.prefix
}

output "vpc_id" {
  value = google_compute_network.vpc.id
}

output "run_subnet_id" {
  value = google_compute_subnetwork.run.id
}

output "gemini_secret_id" {
  value = google_secret_manager_secret.gemini.secret_id
}

output "agent_service_account_email" {
  value = google_service_account.agents.email
}

output "extract_service_account_email" {
  value = google_service_account.extract.email
}

output "service_service_account_email" {
  value = google_service_account.service.email
}

output "scheduler_service_account_email" {
  value = google_service_account.scheduler.email
}

output "scheduler_service_account_name" {
  value = google_service_account.scheduler.name
}

output "service_pubsub_topic_role_id" {
  value = google_project_iam_custom_role.service_pubsub_topic.id
}

output "service_pubsub_subscriptions_role_id" {
  value = google_project_iam_custom_role.service_pubsub_subscriptions.id
}

output "service_scheduler_role_id" {
  value = google_project_iam_custom_role.service_scheduler.id
}

output "service_run_list_role_id" {
  value = google_project_iam_custom_role.service_run_list.id
}

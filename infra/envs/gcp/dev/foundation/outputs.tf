output "project" {
  value = module.foundation.project
}

output "region" {
  value = module.foundation.region
}

output "environment" {
  value = module.foundation.environment
}

output "name_prefix" {
  value = module.foundation.name_prefix
}

output "vpc_id" {
  value = module.foundation.vpc_id
}

output "run_subnet_id" {
  value = module.foundation.run_subnet_id
}

output "gemini_secret_id" {
  value = module.foundation.gemini_secret_id
}

output "agent_service_account_email" {
  value = module.foundation.agent_service_account_email
}

output "extract_service_account_email" {
  value = module.foundation.extract_service_account_email
}

output "service_service_account_email" {
  value = module.foundation.service_service_account_email
}

output "scheduler_service_account_email" {
  value = module.foundation.scheduler_service_account_email
}

output "scheduler_service_account_name" {
  value = module.foundation.scheduler_service_account_name
}

output "service_pubsub_topic_role_id" {
  value = module.foundation.service_pubsub_topic_role_id
}

output "service_pubsub_subscriptions_role_id" {
  value = module.foundation.service_pubsub_subscriptions_role_id
}

output "service_scheduler_role_id" {
  value = module.foundation.service_scheduler_role_id
}

output "service_run_list_role_id" {
  value = module.foundation.service_run_list_role_id
}

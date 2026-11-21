data "terraform_remote_state" "foundation" {
  backend = "gcs"
  config = {
    bucket = var.foundation_state_bucket
    prefix = var.foundation_state_prefix
  }
}

module "app" {
  source = "../../../../modules/gcp-app"

  project                              = var.project
  region                               = var.region
  env                                  = data.terraform_remote_state.foundation.outputs.environment
  vpc_id                               = data.terraform_remote_state.foundation.outputs.vpc_id
  run_subnet_id                        = data.terraform_remote_state.foundation.outputs.run_subnet_id
  gemini_secret_id                     = data.terraform_remote_state.foundation.outputs.gemini_secret_id
  agent_service_account_email          = data.terraform_remote_state.foundation.outputs.agent_service_account_email
  extract_service_account_email        = data.terraform_remote_state.foundation.outputs.extract_service_account_email
  service_service_account_email        = data.terraform_remote_state.foundation.outputs.service_service_account_email
  scheduler_service_account_email      = data.terraform_remote_state.foundation.outputs.scheduler_service_account_email
  scheduler_service_account_name       = data.terraform_remote_state.foundation.outputs.scheduler_service_account_name
  service_pubsub_topic_role_id         = data.terraform_remote_state.foundation.outputs.service_pubsub_topic_role_id
  service_pubsub_subscriptions_role_id = data.terraform_remote_state.foundation.outputs.service_pubsub_subscriptions_role_id
  service_scheduler_role_id            = data.terraform_remote_state.foundation.outputs.service_scheduler_role_id
  service_run_list_role_id             = data.terraform_remote_state.foundation.outputs.service_run_list_role_id

  image_prefix          = var.image_prefix
  image_tag             = var.image_tag
  agent_apps            = var.agent_apps
  agent_events_topic    = var.agent_events_topic
  platform_events_topic = var.platform_events_topic
  agent_model           = var.agent_model
  use_vertexai          = var.use_vertexai
  extract_ingress       = var.extract_ingress
  extract_invokers      = var.extract_invokers
  deploy_service        = var.deploy_service
  service_ingress       = var.service_ingress
  service_invokers      = var.service_invokers
  scheduler_target_url  = var.scheduler_target_url
  deletion_protection   = var.deletion_protection
}

module "stage" {
  source = "../../modules/stage"

  project               = var.project
  region                = var.region
  agent_apps            = var.agent_apps
  agent_events_topic    = var.agent_events_topic
  platform_events_topic = var.platform_events_topic
  agent_model           = var.agent_model
  use_vertexai          = var.use_vertexai
  deletion_protection   = false
  deploy_service        = true
  extract_ingress       = "INGRESS_TRAFFIC_ALL"
  service_ingress       = "INGRESS_TRAFFIC_ALL"

  service_env = {
    FIRESTORE_EMULATOR_HOST = var.emulator_host
    PUBSUB_EMULATOR_HOST    = var.emulator_host
    CLOUD_RUN_EMULATOR_HOST = var.emulator_host
  }

  agent_env = merge(var.otel_env, {
    FIRESTORE_EMULATOR_HOST = var.emulator_host
    PUBSUB_EMULATOR_HOST    = var.emulator_host
    GEMINI_API_KEY          = var.gemini_api_key
  })
}

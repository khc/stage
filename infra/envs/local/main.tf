variable "project" {
  type    = string
  default = "floci-local"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "emulator_url" {
  type        = string
  default     = "http://localhost:4588"
  description = "Floci GCP base URL."
}

variable "emulator_host" {
  type        = string
  default     = "floci-gcp:4588"
  description = "host:port the jobs use to reach Floci from inside Docker."
}

variable "gemini_api_key" {
  type        = string
  sensitive   = true
  description = "Plain env value on the Floci jobs (and so in local state): use a throwaway key. Set TF_VAR_gemini_api_key."
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

variable "otel_env" {
  type        = map(string)
  default     = {}
  description = "OTEL_* variables for the agent jobs; task tf:apply fills it from .env."
}

variable "use_vertexai" {
  type    = string
  default = null
}

provider "google" {
  project = var.project
  region  = var.region

  # Floci does not check credentials; a placeholder token skips ADC lookup.
  access_token = "floci"

  pubsub_custom_endpoint       = "${trimsuffix(var.emulator_url, "/")}/v1/"
  cloud_run_v2_custom_endpoint = "${trimsuffix(var.emulator_url, "/")}/v2/"
}

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

  service_extra_env = {
    FIRESTORE_EMULATOR_HOST = var.emulator_host
    PUBSUB_EMULATOR_HOST    = var.emulator_host
    CLOUD_RUN_EMULATOR_HOST = var.emulator_host
  }

  extra_env = merge(var.otel_env, {
    FIRESTORE_EMULATOR_HOST = var.emulator_host
    PUBSUB_EMULATOR_HOST    = var.emulator_host
    GEMINI_API_KEY          = var.gemini_api_key
  })
}

output "extract_url" {
  value = module.stage.extract_url
}

output "service_url" {
  value = module.stage.service_url
}

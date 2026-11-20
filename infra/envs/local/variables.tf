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
  sensitive   = true
  description = "OTEL_* variables for the agent jobs; task tf:apply fills it from .env."
}

variable "use_vertexai" {
  type    = string
  default = null
}

variable "project" {
  type = string
}

variable "region" {
  type = string
}

variable "agent_apps" {
  type        = set(string)
  description = "One Cloud Run job per agents/<name> app, named <name>-agents from image stage-<name>:<tag>."
}

variable "agent_events_topic" {
  type = string
}

variable "platform_events_topic" {
  type = string
}

variable "image_prefix" {
  type    = string
  default = ""
}

variable "image_tag" {
  type        = string
  default     = "latest"
  description = "Image tag, or a digest starting with sha256: (joined with @)."
}

variable "agent_model" {
  type    = string
  default = null
}

variable "use_vertexai" {
  type    = string
  default = null
}

variable "extra_env" {
  type        = map(string)
  default     = {}
  description = "Plain env values added to the agent jobs (emulator hosts, Floci key)."
}

variable "secret_env" {
  type        = map(string)
  default     = {}
  description = "Env name => Secret Manager secret id; latest version is read at run time."
}

variable "agent_service_account" {
  type    = string
  default = null
}

variable "extract_service_account" {
  type    = string
  default = null
}

variable "extract_ingress" {
  type    = string
  default = null
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "deploy_service" {
  type        = bool
  default     = false
  description = "Deploy the Elysia HTTP service (apps/service) as a Cloud Run service."
}

variable "service_service_account" {
  type    = string
  default = null
}

variable "service_ingress" {
  type    = string
  default = null
}

variable "service_extra_env" {
  type        = map(string)
  default     = {}
  description = "Environment for service beyond what the module derives, e.g. the emulator hosts in envs/local."
}

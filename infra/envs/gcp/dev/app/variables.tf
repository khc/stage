variable "project" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "foundation_state_bucket" {
  type        = string
  description = "GCS bucket holding the dev foundation Terraform state."
}

variable "foundation_state_prefix" {
  type        = string
  default     = "stage/dev/foundation"
  description = "GCS prefix holding the dev foundation Terraform state."
}

variable "image_prefix" {
  type = string
}

variable "image_tag" {
  type = string
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
  type    = set(string)
  default = []
}

variable "deploy_service" {
  type    = bool
  default = false
}

variable "service_ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_ALL"
}

variable "service_invokers" {
  type    = set(string)
  default = []
}

variable "scheduler_target_url" {
  type    = string
  default = null
}

variable "deletion_protection" {
  type    = bool
  default = false
}

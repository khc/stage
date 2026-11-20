variable "project" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "name_prefix" {
  type        = string
  default     = ""
  description = "Optional prefix prepended to Cloud Run service and job names (e.g. stage-dev-)."

  validation {
    condition     = var.name_prefix == "" || can(regex("^[a-z][a-z0-9-]*-$", var.name_prefix))
    error_message = "name_prefix must be empty or lowercase alphanumeric/hyphens ending with a hyphen."
  }
}

variable "agent_apps" {
  type        = set(string)
  description = "One Cloud Run job per agents/<name> app, named <name_prefix><name>-agents from image stage-<name>:<tag>."
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

variable "agent_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Additional environment variables injected into agent jobs."
}

variable "agent_secret_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Env name => Secret Manager secret id for agent jobs; latest version is read at run time."
}

variable "agent_service_account" {
  type    = string
  default = null
}

variable "agent_resources" {
  type = object({
    cpu    = optional(string, "1")
    memory = optional(string, "512Mi")
  })
  default     = {}
  description = "CPU and memory limits for agent job containers."
}

variable "agent_timeout" {
  type        = string
  default     = "600s"
  description = "Maximum execution duration per agent task attempt."
}

variable "extract_service_account" {
  type    = string
  default = null
}

variable "extract_ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.extract_ingress)
    error_message = "extract_ingress must be a valid Cloud Run v2 ingress setting."
  }
}

variable "extract_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Additional environment variables injected into the extract service."
}

variable "extract_secret_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Env name => Secret Manager secret id for the extract service."
}

variable "extract_resources" {
  type = object({
    cpu    = optional(string, "1")
    memory = optional(string, "512Mi")
  })
  default     = {}
  description = "CPU and memory limits for the extract container."
}

variable "extract_scaling" {
  type = object({
    min_instance_count = optional(number, 0)
    max_instance_count = optional(number, 5)
  })
  default     = {}
  description = "Instance scaling bounds for the extract service."
}

variable "extract_timeout" {
  type        = string
  default     = "300s"
  description = "Request timeout for the extract service."
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
  default = "INGRESS_TRAFFIC_ALL"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.service_ingress)
    error_message = "service_ingress must be a valid Cloud Run v2 ingress setting."
  }
}

variable "service_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Additional environment variables injected into the HTTP service."
}

variable "service_secret_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "Env name => Secret Manager secret id for the HTTP service."
}

variable "set_extract_audience" {
  type        = bool
  default     = false
  description = "When true, sets EXTRACT_AUDIENCE to extract's URI so service attaches an ID token for IAM-protected extract."
}

variable "service_vpc_access" {
  type = object({
    network    = optional(string)
    subnetwork = optional(string)
    connector  = optional(string)
    egress     = optional(string, "ALL_TRAFFIC")
  })
  default     = null
  description = "Optional VPC egress settings for service (required when extract uses INGRESS_TRAFFIC_INTERNAL_ONLY)."
}

variable "service_resources" {
  type = object({
    cpu    = optional(string, "1")
    memory = optional(string, "512Mi")
  })
  default     = {}
  description = "CPU and memory limits for the HTTP service container."
}

variable "service_scaling" {
  type = object({
    min_instance_count = optional(number, 0)
    max_instance_count = optional(number, 10)
  })
  default     = {}
  description = "Instance scaling bounds for the HTTP service."
}

variable "service_timeout" {
  type        = string
  default     = "300s"
  description = "Request timeout for the HTTP service."
}

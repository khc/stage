variable "project" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"

  validation {
    condition     = can(regex("^[a-z]+-[a-z]+[0-9]+$", var.region))
    error_message = "region must be a valid GCP region name (e.g. us-central1)."
  }
}

variable "name_prefix" {
  type        = string
  description = "Environment prefix from foundation (e.g. stage-dev-)."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]*-$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumeric/hyphens ending with a hyphen."
  }
}

variable "vpc_id" {
  type = string
}

variable "run_subnet_id" {
  type = string
}

variable "gemini_secret_id" {
  type = string
}

variable "agent_service_account_email" {
  type = string
}

variable "extract_service_account_email" {
  type = string
}

variable "service_service_account_email" {
  type = string
}

variable "scheduler_service_account_email" {
  type = string
}

variable "scheduler_service_account_name" {
  type = string
}

variable "service_pubsub_topic_role_id" {
  type = string
}

variable "service_pubsub_subscriptions_role_id" {
  type = string
}

variable "service_scheduler_role_id" {
  type = string
}

variable "service_run_list_role_id" {
  type = string
}

variable "image_prefix" {
  type        = string
  description = "Artifact Registry prefix for images, e.g. us-central1-docker.pkg.dev/<project>/stage/."

  validation {
    condition     = can(regex("^[a-z0-9-]+-docker\\.pkg\\.dev/[a-z0-9-]+/[a-z0-9._-]+/$", var.image_prefix))
    error_message = "image_prefix must be an Artifact Registry prefix ending with '/' (e.g. us-central1-docker.pkg.dev/<project>/<repo>/)."
  }
}

variable "image_tag" {
  type        = string
  description = "Pinned image tag, or a 64-hex-char sha256: digest (joined with @). Empty, whitespace, or latest is rejected."

  validation {
    condition     = can(regex("^(sha256:[a-f0-9]{64}|[A-Za-z0-9_][A-Za-z0-9._-]{0,127})$", var.image_tag)) && lower(var.image_tag) != "latest"
    error_message = "image_tag must be a valid non-latest tag or sha256:<64-hex> digest without surrounding whitespace."
  }
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

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.extract_ingress)
    error_message = "extract_ingress must be a valid Cloud Run v2 ingress setting."
  }
}

variable "extract_invokers" {
  type        = set(string)
  default     = []
  description = "IAM members allowed to invoke extract, e.g. serviceAccount:svc@project.iam.gserviceaccount.com."

  validation {
    condition     = length(setintersection(var.extract_invokers, toset(["allUsers", "allAuthenticatedUsers"]))) == 0
    error_message = "extract_invokers must not include allUsers or allAuthenticatedUsers."
  }
}

variable "deploy_service" {
  type        = bool
  default     = false
  description = "Deploy the Elysia HTTP service (apps/control-service) and its workload IAM bindings."
}

variable "service_ingress" {
  type    = string
  default = "INGRESS_TRAFFIC_ALL"

  validation {
    condition     = contains(["INGRESS_TRAFFIC_ALL", "INGRESS_TRAFFIC_INTERNAL_ONLY", "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"], var.service_ingress)
    error_message = "service_ingress must be a valid Cloud Run v2 ingress setting."
  }
}

variable "service_invokers" {
  type        = set(string)
  default     = []
  description = "IAM members allowed to call the service, e.g. the account the UI's proxy runs as."

  validation {
    condition     = length(setintersection(var.service_invokers, toset(["allUsers", "allAuthenticatedUsers"]))) == 0
    error_message = "service_invokers must not include allUsers or allAuthenticatedUsers (the service has no authentication of its own)."
  }
}

variable "scheduler_target_url" {
  type        = string
  default     = null
  description = "HTTPS base URL that Cloud Scheduler calls to run a task (requires deploy_service = true)."

  validation {
    condition     = var.scheduler_target_url == null || can(regex("^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[^\\s]*)?$", var.scheduler_target_url))
    error_message = "scheduler_target_url must be null or a valid https:// URL without whitespace."
  }
}

variable "deletion_protection" {
  type    = bool
  default = true
}

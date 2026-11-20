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

variable "environment" {
  type        = string
  description = "Short environment identifier (e.g. dev, prod) used to namespace resources."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{0,9}$", var.environment))
    error_message = "environment must be 1-10 lowercase alphanumeric characters starting with a letter."
  }
}

variable "subnet_cidr" {
  type        = string
  default     = "10.8.0.0/24"
  description = "Primary IPv4 CIDR range for the Cloud Run Direct VPC egress subnet."
}

variable "manage_firestore" {
  type        = bool
  default     = true
  description = "Create the Firestore database for this environment (set false only if reusing an existing database in a shared project)."
}

variable "firestore_database_id" {
  type        = string
  default     = "(default)"
  description = "Firestore database name."
}

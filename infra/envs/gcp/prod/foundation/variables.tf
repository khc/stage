variable "project" {
  type = string
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "subnet_cidr" {
  type    = string
  default = "10.9.0.0/24"
}

variable "manage_firestore" {
  type    = bool
  default = true
}

variable "firestore_database_id" {
  type    = string
  default = "(default)"
}

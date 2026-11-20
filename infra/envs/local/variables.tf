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
  default = ["generic", "poet", "knowledge"]
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

variable "qdrant_url" {
  type        = string
  default     = "http://host.docker.internal:6333"
  description = "Qdrant as the knowledge agent's job container reaches it (the compose port published on the host)."
}

variable "qdrant_collection" {
  type        = string
  default     = "docs"
  description = "Collection the knowledge agent searches; pinned so a QDRANT_COLLECTION in .env does not redirect it."
}

variable "embedding_url" {
  type        = string
  default     = "http://host.docker.internal:8000"
  description = "OpenAI-compatible embeddings server (oMLX on the host) as the job container reaches it."
}

variable "knowledge_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "QDRANT_API_KEY, EMBEDDING_MODEL, EMBEDDING_API_KEY and EMBEDDING_QUERY_PREFIX for the knowledge agent; task tf:apply fills it from .env."
}

variable "use_vertexai" {
  type    = string
  default = null
}

variable "imdb_db_password" {
  type        = string
  default     = "imdb-local"
  sensitive   = true
  description = "Password of the imdb user on the local Cloud SQL instance (Floci runs a throwaway Postgres container; set TF_VAR_imdb_db_password to change it)."
}

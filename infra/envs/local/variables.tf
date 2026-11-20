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

variable "rerank_url" {
  type        = string
  default     = null
  description = "Optional reranker server base URL as the job container reaches it; unset falls back to embedding_url."
}

variable "knowledge_env" {
  type        = map(string)
  default     = {}
  sensitive   = true
  description = "QDRANT_API_KEY, EMBEDDING_MODEL, EMBEDDING_API_KEY, EMBEDDING_QUERY_PREFIX, RERANK_MODEL, RERANK_API_KEY, NEO4J_USER and NEO4J_PASSWORD for the knowledge agent; task tf:apply fills it from .env."
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

variable "imdb_reader_password" {
  type        = string
  default     = "imdb-reader-local"
  sensitive   = true
  description = "Password of the read-only imdb_reader user, which the knowledge agent connects as (a throwaway local value; set TF_VAR_imdb_reader_password to change it)."
}

variable "imdb_db_host" {
  type        = string
  default     = "floci-gcp-cloudsql-floci-local-imdb"
  description = "Host of the imdb Cloud SQL instance as the job containers reach it: the name of the Postgres container Floci runs for it (the same default as --container in scripts/imdb-load.ts), on the compose network."
}

variable "neo4j_url" {
  type        = string
  default     = "http://host.docker.internal:7474"
  description = "Neo4j HTTP base URL as the knowledge agent's job container reaches it."
}

variable "neo4j_database" {
  type        = string
  default     = "neo4j"
  description = "Neo4j database name queried by the knowledge agent."
}

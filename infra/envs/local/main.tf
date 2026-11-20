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
  extract_ingress       = "INGRESS_TRAFFIC_ALL"
  service_ingress       = "INGRESS_TRAFFIC_ALL"

  service_env = {
    FIRESTORE_EMULATOR_HOST = var.emulator_host
    PUBSUB_EMULATOR_HOST    = var.emulator_host
    CLOUD_RUN_EMULATOR_HOST = var.emulator_host
  }

  agent_env = merge(var.otel_env, {
    FIRESTORE_EMULATOR_HOST = var.emulator_host
    PUBSUB_EMULATOR_HOST    = var.emulator_host
    GEMINI_API_KEY          = var.gemini_api_key
  })

  # Only the knowledge job gets the Qdrant and embedding settings, keys included.
  agent_app_env = {
    knowledge = merge(var.knowledge_env, {
      QDRANT_URL        = var.qdrant_url
      QDRANT_COLLECTION = var.qdrant_collection
      EMBEDDING_URL     = var.embedding_url
      NEO4J_URL         = var.neo4j_url
      NEO4J_DATABASE    = var.neo4j_database
      # The knowledge agent's imdb-assistant reads the IMDb tables as the read-only role.
      IMDB_DATABASE_URL = "postgres://imdb_reader:${urlencode(var.imdb_reader_password)}@${var.imdb_db_host}:5432/imdb"
    })
  }
}

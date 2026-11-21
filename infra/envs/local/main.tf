module "stage" {
  source = "../../modules/stage"

  project               = var.project
  region                = var.region
  env                   = "lcl"
  agent_apps            = var.agent_apps
  agent_events_topic    = var.agent_events_topic
  platform_events_topic = var.platform_events_topic
  agent_model           = var.agent_model
  use_vertexai          = var.use_vertexai
  deletion_protection   = false
  deploy_service        = true
  extract_ingress       = "INGRESS_TRAFFIC_ALL"
  service_ingress       = "INGRESS_TRAFFIC_ALL"
  # Quick hosts: each agent image also runs as a service. Floci has no IAM, so ingress is open here.
  agent_service_apps    = var.agent_service_apps
  agent_service_ingress = "INGRESS_TRAFFIC_ALL"

  service_env = {
    # Required by the service; the open state is a choice, and `*` is the local one.
    AGENT_JOBS              = "*"
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
    # The orchestrator reaches the other agents over A2A at the service's gateway. It is the one job that
    # needs JOB_NAME at run time, to leave itself out of the agents it offers; the gateway is plain http
    # on a non-loopback host, which ADK accepts only when told to.
    orchestrator = {
      GATEWAY_URL            = var.gateway_url
      GATEWAY_ALLOW_INSECURE = "true"
      JOB_NAME               = "stage--orchestrator-agents--job-lcl"
    }
    knowledge = merge(
      var.knowledge_env,
      var.rerank_url == null ? {} : { RERANK_URL = var.rerank_url },
      {
        QDRANT_URL        = var.qdrant_url
        QDRANT_COLLECTION = var.qdrant_collection
        EMBEDDING_URL     = var.embedding_url
        NEO4J_URL         = var.neo4j_url
        NEO4J_DATABASE    = var.neo4j_database
        # The knowledge agent's imdb-assistant reads the IMDb tables as the read-only role.
        IMDB_DATABASE_URL = "postgres://imdb_reader:${urlencode(var.imdb_reader_password)}@${var.imdb_db_host}:5432/imdb"
      },
    )
  }
}

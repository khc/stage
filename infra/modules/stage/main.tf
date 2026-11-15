locals {
  image_sep = startswith(var.image_tag, "sha256:") ? "@" : ":"

  agent_env = merge(
    {
      GOOGLE_CLOUD_PROJECT = var.project
      PUBSUB_TOPIC         = var.agent_events_topic
    },
    var.extra_env,
    var.agent_model == null ? {} : { AGENT_MODEL = var.agent_model },
    var.use_vertexai == null ? {} : { GOOGLE_GENAI_USE_VERTEXAI = var.use_vertexai },
  )

  service_env = merge(
    {
      GCP_PROJECT           = var.project
      GCP_REGION            = var.region
      GOOGLE_CLOUD_PROJECT  = var.project
      EXTRACT_URL           = google_cloud_run_v2_service.extract.uri
      PUBSUB_TOPIC          = var.agent_events_topic
      PLATFORM_EVENTS_TOPIC = var.platform_events_topic
    },
    var.service_extract_auth ? { EXTRACT_AUDIENCE = google_cloud_run_v2_service.extract.uri } : {},
    var.service_extra_env,
  )
}

resource "google_pubsub_topic" "events" {
  for_each = toset([var.agent_events_topic, var.platform_events_topic])
  name     = each.key
}

# Runs are not safe to repeat, so tasks never retry (matches scripts/cloud-run-job.ts).
resource "google_cloud_run_v2_job" "agents" {
  for_each            = var.agent_apps
  name                = "${each.key}-agents"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      max_retries     = 0
      service_account = var.agent_service_account

      containers {
        image = "${var.image_prefix}stage-${each.key}${local.image_sep}${var.image_tag}"

        dynamic "env" {
          for_each = local.agent_env
          content {
            name  = env.key
            value = env.value
          }
        }

        dynamic "env" {
          for_each = var.secret_env
          content {
            name = env.key
            value_source {
              secret_key_ref {
                secret  = env.value
                version = "latest"
              }
            }
          }
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service" "extract" {
  name                = "extract"
  location            = var.region
  ingress             = var.extract_ingress
  deletion_protection = var.deletion_protection

  template {
    service_account = var.extract_service_account

    containers {
      image = "${var.image_prefix}stage-extract${local.image_sep}${var.image_tag}"

      ports {
        container_port = 8080
      }
    }
  }
}

# The Elysia HTTP service (apps/service). The image listens on 0.0.0.0:3000.
resource "google_cloud_run_v2_service" "service" {
  count               = var.deploy_service ? 1 : 0
  name                = "service"
  location            = var.region
  ingress             = var.service_ingress
  deletion_protection = var.deletion_protection

  template {
    service_account = var.service_service_account

    containers {
      image = "${var.image_prefix}stage-service${local.image_sep}${var.image_tag}"

      ports {
        container_port = 3000
      }

      dynamic "env" {
        for_each = local.service_env
        content {
          name  = env.key
          value = env.value
        }
      }
    }
  }
}

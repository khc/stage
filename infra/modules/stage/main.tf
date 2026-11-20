locals {
  image_sep = startswith(var.image_tag, "sha256:") ? "@" : ":"

  agent_env = merge(
    {
      GOOGLE_CLOUD_PROJECT = var.project
      PUBSUB_TOPIC         = var.agent_events_topic
    },
    var.agent_env,
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
    var.set_extract_audience ? { EXTRACT_AUDIENCE = google_cloud_run_v2_service.extract.uri } : {},
    var.service_env,
  )
}

resource "google_pubsub_topic" "events" {
  for_each = toset([var.agent_events_topic, var.platform_events_topic])
  name     = each.key
}

# Runs are not safe to repeat, so tasks never retry (matches scripts/cloud-run-job.ts).
resource "google_cloud_run_v2_job" "agents" {
  for_each            = var.agent_apps
  name                = "${var.name_prefix}${each.key}-agents"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      max_retries     = 0
      timeout         = var.agent_timeout
      service_account = var.agent_service_account

      containers {
        image = "${var.image_prefix}stage-${each.key}${local.image_sep}${var.image_tag}"

        resources {
          limits = {
            cpu    = var.agent_resources.cpu
            memory = var.agent_resources.memory
          }
        }

        dynamic "env" {
          for_each = nonsensitive(keys(local.agent_env))
          content {
            name  = env.value
            value = local.agent_env[env.value]
          }
        }

        dynamic "env" {
          for_each = nonsensitive(keys(var.agent_secret_env))
          content {
            name = env.value
            value_source {
              secret_key_ref {
                secret  = var.agent_secret_env[env.value]
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
  name                = "${var.name_prefix}extract"
  location            = var.region
  ingress             = var.extract_ingress
  deletion_protection = var.deletion_protection

  template {
    timeout         = var.extract_timeout
    service_account = var.extract_service_account

    scaling {
      min_instance_count = var.extract_scaling.min_instance_count
      max_instance_count = var.extract_scaling.max_instance_count
    }

    containers {
      image = "${var.image_prefix}stage-extract${local.image_sep}${var.image_tag}"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.extract_resources.cpu
          memory = var.extract_resources.memory
        }
      }

      dynamic "env" {
        for_each = nonsensitive(keys(var.extract_env))
        content {
          name  = env.value
          value = var.extract_env[env.value]
        }
      }

      dynamic "env" {
        for_each = nonsensitive(keys(var.extract_secret_env))
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = var.extract_secret_env[env.value]
              version = "latest"
            }
          }
        }
      }
    }
  }
}

# The Elysia HTTP service (apps/service). The image listens on 0.0.0.0:3000.
resource "google_cloud_run_v2_service" "service" {
  count               = var.deploy_service ? 1 : 0
  name                = "${var.name_prefix}service"
  location            = var.region
  ingress             = var.service_ingress
  deletion_protection = var.deletion_protection

  template {
    timeout         = var.service_timeout
    service_account = var.service_service_account

    scaling {
      min_instance_count = var.service_scaling.min_instance_count
      max_instance_count = var.service_scaling.max_instance_count
    }

    dynamic "vpc_access" {
      for_each = var.service_vpc_access == null ? [] : [var.service_vpc_access]
      content {
        connector = vpc_access.value.connector
        egress    = vpc_access.value.egress
        dynamic "network_interfaces" {
          for_each = vpc_access.value.network != null || vpc_access.value.subnetwork != null ? [vpc_access.value] : []
          content {
            network    = network_interfaces.value.network
            subnetwork = network_interfaces.value.subnetwork
          }
        }
      }
    }

    containers {
      image = "${var.image_prefix}stage-service${local.image_sep}${var.image_tag}"

      ports {
        container_port = 3000
      }

      resources {
        limits = {
          cpu    = var.service_resources.cpu
          memory = var.service_resources.memory
        }
      }

      dynamic "env" {
        for_each = nonsensitive(keys(local.service_env))
        content {
          name  = env.value
          value = local.service_env[env.value]
        }
      }

      dynamic "env" {
        for_each = nonsensitive(keys(var.service_secret_env))
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = var.service_secret_env[env.value]
              version = "latest"
            }
          }
        }
      }
    }
  }
}

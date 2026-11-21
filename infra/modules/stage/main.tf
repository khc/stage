locals {
  image_sep             = startswith(var.image_tag, "sha256:") ? "@" : ":"
  agent_events_topic    = "stage--${var.agent_events_topic}--ps-${var.env}"
  platform_events_topic = "stage--${var.platform_events_topic}--ps-${var.env}"

  agent_env = merge(
    {
      GOOGLE_CLOUD_PROJECT = var.project
      PUBSUB_TOPIC         = local.agent_events_topic
    },
    var.agent_env,
    var.agent_model == null ? {} : { AGENT_MODEL = var.agent_model },
    var.use_vertexai == null ? {} : { GOOGLE_GENAI_USE_VERTEXAI = var.use_vertexai },
  )

  # agent_env for every job, plus what only that app's job needs (such as its own API keys). An app with
  # an agent service also sets AGENT_QUICK, so its agents register the `quick` mode (see registerMain).
  job_env = {
    for app in var.agent_apps : app => merge(
      local.agent_env,
      lookup(var.agent_app_env, app, {}),
      contains(var.agent_service_apps, app) ? { AGENT_QUICK = "true" } : {},
    )
  }

  # Job name => URL of its agent service: the platform service's AGENT_SERVICES.
  agent_services = {
    for app, service in google_cloud_run_v2_service.agent_services :
    "stage--${app}-agents--job-${var.env}" => service.uri
  }

  service_env = merge(
    {
      GCP_PROJECT           = var.project
      GCP_REGION            = var.region
      GOOGLE_CLOUD_PROJECT  = var.project
      EXTRACT_URL           = google_cloud_run_v2_service.extract.uri
      PUBSUB_TOPIC          = local.agent_events_topic
      PLATFORM_EVENTS_TOPIC = local.platform_events_topic
    },
    var.set_extract_audience ? { EXTRACT_AUDIENCE = google_cloud_run_v2_service.extract.uri } : {},
    length(local.agent_services) > 0 ? { AGENT_SERVICES = jsonencode(local.agent_services) } : {},
    var.set_agent_services_audience ? { AGENT_SERVICES_ID_TOKEN = "true" } : {},
    var.service_env,
  )
}

resource "google_pubsub_topic" "events" {
  for_each = toset([local.agent_events_topic, local.platform_events_topic])
  name     = each.key
}

# Runs are not safe to repeat, so tasks never retry (matches scripts/cloud-run-job.ts).
resource "google_cloud_run_v2_job" "agents" {
  for_each            = var.agent_apps
  name                = "stage--${each.key}-agents--job-${var.env}"
  location            = var.region
  deletion_protection = var.deletion_protection

  template {
    template {
      max_retries     = 0
      timeout         = var.agent_timeout
      service_account = var.agent_service_account

      containers {
        image = "${var.image_prefix}stage/${each.key}-agents${local.image_sep}${var.image_tag}"

        resources {
          limits = {
            cpu    = var.agent_resources.cpu
            memory = var.agent_resources.memory
          }
        }

        dynamic "env" {
          for_each = nonsensitive(keys(local.job_env[each.key]))
          content {
            name  = env.value
            value = local.job_env[each.key][env.value]
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

# The quick host of an agent app: the job's image run as an HTTP service with the `serve` argument, on the
# same env and secrets as the job. It answers POST /run for the platform service (apps/control-service).
resource "google_cloud_run_v2_service" "agent_services" {
  for_each            = var.agent_service_apps
  name                = "stage--${each.key}-agents--svc-${var.env}"
  location            = var.region
  ingress             = var.agent_service_ingress
  deletion_protection = var.deletion_protection

  lifecycle {
    precondition {
      condition     = contains(var.agent_apps, each.key)
      error_message = "agent_service_apps entry ${each.key} is not in agent_apps."
    }
  }

  template {
    timeout                          = var.agent_service_timeout
    service_account                  = var.agent_service_account
    max_instance_request_concurrency = var.agent_service_concurrency

    scaling {
      min_instance_count = var.agent_service_scaling.min_instance_count
      max_instance_count = var.agent_service_scaling.max_instance_count
    }

    containers {
      image = "${var.image_prefix}stage/${each.key}-agents${local.image_sep}${var.image_tag}"
      args  = ["serve"]

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.agent_resources.cpu
          memory = var.agent_resources.memory
        }
      }

      dynamic "env" {
        for_each = nonsensitive(keys(local.job_env[each.key]))
        content {
          name  = env.value
          value = local.job_env[each.key][env.value]
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

# Only the HTTP service's account may call an agent service. Without a named account the service runs as
# the default one, and the binding is left to the environment.
resource "google_cloud_run_v2_service_iam_member" "agent_services_invoker" {
  for_each = var.service_service_account == null ? toset([]) : var.agent_service_apps
  name     = google_cloud_run_v2_service.agent_services[each.key].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${var.service_service_account}"
}

resource "google_cloud_run_v2_service" "extract" {
  name                = "stage--extract-service--svc-${var.env}"
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
      image = "${var.image_prefix}stage/extract-service${local.image_sep}${var.image_tag}"

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

# The Elysia HTTP service (apps/control-service). The image listens on 0.0.0.0:3000.
resource "google_cloud_run_v2_service" "service" {
  count               = var.deploy_service ? 1 : 0
  name                = "stage--control-service--svc-${var.env}"
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
      image = "${var.image_prefix}stage/control-service${local.image_sep}${var.image_tag}"

      ports {
        container_port = 3000
      }

      resources {
        cpu_idle = var.service_cpu_idle
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

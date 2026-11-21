output "extract_url" {
  value = google_cloud_run_v2_service.extract.uri
}

output "extract_name" {
  value = google_cloud_run_v2_service.extract.name
}

output "agent_events_topic" {
  value = google_pubsub_topic.events[local.agent_events_topic].name
}

output "service_url" {
  value = one(google_cloud_run_v2_service.service[*].uri)
}

output "service_name" {
  value = one(google_cloud_run_v2_service.service[*].name)
}

output "agent_job_names" {
  value = [for job in google_cloud_run_v2_job.agents : job.name]
}

output "platform_events_topic" {
  value = google_pubsub_topic.events[local.platform_events_topic].name
}

output "agent_service_urls" {
  value       = { for app, service in google_cloud_run_v2_service.agent_services : app => service.uri }
  description = "App name => URL of its agent service."
}

output "agent_services" {
  value       = jsonencode(local.agent_services)
  description = "The value of AGENT_SERVICES for an HTTP service that Terraform does not deploy (a service run on the host): job name => agent service URL."
}

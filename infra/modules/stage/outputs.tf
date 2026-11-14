output "extract_url" {
  value = google_cloud_run_v2_service.extract.uri
}

output "extract_name" {
  value = google_cloud_run_v2_service.extract.name
}

output "agent_events_topic" {
  value = google_pubsub_topic.events[var.agent_events_topic].name
}

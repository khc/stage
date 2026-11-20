output "extract_url" {
  value = module.stage.extract_url
}

output "service_url" {
  value = module.stage.service_url
}

output "agent_job_names" {
  value = module.stage.agent_job_names
}

output "agent_events_topic" {
  value = module.stage.agent_events_topic
}

output "platform_events_topic" {
  value = module.stage.platform_events_topic
}

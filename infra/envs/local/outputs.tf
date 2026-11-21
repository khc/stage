output "extract_url" {
  value = module.stage.extract_url
}

output "service_url" {
  value = module.stage.service_url
}

output "agent_services" {
  value       = module.stage.agent_services
  description = "Set this as AGENT_SERVICES for a service that runs on the host."
}

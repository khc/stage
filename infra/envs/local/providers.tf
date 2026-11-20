provider "google" {
  project = var.project
  region  = var.region

  # Floci does not check credentials; a placeholder token skips ADC lookup.
  access_token = "floci"

  pubsub_custom_endpoint       = "${trimsuffix(var.emulator_url, "/")}/v1/"
  cloud_run_v2_custom_endpoint = "${trimsuffix(var.emulator_url, "/")}/v2/"
}

module "foundation" {
  source = "../../../../modules/gcp-foundation"

  project               = var.project
  region                = var.region
  environment           = "dev"
  subnet_cidr           = var.subnet_cidr
  manage_firestore      = var.manage_firestore
  firestore_database_id = var.firestore_database_id
}

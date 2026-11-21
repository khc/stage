# PostgreSQL for the IMDb datasets (schema in data/schemas/imdb.sql). Cloud SQL is emulated by
# Floci, which runs a Postgres container for the instance, so this exists only in the local env.
resource "google_sql_database_instance" "imdb" {
  name                = "stage--imdb--db-lcl"
  region              = var.region
  database_version    = "POSTGRES_17"
  deletion_protection = false

  settings {
    tier = "db-f1-micro"
  }
}

# No google_sql_database: against Floci the provider creates the database but then fails while it
# waits for the operation (it polls a doubled sql/v1beta4/ path, and no single sql_custom_endpoint
# fits both that call and the database call). Create the database in the instance instead:
#   docker exec floci-gcp-cloudsql-floci-local-stage--imdb--db-lcl psql -U postgres -c 'CREATE DATABASE imdb'

# The knowledge agent reads the IMDb tables as this role; data/schemas/imdb-access.sql (applied by
# scripts/imdb-load.ts) limits it to SELECT.
resource "google_sql_user" "imdb_reader" {
  name     = "imdb_reader"
  instance = google_sql_database_instance.imdb.name
  password = var.imdb_reader_password
}

resource "google_sql_user" "imdb" {
  name     = "imdb"
  instance = google_sql_database_instance.imdb.name
  password = var.imdb_db_password
}

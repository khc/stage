-- Read-only access to the IMDb tables for the role imdb_reader (google_sql_user.imdb_reader in
-- infra/envs/local/imdb.tf), which the knowledge agent connects as. scripts/imdb-load.ts runs this
-- file as postgres in the imdb database; it is safe to run again.
--
-- The role gets SELECT and nothing that writes. Floci gives a new role CREATE on the database and on
-- the public schema, so both are taken back here. TEMPORARY is granted to PUBLIC by default, so it
-- cannot be taken from one role (and the loader's staging tables need it); the agent's read-only
-- transaction is what keeps it from creating temp tables. The role settings below are a second
-- guard, not the enforcement: the privileges are.

DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO imdb_reader', current_database());
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM imdb_reader', current_database());
END
$$;

-- Floci grants the role USAGE and CREATE on the public schema.
REVOKE ALL ON SCHEMA public FROM imdb_reader;
GRANT USAGE ON SCHEMA imdb TO imdb_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA imdb TO imdb_reader;
-- Tables created later by the loading role (a reload after a schema change) stay readable.
ALTER DEFAULT PRIVILEGES FOR ROLE imdb IN SCHEMA imdb GRANT SELECT ON TABLES TO imdb_reader;

ALTER ROLE imdb_reader SET default_transaction_read_only = on;
ALTER ROLE imdb_reader SET statement_timeout = '15s';

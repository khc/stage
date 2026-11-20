-- Indexes for querying the IMDb tables (the agent searches titles and names, and filters by year,
-- votes and genre). scripts/imdb-load.ts creates them after the data is loaded and drops the
-- indexes of a table before it reloads that table, because loading into trigram and genre indexes
-- row by row is far slower than building them afterwards. Every index is named and IF NOT EXISTS:
-- the loader finds the names in this file, and a rerun creates only what is missing.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS title_basics_title_trgm_idx
  ON imdb.title_basics USING gin (primary_title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS title_basics_year_idx ON imdb.title_basics (start_year);
CREATE INDEX IF NOT EXISTS title_basics_genres_idx ON imdb.title_basics USING gin (genres);
CREATE INDEX IF NOT EXISTS title_ratings_votes_idx ON imdb.title_ratings (num_votes);
CREATE INDEX IF NOT EXISTS name_basics_name_trgm_idx
  ON imdb.name_basics USING gin (primary_name gin_trgm_ops);

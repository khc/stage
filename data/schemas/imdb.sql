-- IMDb non-commercial datasets (https://datasets.imdbws.com/), for PostgreSQL.
-- Personal and non-commercial use only: https://developer.imdb.com/non-commercial-datasets/
--
-- One table per file, named after it (title.basics.tsv.gz -> imdb.title_basics). The files are tab
-- separated with a header row, and \N for null. scripts/imdb-load.ts loads them (bun scripts/imdb-load.ts).
--
-- COPY in the default text format would read a backslash as an escape, which corrupts values such as
-- the characters of title.principals (["Paval (\"Pavel\") Pavlovitch"]), and csv mode treats the double
-- quotes in titles as quoting. Load with csv mode and a quote character that never occurs:
--   COPY ... FROM STDIN (FORMAT csv, HEADER, DELIMITER E'\t', QUOTE E'\b', ESCAPE E'\b', NULL '\N')
--
-- Columns that hold lists are text[]. COPY cannot read "a,b" into an array, so those files go through
-- a staging table of text columns and string_to_array. The separator is a comma, except in
-- title.akas (types and attributes), where it is the control character U+0002 (chr(2)).
-- The dataset is not referentially clean (a principal can name a person that is not in
-- name.basics), so there are primary keys but no foreign keys, and only the key columns are NOT NULL.

CREATE SCHEMA IF NOT EXISTS imdb;

-- One row per title: movie, short, series, episode, ...; the other title_* tables join on tconst.
CREATE TABLE imdb.title_basics (
  tconst          text PRIMARY KEY,
  title_type      text,
  primary_title   text,
  original_title  text,
  is_adult        boolean,
  start_year      smallint,
  end_year        smallint,           -- only set for series
  runtime_minutes integer,
  genres          text[]              -- up to three
);

-- Alternative titles per region and language.
CREATE TABLE imdb.title_akas (
  title_id          text NOT NULL,    -- the tconst of title_basics
  ordering          integer NOT NULL,
  title             text,
  region            text,
  language          text,
  types             text[],
  attributes        text[],
  is_original_title boolean,
  PRIMARY KEY (title_id, ordering)
);

-- Directors and writers of a title, as lists of nconst.
CREATE TABLE imdb.title_crew (
  tconst    text PRIMARY KEY,
  directors text[],
  writers   text[]
);

-- Links an episode (tconst) to its series (parent_tconst).
CREATE TABLE imdb.title_episode (
  tconst         text PRIMARY KEY,
  parent_tconst  text,
  season_number  integer,
  episode_number integer
);

-- The main cast and crew of a title, in billing order.
CREATE TABLE imdb.title_principals (
  tconst     text NOT NULL,
  ordering   integer NOT NULL,
  nconst     text,
  category   text,                    -- the role: actor, director, producer, ...
  job        text,
  characters text,                    -- a JSON-style list such as ["Self"], kept as written
  PRIMARY KEY (tconst, ordering)
);

CREATE TABLE imdb.title_ratings (
  tconst         text PRIMARY KEY,
  average_rating real,
  num_votes      integer
);

-- One row per person.
CREATE TABLE imdb.name_basics (
  nconst             text PRIMARY KEY,
  primary_name       text,
  birth_year         smallint,
  death_year         smallint,
  primary_profession text[],          -- up to three
  known_for_titles   text[]           -- tconst values
);

-- Lookups the tables are used for besides their keys: people to titles, series to episodes.
CREATE INDEX title_principals_nconst_idx ON imdb.title_principals (nconst);
CREATE INDEX title_episode_parent_idx ON imdb.title_episode (parent_tconst);

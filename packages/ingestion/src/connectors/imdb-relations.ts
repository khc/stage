import type { LogicalReference } from "./postgres-connector";

// Logical joins for data/schemas/imdb.sql, which intentionally declares primary keys without foreign keys.
export const imdbLogicalReferences: LogicalReference[] = [
  {
    schema: "imdb",
    fromTable: "title_ratings",
    fromColumn: "tconst",
    toTable: "title_basics",
    toColumn: "tconst",
  },
  {
    schema: "imdb",
    fromTable: "title_crew",
    fromColumn: "tconst",
    toTable: "title_basics",
    toColumn: "tconst",
  },
  {
    schema: "imdb",
    fromTable: "title_episode",
    fromColumn: "tconst",
    toTable: "title_basics",
    toColumn: "tconst",
  },
  {
    schema: "imdb",
    fromTable: "title_episode",
    fromColumn: "parent_tconst",
    toTable: "title_basics",
    toColumn: "tconst",
    note: "Links an episode to its parent series",
  },
  {
    schema: "imdb",
    fromTable: "title_principals",
    fromColumn: "tconst",
    toTable: "title_basics",
    toColumn: "tconst",
  },
  {
    schema: "imdb",
    fromTable: "title_principals",
    fromColumn: "nconst",
    toTable: "name_basics",
    toColumn: "nconst",
  },
  {
    schema: "imdb",
    fromTable: "title_akas",
    fromColumn: "title_id",
    toTable: "title_basics",
    toColumn: "tconst",
  },
  {
    schema: "imdb",
    fromTable: "name_basics",
    fromColumn: "known_for_titles",
    toTable: "title_basics",
    toColumn: "tconst",
    note: "Array of tconst values (join with = ANY(known_for_titles))",
  },
];

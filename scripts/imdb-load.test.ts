import { expect, test } from "bun:test";

import { datasets, indexesOf, loadSql, parseOptions } from "./imdb-load";

const schema = await Bun.file(new URL("../data/schemas/imdb.sql", import.meta.url)).text();
const tableBlock = (table: string) =>
  schema.slice(schema.indexOf(`CREATE TABLE imdb.${table} (`)).split(");")[0]!;

test("every IMDb file has a table in data/schemas/imdb.sql with the columns it loads", () => {
  expect(datasets.map(({ file }) => file).toSorted()).toEqual([
    "name.basics",
    "title.akas",
    "title.basics",
    "title.crew",
    "title.episode",
    "title.principals",
    "title.ratings",
  ]);
  for (const { table, columns } of datasets) {
    const block = tableBlock(table);
    expect(block).toContain(`CREATE TABLE imdb.${table}`);
    for (const column of columns) expect(block).toContain(column);
  }
});

test("a file without list columns is copied straight into its table", () => {
  const sql = loadSql(datasets.find(({ file }) => file === "title.ratings")!);

  expect(sql).toStartWith("BEGIN;\nTRUNCATE imdb.title_ratings;\n");
  expect(sql).toContain("COPY imdb.title_ratings FROM STDIN");
  expect(sql).toContain("QUOTE E'\\b'");
  expect(sql).toContain("NULL '\\N'");
  expect(sql).toEndWith("COMMIT;\n");
});

test("list columns are loaded through a staging table and split on the file's separator", () => {
  const basics = loadSql(datasets.find(({ file }) => file === "title.basics")!);
  const akas = loadSql(datasets.find(({ file }) => file === "title.akas")!);

  expect(basics).toContain("CREATE TEMP TABLE staging (LIKE imdb.title_basics)");
  expect(basics).toContain("ALTER COLUMN genres TYPE text USING genres::text");
  expect(basics).toContain("string_to_array(genres, ',')");
  expect(basics).toContain("INSERT INTO imdb.title_basics SELECT tconst, title_type,");
  // title.akas separates the values of types and attributes with the control character U+0002.
  expect(akas).toContain("string_to_array(types, chr(2))");
  expect(akas).toContain("string_to_array(attributes, chr(2))");
});

// psql ends a COPY at a line that is exactly \. and then runs what follows as commands, so the
// data must never share a channel with the SQL: the SQL is one -c string and stdin is the data only.
test("the SQL holds no end-of-data marker, since the data arrives on stdin alone", () => {
  for (const dataset of datasets) {
    expect(loadSql(dataset).split("\n")).not.toContain("\\.");
  }
});

test("options default to the Floci instance and reject unknown datasets and unsafe names", () => {
  expect(parseOptions([])).toMatchObject({
    container: "floci-gcp-cloudsql-floci-local-imdb",
    user: "imdb",
    db: "imdb",
    url: "https://datasets.imdbws.com",
  });
  expect(parseOptions([]).only).toHaveLength(7);
  expect(parseOptions(["--only", "title.ratings,name.basics"]).only.map((d) => d.file)).toEqual([
    "title.ratings",
    "name.basics",
  ]);
  expect(() => parseOptions(["--only", "title.nope"])).toThrow("Unknown dataset: title.nope");
  expect(() => parseOptions(["--db", "x; DROP DATABASE y"])).toThrow("--db");
});

test("--no-data runs only the database steps and cannot be combined with --only", () => {
  expect(parseOptions([]).noData).toBe(false);
  expect(parseOptions(["--no-data"]).noData).toBe(true);
  expect(() => parseOptions(["--no-data", "--only", "title.ratings"])).toThrow(
    "--no-data cannot be combined with --only",
  );
});

test("the access file gives imdb_reader read access and nothing that writes", async () => {
  const access = await Bun.file(new URL("../data/schemas/imdb-access.sql", import.meta.url)).text();
  const statements = access
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  expect(statements).toContain("GRANT SELECT ON ALL TABLES IN SCHEMA imdb TO imdb_reader");
  expect(statements).toContain("GRANT USAGE ON SCHEMA imdb TO imdb_reader");
  expect(statements).toContain("ALTER ROLE imdb_reader SET default_transaction_read_only = on");
  // Floci grants a new role CREATE on the database and on the public schema; both are taken back.
  expect(statements).toContain("REVOKE CREATE ON DATABASE");
  expect(statements).toContain("REVOKE ALL ON SCHEMA public FROM imdb_reader");
  // CREATE only appears in a REVOKE; nothing else may name a privilege that writes.
  const withoutRevokes = statements.replace(/REVOKE[^;]*;/g, "");
  expect(withoutRevokes).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALL PRIVILEGES)\b/);
});

test("indexes are named, rerunnable, and found with their tables", async () => {
  const sql = await Bun.file(new URL("../data/schemas/imdb-indexes.sql", import.meta.url)).text();

  // Every index statement is IF NOT EXISTS and named, so the loader can drop it by name before a reload.
  const statements = sql.match(/CREATE INDEX[^;]*;/g) ?? [];
  expect(statements).toHaveLength(5);
  for (const statement of statements) expect(statement).toMatch(/CREATE INDEX IF NOT EXISTS \w+/);
  expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  expect(indexesOf(sql)).toEqual([
    { name: "title_basics_title_trgm_idx", table: "title_basics" },
    { name: "title_basics_year_idx", table: "title_basics" },
    { name: "title_basics_genres_idx", table: "title_basics" },
    { name: "title_ratings_votes_idx", table: "title_ratings" },
    { name: "name_basics_name_trgm_idx", table: "name_basics" },
  ]);
  // Only tables that are loaded can have indexes.
  for (const { table } of indexesOf(sql)) expect(datasets.map((d) => d.table)).toContain(table);
});

test("--no-indexes skips the index step", () => {
  expect(parseOptions([]).noIndexes).toBe(false);
  expect(parseOptions(["--no-indexes"]).noIndexes).toBe(true);
});

import { expect, test } from "bun:test";

import { datasets, loadSql, parseOptions } from "./imdb-load";

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

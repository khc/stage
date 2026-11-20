import { describe, expect, test } from "bun:test";

import { createQueryImdb, openImdb, validateSql } from "./imdb";

describe("validateSql", () => {
  test("accepts one SELECT or WITH statement, with or without a trailing semicolon or comments", () => {
    expect(validateSql("SELECT 1")).toBe("SELECT 1");
    expect(validateSql("  select 1 ;  ")).toBe("select 1");
    expect(validateSql("with x as (select 1 as a) select * from x;")).toBe(
      "with x as (select 1 as a) select * from x",
    );
    expect(validateSql("-- the best drama\nSELECT 1")).toContain("SELECT 1");
    expect(validateSql("/* c */ select 1")).toContain("select 1");
  });

  test("rejects an empty query, a second statement and anything that is not a SELECT", () => {
    expect(() => validateSql("   ")).toThrow("empty");
    expect(() => validateSql("SELECT 1; DROP TABLE imdb.title_basics")).toThrow("one statement");
    for (const sql of [
      "INSERT INTO imdb.title_ratings VALUES ('x', 1, 1)",
      "DROP TABLE imdb.title_basics",
      "EXPLAIN SELECT 1",
      "SET statement_timeout = 0",
      "selectx 1",
    ]) {
      expect(() => validateSql(sql)).toThrow("SELECT");
    }
  });
});

describe("createQueryImdb", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ n: i }));

  test("runs the query wrapped in a row cap, with newlines so a trailing comment cannot swallow it", async () => {
    const seen: string[] = [];
    const query = createQueryImdb(async (sql) => {
      seen.push(sql);
      return rows(2);
    });

    expect(await query({ sql: "SELECT 1 AS n -- the first" })).toEqual({
      rows: rows(2),
      truncated: false,
    });
    expect(seen[0]).toBe("SELECT * FROM (\nSELECT 1 AS n -- the first\n) AS q LIMIT 51");
  });

  test("returns at most 50 rows and says when there were more", async () => {
    const query = createQueryImdb(async () => rows(51));
    const result = await query({ sql: "SELECT n FROM x" });

    expect((result as { rows: unknown[] }).rows).toHaveLength(50);
    expect(result).toMatchObject({ truncated: true });
  });

  test("returns a rejected query or a database error as data for the model to correct", async () => {
    const failing = createQueryImdb(async () => {
      throw new Error('relation "imdb.nope" does not exist');
    });

    expect(await failing({ sql: "SELECT * FROM imdb.nope" })).toEqual({
      error: 'relation "imdb.nope" does not exist',
    });
    expect(await failing({ sql: "DELETE FROM imdb.title_basics" })).toMatchObject({
      error: expect.stringContaining("SELECT"),
    });
  });

  test("makes bigint values JSON-safe", async () => {
    const query = createQueryImdb(async () => [{ votes: 2n ** 40n }]);

    expect(await query({ sql: "SELECT count(*) AS votes FROM x" })).toEqual({
      rows: [{ votes: "1099511627776" }],
      truncated: false,
    });
  });
});

describe("openImdb", () => {
  test("connects on the first query, not when it is created", async () => {
    const run = openImdb({});

    await expect(run("SELECT 1")).rejects.toThrow("IMDB_DATABASE_URL");
  });
});

// Needs a Postgres that this process can reach, for example
// `docker run -p 55432:5432 -e POSTGRES_PASSWORD=x postgres:17-alpine` and
// IMDB_TEST_DATABASE_URL=postgres://postgres:x@localhost:55432/postgres.
describe.skipIf(!process.env.IMDB_TEST_DATABASE_URL)("openImdb against Postgres", () => {
  const run = openImdb({ IMDB_DATABASE_URL: process.env.IMDB_TEST_DATABASE_URL }, 500);

  test("runs a SELECT", async () => {
    expect(await run("SELECT 1 AS one")).toEqual([{ one: 1 }]);
  });

  test("refuses a write: the transaction is read only", async () => {
    await expect(run("WITH x AS (SELECT 1) SELECT * INTO imdb_test_copy FROM x")).rejects.toThrow(
      "read-only",
    );
  });

  test("cancels a query that runs longer than the timeout", async () => {
    await expect(run("SELECT pg_sleep(5)")).rejects.toThrow("statement timeout");
  });
});

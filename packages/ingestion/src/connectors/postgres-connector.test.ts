import { expect, test } from "bun:test";

import type { DiscoveryBatch } from "../catalog";
import { imdbLogicalReferences } from "./imdb-relations";
import { createPostgresConnector, type PostgresSqlRunner } from "./postgres-connector";

const fakeRunner = (): PostgresSqlRunner => async (sql) => {
  if (sql.includes("information_schema.tables")) {
    return [
      {
        table_schema: "imdb",
        table_name: "title_basics",
        table_type: "BASE TABLE",
        comment: "One row per title",
      },
      {
        table_schema: "imdb",
        table_name: "title_ratings",
        table_type: "BASE TABLE",
        comment: null,
      },
    ];
  }
  if (sql.includes("information_schema.columns")) {
    return [
      {
        table_schema: "imdb",
        table_name: "title_basics",
        column_name: "tconst",
        ordinal_position: 1,
        data_type: "text",
        udt_name: "text",
        is_nullable: "NO",
        comment: null,
      },
      {
        table_schema: "imdb",
        table_name: "title_basics",
        column_name: "genres",
        ordinal_position: 2,
        data_type: "ARRAY",
        udt_name: "_text",
        is_nullable: "YES",
        comment: null,
      },
      {
        table_schema: "imdb",
        table_name: "title_ratings",
        column_name: "tconst",
        ordinal_position: 1,
        data_type: "text",
        udt_name: "text",
        is_nullable: "NO",
        comment: null,
      },
    ];
  }
  if (sql.includes("'PRIMARY KEY'")) {
    return [
      { table_schema: "imdb", table_name: "title_basics", column_name: "tconst" },
      { table_schema: "imdb", table_name: "title_ratings", column_name: "tconst" },
    ];
  }
  if (sql.includes("'FOREIGN KEY'")) return [];
  if (sql.includes("pg_indexes")) {
    return [
      {
        schemaname: "imdb",
        tablename: "title_basics",
        indexname: "title_basics_pkey",
        indexdef: "CREATE UNIQUE INDEX ...",
      },
    ];
  }
  return [];
};

test("emits source, schema, table, column nodes, CONTAINS and logical REFERENCES edges, and table chunks", async () => {
  const connector = createPostgresConnector({
    source: "postgres:imdb",
    schemas: ["imdb"],
    runSql: fakeRunner(),
    logicalReferences: imdbLogicalReferences,
  });

  const batches: DiscoveryBatch[] = [];
  for await (const batch of connector.discover()) batches.push(batch);

  expect(batches).toHaveLength(2);
  const nodes = batches.flatMap((b) => b.nodes);
  const edges = batches.flatMap((b) => b.edges);
  const chunks = batches.flatMap((b) => b.chunks ?? []);

  expect(nodes.map((n) => `${n.kind}:${n.id}`)).toEqual([
    "source:postgres:imdb",
    "schema:postgres:imdb:imdb",
    "table:postgres:imdb:imdb.title_basics",
    "column:postgres:imdb:imdb.title_basics.tconst",
    "column:postgres:imdb:imdb.title_basics.genres",
    "table:postgres:imdb:imdb.title_ratings",
    "column:postgres:imdb:imdb.title_ratings.tconst",
  ]);
  const genresNode = nodes.find((n) => n.id === "postgres:imdb:imdb.title_basics.genres");
  expect(genresNode?.props).toMatchObject({ dataType: "text[]", primaryKey: false });
  expect(edges).toContainEqual({
    from: "postgres:imdb:imdb.title_ratings.tconst",
    to: "postgres:imdb:imdb.title_basics.tconst",
    type: "REFERENCES",
    props: {
      fromTable: "imdb.title_ratings",
      fromColumn: "tconst",
      toTable: "imdb.title_basics",
      toColumn: "tconst",
      relationType: "logical",
    },
  });
  expect(chunks).toHaveLength(2);
  expect(chunks[0]!.docId).toBe("postgres:imdb:imdb.title_basics");
  expect(chunks[0]!.text).toContain("Table imdb.title_basics: One row per title");
  expect(chunks[0]!.text).toContain("genres (text[])");
});

test("imdbLogicalReferences covers every table and join key in data/schemas/imdb.sql", async () => {
  const schemaSql = await Bun.file(
    new URL("../../../../data/schemas/imdb.sql", import.meta.url),
  ).text();
  for (const ref of imdbLogicalReferences) {
    expect(schemaSql).toContain(`CREATE TABLE imdb.${ref.fromTable}`);
    expect(schemaSql).toContain(`CREATE TABLE imdb.${ref.toTable}`);
    expect(schemaSql).toContain(ref.fromColumn);
    expect(schemaSql).toContain(ref.toColumn);
  }
});

test("emitTableChunks false omits chunks and empty tables yield only source", async () => {
  const connector = createPostgresConnector({
    source: "postgres:empty",
    schemas: ["empty"],
    runSql: async () => [],
    emitTableChunks: false,
  });
  const batches: DiscoveryBatch[] = [];
  for await (const batch of connector.discover()) batches.push(batch);
  expect(batches).toEqual([
    {
      nodes: [
        {
          id: "postgres:empty",
          kind: "source",
          source: "postgres:empty",
          name: "postgres:empty",
          props: { engine: "postgres", schemas: ["empty"] },
        },
      ],
      edges: [],
    },
  ]);
});

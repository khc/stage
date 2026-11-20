import type {
  CatalogEdge,
  CatalogNode,
  Chunk,
  Connector,
  DiscoveryBatch,
  SkippedFile,
} from "../catalog";
import { chunkId, nodeId, sourceId } from "../ids";

export type LogicalReference = {
  schema?: string;
  fromTable: string;
  fromColumn: string;
  toSchema?: string;
  toTable: string;
  toColumn: string;
  note?: string;
};

export type PostgresSqlRunner = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

export type PostgresConnectorOptions = {
  source: string;
  schemas: string[];
  runSql: PostgresSqlRunner;
  logicalReferences?: LogicalReference[];
  emitTableChunks?: boolean;
};

type TableRow = {
  table_schema: string;
  table_name: string;
  table_type: string;
  comment: string | null;
};

type ColumnRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
  ordinal_position: number;
  data_type: string;
  udt_name: string;
  is_nullable: string;
  comment: string | null;
};

type PrimaryKeyRow = {
  table_schema: string;
  table_name: string;
  column_name: string;
};

type ForeignKeyRow = {
  from_schema: string;
  from_table: string;
  from_column: string;
  to_schema: string;
  to_table: string;
  to_column: string;
};

type IndexRow = {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
};

const TABLES_SQL = `
SELECT
  t.table_schema,
  t.table_name,
  t.table_type,
  obj_description(c.oid, 'pg_class') AS comment
FROM information_schema.tables t
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name
WHERE t.table_schema = ANY($1)
ORDER BY t.table_schema, t.table_name`;

const COLUMNS_SQL = `
SELECT
  col.table_schema,
  col.table_name,
  col.column_name,
  col.ordinal_position,
  col.data_type,
  col.udt_name,
  col.is_nullable,
  col_description(c.oid, col.ordinal_position::int) AS comment
FROM information_schema.columns col
LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = col.table_schema
LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = col.table_name
WHERE col.table_schema = ANY($1)
ORDER BY col.table_schema, col.table_name, col.ordinal_position`;

const PRIMARY_KEYS_SQL = `
SELECT
  tc.table_schema,
  tc.table_name,
  kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY'
  AND tc.table_schema = ANY($1)`;

const FOREIGN_KEYS_SQL = `
SELECT
  tc.table_schema AS from_schema,
  tc.table_name AS from_table,
  kcu.column_name AS from_column,
  ccu.table_schema AS to_schema,
  ccu.table_name AS to_table,
  ccu.column_name AS to_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage ccu
  ON tc.constraint_name = ccu.constraint_name
  AND tc.table_schema = ccu.table_schema
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = ANY($1)`;

const INDEXES_SQL = `
SELECT schemaname, tablename, indexname, indexdef
FROM pg_catalog.pg_indexes
WHERE schemaname = ANY($1)
ORDER BY schemaname, tablename, indexname`;

const tableKey = (schema: string, table: string) => `${schema}.${table}`;
const columnKey = (schema: string, table: string, column: string) => `${schema}.${table}.${column}`;

export const createPostgresConnector = ({
  source,
  schemas,
  runSql,
  logicalReferences = [],
  emitTableChunks = true,
}: PostgresConnectorOptions): Connector => {
  const skipped: SkippedFile[] = [];

  return {
    source,
    skipped: () => [...skipped],
    async *discover() {
      const [tables, columns, pks, fks, indexes] = await Promise.all([
        runSql(TABLES_SQL, [schemas]) as Promise<TableRow[]>,
        runSql(COLUMNS_SQL, [schemas]) as Promise<ColumnRow[]>,
        runSql(PRIMARY_KEYS_SQL, [schemas]) as Promise<PrimaryKeyRow[]>,
        runSql(FOREIGN_KEYS_SQL, [schemas]) as Promise<ForeignKeyRow[]>,
        runSql(INDEXES_SQL, [schemas]) as Promise<IndexRow[]>,
      ]);

      const srcId = sourceId(source);
      const schemaSet = new Set(tables.map((t) => t.table_schema));
      const rootNodes: CatalogNode[] = [
        { id: srcId, kind: "source", source, name: source, props: { engine: "postgres", schemas } },
        ...[...schemaSet].map((schemaName): CatalogNode => ({
          id: nodeId(source, schemaName),
          kind: "schema",
          source,
          name: schemaName,
          props: { schema: schemaName },
        })),
      ];
      const rootEdges: CatalogEdge[] = [...schemaSet].map((schemaName) => ({
        from: srcId,
        to: nodeId(source, schemaName),
        type: "CONTAINS",
      }));

      if (tables.length === 0) {
        yield { nodes: rootNodes, edges: rootEdges };
        return;
      }

      const pkSet = new Set(
        pks.map((pk) => columnKey(pk.table_schema, pk.table_name, pk.column_name)),
      );
      const columnsByTable = new Map<string, ColumnRow[]>();
      const knownColumns = new Set<string>();
      for (const col of columns) {
        const key = tableKey(col.table_schema, col.table_name);
        const list = columnsByTable.get(key) ?? [];
        list.push(col);
        columnsByTable.set(key, list);
        knownColumns.add(columnKey(col.table_schema, col.table_name, col.column_name));
      }

      const indexesByTable = new Map<string, IndexRow[]>();
      for (const idx of indexes) {
        const key = tableKey(idx.schemaname, idx.tablename);
        const list = indexesByTable.get(key) ?? [];
        list.push(idx);
        indexesByTable.set(key, list);
      }

      const defaultSchema = schemas[0] ?? "public";
      const refsByFromTable = new Map<string, CatalogEdge[]>();
      const addRefEdge = (
        fromSchema: string,
        fromTable: string,
        fromColumn: string,
        toSchema: string,
        toTable: string,
        toColumn: string,
        relationType: "foreign_key" | "logical",
        note?: string,
      ) => {
        if (
          !knownColumns.has(columnKey(fromSchema, fromTable, fromColumn)) ||
          !knownColumns.has(columnKey(toSchema, toTable, toColumn))
        ) {
          return;
        }
        const key = tableKey(fromSchema, fromTable);
        const list = refsByFromTable.get(key) ?? [];
        list.push({
          from: nodeId(source, columnKey(fromSchema, fromTable, fromColumn)),
          to: nodeId(source, columnKey(toSchema, toTable, toColumn)),
          type: "REFERENCES",
          props: {
            fromTable: tableKey(fromSchema, fromTable),
            fromColumn,
            toTable: tableKey(toSchema, toTable),
            toColumn,
            relationType,
            ...(note && { note }),
          },
        });
        refsByFromTable.set(key, list);
      };

      for (const fk of fks) {
        addRefEdge(
          fk.from_schema,
          fk.from_table,
          fk.from_column,
          fk.to_schema,
          fk.to_table,
          fk.to_column,
          "foreign_key",
        );
      }
      for (const ref of logicalReferences) {
        const fromSchema = ref.schema ?? defaultSchema;
        const toSchema = ref.toSchema ?? fromSchema;
        addRefEdge(
          fromSchema,
          ref.fromTable,
          ref.fromColumn,
          toSchema,
          ref.toTable,
          ref.toColumn,
          "logical",
          ref.note,
        );
      }

      const batches: DiscoveryBatch[] = tables.map((table, i) => {
        const key = tableKey(table.table_schema, table.table_name);
        const tableId = nodeId(source, key);
        const tableCols = columnsByTable.get(key) ?? [];
        const tableIndexes = indexesByTable.get(key) ?? [];
        const tableRefs = refsByFromTable.get(key) ?? [];

        const nodes: CatalogNode[] = [
          ...(i === 0 ? rootNodes : []),
          {
            id: tableId,
            kind: "table",
            source,
            name: table.table_name,
            props: {
              schema: table.table_schema,
              tableType: table.table_type,
              indexes: tableIndexes.map((idx) => idx.indexname),
              ...(table.comment && { comment: table.comment }),
            },
          },
          ...tableCols.map((col): CatalogNode => ({
            id: nodeId(source, columnKey(col.table_schema, col.table_name, col.column_name)),
            kind: "column",
            source,
            name: col.column_name,
            props: {
              table: key,
              dataType:
                col.data_type === "ARRAY" ? `${col.udt_name.replace(/^_/, "")}[]` : col.data_type,
              nullable: col.is_nullable === "YES",
              primaryKey: pkSet.has(columnKey(col.table_schema, col.table_name, col.column_name)),
              ordinal: col.ordinal_position,
              ...(col.comment && { comment: col.comment }),
            },
          })),
        ];

        const edges: CatalogEdge[] = [
          ...(i === 0 ? rootEdges : []),
          { from: nodeId(source, table.table_schema), to: tableId, type: "CONTAINS" },
          ...tableCols.map((col): CatalogEdge => ({
            from: tableId,
            to: nodeId(source, columnKey(col.table_schema, col.table_name, col.column_name)),
            type: "CONTAINS",
          })),
          ...tableRefs,
        ];

        const chunks: Chunk[] | undefined = emitTableChunks
          ? [
              {
                id: chunkId(`${tableId}#summary`, 0),
                docId: tableId,
                sectionId: `${tableId}#summary`,
                sectionPath: key,
                index: 0,
                text: [
                  `Table ${key}${table.comment ? `: ${table.comment}` : ""}`,
                  `Columns: ${tableCols
                    .map((col) => {
                      const type =
                        col.data_type === "ARRAY"
                          ? `${col.udt_name.replace(/^_/, "")}[]`
                          : col.data_type;
                      return `${col.column_name} (${type}${pkSet.has(columnKey(col.table_schema, col.table_name, col.column_name)) ? ", PK" : ""})`;
                    })
                    .join(", ")}`,
                  ...(tableRefs.length > 0
                    ? [
                        `Joins: ${tableRefs
                          .map(
                            (r) =>
                              `${r.props?.fromColumn} -> ${r.props?.toTable}.${r.props?.toColumn}`,
                          )
                          .join("; ")}`,
                      ]
                    : []),
                ].join("\n"),
              },
            ]
          : undefined;

        const batch: DiscoveryBatch = { nodes, edges };
        if (chunks) batch.chunks = chunks;
        return batch;
      });

      yield* batches;
    },
  };
};

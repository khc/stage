// Loads the IMDb non-commercial datasets (https://datasets.imdbws.com/, personal and non-commercial
// use only) into the PostgreSQL behind the Floci Cloud SQL instance `imdb`, using the schema in
// data/schemas/imdb.sql.
//
//   bun scripts/imdb-load.ts [--only title.ratings,name.basics | --no-data] [--no-indexes]
//                            [--container NAME] [--user imdb] [--db imdb]
//                            [--url https://datasets.imdbws.com]
//
// Each file is streamed from the download through gunzip into the stdin of `psql` and loaded in one
// transaction per table, so nothing is kept on disk and an interrupted run leaves the table as it was. A rerun
// replaces the data. The instance publishes no host port, so psql runs inside its container
// (`docker exec`). The database, the schema, the read access of imdb_reader and the indexes are
// created when they are missing; the indexes of a table are dropped before it is reloaded.
import { parseArgs } from "node:util";

export type Dataset = {
  file: string;
  table: string;
  // The columns, in file order.
  columns: string[];
  // Columns that hold a list, and the character that separates its values.
  lists?: { columns: string[]; separator: string };
};

const comma = ",";
// title.akas separates the values of types and attributes with this control character.
const stx = "\u0002";

// Smallest first, so a problem shows up early.
export const datasets: Dataset[] = [
  {
    file: "title.ratings",
    table: "title_ratings",
    columns: ["tconst", "average_rating", "num_votes"],
  },
  {
    file: "title.episode",
    table: "title_episode",
    columns: ["tconst", "parent_tconst", "season_number", "episode_number"],
  },
  {
    file: "title.crew",
    table: "title_crew",
    columns: ["tconst", "directors", "writers"],
    lists: { columns: ["directors", "writers"], separator: comma },
  },
  {
    file: "title.basics",
    table: "title_basics",
    columns: [
      "tconst",
      "title_type",
      "primary_title",
      "original_title",
      "is_adult",
      "start_year",
      "end_year",
      "runtime_minutes",
      "genres",
    ],
    lists: { columns: ["genres"], separator: comma },
  },
  {
    file: "name.basics",
    table: "name_basics",
    columns: [
      "nconst",
      "primary_name",
      "birth_year",
      "death_year",
      "primary_profession",
      "known_for_titles",
    ],
    lists: { columns: ["primary_profession", "known_for_titles"], separator: comma },
  },
  {
    file: "title.akas",
    table: "title_akas",
    columns: [
      "title_id",
      "ordering",
      "title",
      "region",
      "language",
      "types",
      "attributes",
      "is_original_title",
    ],
    lists: { columns: ["types", "attributes"], separator: stx },
  },
  {
    file: "title.principals",
    table: "title_principals",
    columns: ["tconst", "ordering", "nconst", "category", "job", "characters"],
  },
];

// COPY in csv mode with a quote character that never occurs, so that backslashes and double quotes
// (both in the data, for example in the characters of title.principals) stay as they are. \N is null.
const COPY_OPTIONS = String.raw`(FORMAT csv, HEADER, DELIMITER E'\t', QUOTE E'\b', ESCAPE E'\b', NULL '\N')`;

const sqlString = (separator: string) =>
  separator.charCodeAt(0) < 32 ? `chr(${separator.charCodeAt(0)})` : `'${separator}'`;

// The SQL that loads one file, as one string for `psql -c`; the data is the stdin of that psql. They
// must not share a channel: psql ends a COPY at a line that is exactly \. and runs what follows as
// commands, so data inside the SQL stream could run SQL and shell commands. A file with list columns goes through a staging table that holds them as text, because COPY
// cannot read "a,b" into a text[].
export const loadSql = ({ table, columns, lists }: Dataset) => {
  const target = `imdb.${table}`;
  if (!lists) {
    return `BEGIN;\nTRUNCATE ${target};\nCOPY ${target} FROM STDIN ${COPY_OPTIONS};\nCOMMIT;\n`;
  }
  const asText = lists.columns
    .map(
      (column) => `ALTER TABLE staging ALTER COLUMN ${column} TYPE text USING ${column}::text;\n`,
    )
    .join("");
  const select = columns
    .map((column) =>
      lists.columns.includes(column)
        ? `string_to_array(${column}, ${sqlString(lists.separator)})`
        : column,
    )
    .join(", ");
  return (
    `BEGIN;\nTRUNCATE ${target};\nCREATE TEMP TABLE staging (LIKE ${target}) ON COMMIT DROP;\n` +
    `${asText}COPY staging FROM STDIN ${COPY_OPTIONS};\n` +
    `INSERT INTO ${target} SELECT ${select} FROM staging;\nCOMMIT;\n`
  );
};

export type Options = {
  only: Dataset[];
  // Run the database steps (database, schema, access) and load no dataset.
  noData: boolean;
  // Do not create the indexes of data/schemas/imdb-indexes.sql after the loads.
  noIndexes: boolean;
  container: string;
  user: string;
  db: string;
  url: string;
};

const identifier = /^[a-z_][a-z0-9_]*$/;

export const parseOptions = (args: string[]): Options => {
  const { values } = parseArgs({
    args,
    options: {
      only: { type: "string" },
      "no-data": { type: "boolean", default: false },
      "no-indexes": { type: "boolean", default: false },
      container: { type: "string", default: "floci-gcp-cloudsql-floci-local-imdb" },
      user: { type: "string", default: "imdb" },
      db: { type: "string", default: "imdb" },
      url: { type: "string", default: "https://datasets.imdbws.com" },
    },
  });
  for (const name of ["user", "db"] as const) {
    if (!identifier.test(values[name]!)) throw new Error(`--${name} must be a plain identifier`);
  }
  if (values["no-data"] && values.only) throw new Error("--no-data cannot be combined with --only");
  const only = values.only
    ? values.only.split(",").map((file) => {
        const dataset = datasets.find((candidate) => candidate.file === file);
        if (!dataset) throw new Error(`Unknown dataset: ${file}`);
        return dataset;
      })
    : datasets;
  return {
    only,
    noData: values["no-data"]!,
    noIndexes: values["no-indexes"]!,
    container: values.container!,
    user: values.user!,
    db: values.db!,
    url: values.url!.replace(/\/$/, ""),
  };
};

// Runs a command and returns its output; the command's input is a string, a stream or nothing.
const run = async (command: string[], input?: string | ReadableStream<Uint8Array>) => {
  const child = Bun.spawn(command, {
    stdin: typeof input === "string" ? new Blob([input]) : (input ?? "ignore"),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(`${command.slice(0, 2).join(" ")} failed (${code}): ${err.trim()}`);
  return out.trim();
};

const schemaFile = (name: string) =>
  Bun.file(new URL(`../data/schemas/${name}`, import.meta.url)).text();

// The named indexes of data/schemas/imdb-indexes.sql and the tables they are on.
export const indexesOf = (sql: string) =>
  [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)\s+ON imdb\.(\w+)/g)].map(
    ([, name, table]) => ({
      name: name!,
      table: table!,
    }),
  );

const psqlCommand = ({ container }: Options, user: string, db: string, extra: string[] = []) => [
  "docker",
  "exec",
  "-i",
  container,
  "psql",
  "-U",
  user,
  "-d",
  db,
  "-X",
  "-q",
  "-v",
  "ON_ERROR_STOP=1",
  ...extra,
];

const query = (options: Options, user: string, db: string, sql: string) =>
  run(psqlCommand(options, user, db, ["-tA", "-c", sql]));

// The role is created with the instance (Terraform); the database is not, and the role must own it
// to create the schema in it.
const ensureDatabase = async (options: Options) => {
  const { user, db } = options;
  const exists = await query(
    options,
    "postgres",
    "postgres",
    `SELECT 1 FROM pg_database WHERE datname = '${db}'`,
  );
  if (exists) return;
  await query(options, "postgres", "postgres", `CREATE DATABASE ${db} OWNER ${user}`);
  console.log(`created database ${db}`);
};

const ensureSchema = async (options: Options) => {
  const { user, db } = options;
  if (await query(options, user, db, "SELECT to_regclass('imdb.title_basics')")) return;
  const schema = await schemaFile("imdb.sql");
  // One transaction, so a failure leaves no half-applied schema that the next run would skip.
  await run(psqlCommand(options, user, db, ["-1"]), schema);
  console.log("applied data/schemas/imdb.sql");
};

// The reader role is created by Terraform; until it exists there is nothing to grant to.
const readerRole = "imdb_reader";

const ensureAccess = async (options: Options) => {
  const exists = await query(
    options,
    "postgres",
    "postgres",
    `SELECT 1 FROM pg_roles WHERE rolname = '${readerRole}'`,
  );
  if (!exists) {
    console.log(
      `role ${readerRole} does not exist yet (task tf:apply creates it): no access granted`,
    );
    return;
  }
  const access = await schemaFile("imdb-access.sql");
  await run(psqlCommand(options, "postgres", options.db, ["-1"]), access);
  console.log(`granted read access to ${readerRole}`);
};

// Creates the indexes that are missing; one statement at a time, so an interrupted run keeps the
// ones it finished.
const ensureIndexes = async (options: Options) => {
  console.log("creating indexes (this takes a while on the full data)");
  await run(psqlCommand(options, "postgres", options.db), await schemaFile("imdb-indexes.sql"));
  console.log("indexes are in place");
};

const load = async (options: Options, dataset: Dataset) => {
  const started = performance.now();
  // Loading into indexed tables is far slower than building the indexes afterwards.
  for (const { name } of indexesOf(await schemaFile("imdb-indexes.sql")).filter(
    ({ table }) => table === dataset.table,
  )) {
    await query(options, "postgres", options.db, `DROP INDEX IF EXISTS imdb.${name}`);
  }
  const response = await fetch(`${options.url}/${dataset.file}.tsv.gz`);
  if (!response.ok || !response.body) {
    throw new Error(`${dataset.file}: download failed (HTTP ${response.status})`);
  }
  const data = response.body.pipeThrough(new DecompressionStream("gzip"));
  await run(psqlCommand(options, options.user, options.db, ["-c", loadSql(dataset)]), data);
  const rows = await query(
    options,
    options.user,
    options.db,
    `SELECT count(*) FROM imdb.${dataset.table}`,
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  console.log(
    `${dataset.file}: ${Number(rows).toLocaleString("en")} rows into imdb.${dataset.table} (${seconds}s)`,
  );
};

if (import.meta.main) {
  try {
    const options = parseOptions(process.argv.slice(2));
    await ensureDatabase(options);
    await ensureSchema(options);
    await ensureAccess(options);
    if (!options.noData) for (const dataset of options.only) await load(options, dataset);
    if (!options.noIndexes) await ensureIndexes(options);
  } catch (err) {
    console.error(err instanceof Error ? err.message : "Load failed");
    process.exitCode = 1;
  }
}

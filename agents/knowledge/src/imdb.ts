// The query tool of the imdb-assistant agent: the model writes SQL, which runs against the IMDb
// tables as a role that can only read (see data/schemas/imdb-access.sql), in a read-only
// transaction with a timeout. The checks here are the outer layers; the role's privileges are the
// enforcement.

export type ImdbRunner = (sql: string) => Promise<Record<string, unknown>[]>;

const MAX_ROWS = 50;
const TIMEOUT_MS = 10_000;

// One SELECT or WITH statement, after optional comments. Bun.SQL's `unsafe` runs several
// `;`-separated statements, so a second statement must be refused here.
const startsLikeSelect = /^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*(?:select|with)\b/i;

export const validateSql = (sql: string) => {
  const query = sql.trim().replace(/;\s*$/, "").trim();
  if (!query) throw new Error("The query is empty");
  if (query.includes(";")) throw new Error("Send one statement only, without a semicolon inside");
  if (!startsLikeSelect.test(query)) throw new Error("Only SELECT queries are allowed");
  return query;
};

// The query gets its own lines, so that a trailing `-- comment` cannot swallow the closing
// parenthesis. Wrapping also makes Postgres refuse a data-modifying WITH, which must be top level.
const capRows = (query: string) => `SELECT * FROM (\n${query}\n) AS q LIMIT ${MAX_ROWS + 1}`;

// bigint (count(*), sums) is not JSON.
const jsonSafe = (rows: Record<string, unknown>[]) =>
  JSON.parse(
    JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? `${value}` : value)),
  );

// A rejected query and a database error come back as data, so the model can correct its SQL.
export const createQueryImdb =
  (run: ImdbRunner) =>
  async ({ sql }: { sql: string }) => {
    try {
      const rows = await run(capRows(validateSql(sql)));
      return { rows: jsonSafe(rows.slice(0, MAX_ROWS)), truncated: rows.length > MAX_ROWS };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

// Connects on the first query, so importing the agent (and registering it) needs no database.
export const openImdb = (
  env: Record<string, string | undefined>,
  timeoutMs = TIMEOUT_MS,
): ImdbRunner => {
  let sql: Bun.SQL | undefined;
  return async (query) => {
    if (!env.IMDB_DATABASE_URL) throw new Error("IMDB_DATABASE_URL is required to query IMDb");
    sql ??= new Bun.SQL(env.IMDB_DATABASE_URL);
    return sql.begin("read only", async (tx) => {
      await tx.unsafe(`SET LOCAL statement_timeout = ${timeoutMs}`);
      return tx.unsafe(query);
    });
  };
};

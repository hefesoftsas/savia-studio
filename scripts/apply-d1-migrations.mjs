/**
 * Apply reviewed D1 SQL as transactional statement batches. Statement
 * breakpoints preserve trigger bodies; migration ledger updates commit in the
 * same batch. Retired histories require an explicit verified reset.
 * Requires CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID and CLOUDFLARE_API_TOKEN.
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const databaseId = process.env.CLOUDFLARE_DATABASE_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const dryRun = process.argv.includes("--dry-run");
const requestTimeoutMs = 30_000;

if (
  accountId === undefined ||
  databaseId === undefined ||
  token === undefined
) {
  console.error(
    "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID and CLOUDFLARE_API_TOKEN are required",
  );
  process.exit(1);
}

const migrationsFlag = process.argv.indexOf("--migrations-dir");
if (
  migrationsFlag >= 0 &&
  (!process.argv[migrationsFlag + 1] ||
    process.argv[migrationsFlag + 1].startsWith("--"))
)
  throw new Error("--migrations-dir requires a directory");
const migrationsDir =
  migrationsFlag >= 0
    ? resolve(process.argv[migrationsFlag + 1])
    : fileURLToPath(new URL("../packages/db/migrations/", import.meta.url));
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;

class D1StatementRejected extends Error {}

async function query(sql, operation) {
  const signal = AbortSignal.timeout(requestTimeoutMs);
  let response;
  let payload;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        Array.isArray(sql)
          ? { batch: sql.map((statement) => ({ sql: statement })) }
          : { sql },
      ),
      signal,
    });
    payload = await response.json();
  } catch (error) {
    if (signal.aborted)
      throw new Error(`D1 query timed out after 30 seconds (${operation}).`);
    if (response)
      throw new Error(
        `D1 query failed (${response.status}): could not read a JSON response (${operation}).`,
      );
    throw error;
  }
  if (response.ok === false || payload?.success === false) {
    const message = `D1 query failed (${response.status}): ${JSON.stringify(payload?.errors ?? payload)}`;
    if (response.status === 400 || response.status === 409)
      throw new D1StatementRejected(message);
    throw new Error(message);
  }
  if (!Array.isArray(payload?.result) || payload.result.length === 0)
    throw new Error(`D1 query did not return results (${operation}).`);
  if (payload.result.some((statement) => statement?.success === false))
    throw new D1StatementRejected(`D1 statement failed (${operation}).`);
  if (
    Array.isArray(sql) &&
    (payload.result.length !== sql.length ||
      payload.result.some((statement) => statement?.success !== true))
  )
    throw new Error(`D1 batch result is incomplete (${operation}).`);
  return payload.result;
}

function splitStatements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const files = (await readdir(migrationsDir))
  .filter((file) => file.endsWith(".sql"))
  .sort();

if (dryRun) {
  let total = 0;
  for (const file of files) {
    const statements = splitStatements(
      await readFile(join(migrationsDir, file), "utf8"),
    );
    total += statements.length;
  }
  console.log(`${files.length} migrations, ${total} statements`);
  process.exit(0);
}

await query(
  "CREATE TABLE IF NOT EXISTS _savia_migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  "initialize migration history",
);
async function readMigrationHistory() {
  const [appliedRows] = await query(
    "SELECT filename FROM _savia_migrations",
    "read migration history",
  );
  if (!Array.isArray(appliedRows?.results))
    throw new Error("D1 did not return the migration history.");
  const applied = new Set(appliedRows.results.map((row) => row.filename));
  if ([...applied].some((filename) => !files.includes(filename)))
    throw new Error(
      "Database uses the retired migration history. Reset or explicitly reconcile its verified schema before applying the initial baseline.",
    );
  return applied;
}

let applied = await readMigrationHistory();
let pending = 0;
for (const file of files) {
  if (applied.has(file)) continue;
  const statements = splitStatements(
    await readFile(join(migrationsDir, file), "utf8"),
  );
  const escaped = file.replaceAll("'", "''");
  // One transactional D1 batch preserves complete trigger bodies and prevents
  // partially applied initial schemas or bootstrap rows on retry.
  try {
    await query(
      [
        ...statements,
        `INSERT INTO _savia_migrations(filename,applied_at) VALUES ('${escaped}',datetime('now'))`,
      ],
      file,
    );
  } catch (error) {
    if (!(error instanceof D1StatementRejected)) throw error;
    // Another publisher may have committed this file after our history read.
    applied = await readMigrationHistory();
    if (!applied.has(file)) throw error;
    console.log(`Already applied ${file} (confirmed in D1 migration history).`);
    continue;
  }
  pending += 1;
  console.log(`Applied ${file} (${statements.length} statements).`);
}
console.log(
  pending
    ? `Applied ${pending} pending migration(s).`
    : "D1 schema is up to date.",
);

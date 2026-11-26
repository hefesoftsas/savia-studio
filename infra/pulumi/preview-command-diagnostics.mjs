import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { encryptBackup } from "../../scripts/encrypt-flows-backup.mjs";

const run = promisify(execFile);
const recordPath =
  /^command-errors\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const migrationPath = /\/apply-d1-migrations\.mjs:\d+/;
const providerCauses = [
  ["D1_OVERLOADED", /D1 DB is overloaded/i],
  [
    "D1_TRANSIENT_STORAGE_ERROR",
    /Network connection lost|replica disconnected from primary|transient issue on remote node|D1 (?:DB|database).{0,120}(?:restarting|caused object to be reset)/i,
  ],
  ["D1_SQLITE_ERROR", /\bSQLITE_[A-Z_]+\b/],
];

function extractProviderCodes(detail) {
  let errors;
  try {
    errors = JSON.parse(detail);
  } catch {
    return [];
  }
  if (!Array.isArray(errors)) return [];
  return [
    ...new Set(
      errors
        .map((error) => error?.code)
        .filter(
          (code) => Number.isInteger(code) && code >= 1000 && code <= 99999,
        ),
    ),
  ].slice(0, 8);
}

function summarizeMigration(record) {
  const { executable, operation, stderr } = record;
  if (
    executable !== "node" ||
    operation !== "runtime-helper" ||
    typeof stderr !== "string"
  )
    return null;
  if (
    stderr.trim() ===
    "CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_DATABASE_ID and CLOUDFLARE_API_TOKEN are required"
  )
    return { category: "D1_MIGRATION_CONFIGURATION_MISSING" };
  if (!migrationPath.test(stderr)) return null;
  const message =
    stderr.match(
      /^(?:Error|TypeError|D1StatementRejected)(?: \[\w+\])?: (.*)$/m,
    )?.[1] ?? "";
  const http = message.match(/^D1 query failed \(([1-5]\d{2})\): (.*)$/);
  if (http) {
    const detail = http[2];
    const cause = providerCauses.find(([, pattern]) =>
      pattern.test(detail),
    )?.[0];
    return {
      category: "D1_REQUEST_FAILED",
      httpStatus: Number(http[1]),
      providerCodes: extractProviderCodes(detail),
      ...(cause ? { cause } : {}),
    };
  }
  if (message.startsWith("Database uses the retired migration history"))
    return { category: "D1_MIGRATION_HISTORY_MISMATCH" };
  if (message.startsWith("D1 query timed out"))
    return { category: "D1_TIMEOUT" };
  if (message === "fetch failed") {
    const cause = stderr.match(
      /\b(ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_(?:CONNECT_TIMEOUT|SOCKET))\b/,
    )?.[1];
    return { category: "D1_NETWORK_ERROR", ...(cause ? { cause } : {}) };
  }
  if (message.startsWith("D1 statement failed"))
    return { category: "D1_STATEMENT_FAILED" };
  if (
    /^D1 (?:query did not return results|batch result is incomplete|did not return the migration history)/.test(
      message,
    )
  )
    return { category: "D1_RESPONSE_INCOMPLETE" };
  return { category: "D1_MIGRATION_FAILED" };
}

export async function inspectPreviewMigrationFailure({ archive, key }) {
  const directory = await mkdtemp(join(tmpdir(), "savia-preview-diagnostics-"));
  const tar = join(directory, "commands.tar.gz");
  const env = { PATH: process.env.PATH, LC_ALL: "C" };
  try {
    await encryptBackup(archive, tar, key, true);
    const options = { env, maxBuffer: 64 * 1024 };
    const [{ stdout: names }, { stdout: types }] = await Promise.all([
      run("tar", ["-tzf", tar], options),
      run("tar", ["-tvzf", tar], options),
    ]);
    const [root, ...paths] = names.trimEnd().split("\n");
    const [rootType, ...entries] = types.trimEnd().split("\n");
    if (
      root !== "command-errors/" ||
      !rootType.startsWith("d") ||
      paths.length !== entries.length ||
      paths.length < 1 ||
      paths.length > 32 ||
      new Set(paths).size !== paths.length ||
      paths.some(
        (path, index) =>
          !recordPath.test(path) || !entries[index].startsWith("-"),
      )
    )
      throw new Error("Invalid command diagnostics archive");

    const diagnostics = [];
    for (const path of paths) {
      // Read validated regular members into memory without extracting paths.
      const { stdout } = await run("tar", ["-xOzf", tar, "--", path], {
        env,
        maxBuffer: 140 * 1024 * 1024,
      });
      const diagnostic = summarizeMigration(JSON.parse(stdout));
      if (diagnostic) diagnostics.push(diagnostic);
    }
    return diagnostics;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const diagnostics = await inspectPreviewMigrationFailure({
      archive: process.argv[2],
      key: process.env.SAVIA_FLOWS_BACKUP_KEY,
    });
    console.log(JSON.stringify({ diagnostics }));
  } catch {
    console.error(
      "Unable to authenticate or inspect Preview command diagnostics",
    );
    process.exitCode = 1;
  }
}

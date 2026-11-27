import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encryptBackup } from "../../scripts/encrypt-flows-backup.mjs";
import { preserveCommandFailure } from "./command-diagnostics.mjs";
import { inspectPreviewMigrationFailure } from "./preview-command-diagnostics.mjs";

async function fixture(t, stderr, { extraEntry } = {}) {
  const directory = await mkdtemp(
    join(tmpdir(), "preview-command-diagnostics-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await preserveCommandFailure({
    directory,
    executable: "node",
    operation: "runtime-helper",
    error: { code: 1, stderr },
  });
  await extraEntry?.(directory);
  const tar = join(directory, "commands.tar.gz");
  const archive = join(directory, "commands.enc");
  const key = "a".repeat(64);
  execFileSync("tar", ["-czf", tar, "-C", directory, "command-errors"]);
  await encryptBackup(tar, archive, key);
  return { archive, key };
}

test("reports only allowlisted D1 status and error codes from an encrypted command failure", async (t) => {
  const input = await fixture(
    t,
    [
      'D1StatementRejected: D1 query failed (409): [{"code":7500,"message":"SECRET SQL AND DATA"}]',
      "    at query (file:///private/path/scripts/apply-d1-migrations.mjs:73:13)",
    ].join("\n"),
  );
  assert.deepEqual(await inspectPreviewMigrationFailure(input), [
    { category: "D1_REQUEST_FAILED", httpStatus: 409, providerCodes: [7500] },
  ]);
  await assert.rejects(
    inspectPreviewMigrationFailure({ ...input, key: "b".repeat(64) }),
  );
});

test("recognizes migration history mismatches in current and older command failures", async (t) => {
  const messages = [
    "D1 migration history contains migrations missing from this checkout.",
    "Database uses the retired migration history.",
  ];
  for (const message of messages) {
    const input = await fixture(
      t,
      `Error: ${message}\n    at readMigrationHistory (file:///private/path/scripts/apply-d1-migrations.mjs:167:11)`,
    );
    assert.deepEqual(await inspectPreviewMigrationFailure(input), [
      { category: "D1_MIGRATION_HISTORY_MISMATCH" },
    ]);
  }
});

test("rejects links even when the archive is encrypted by a valid key", async (t) => {
  const input = await fixture(t, "unrelated", {
    extraEntry: async (directory) =>
      symlink(
        "/private/path",
        join(
          directory,
          "command-errors",
          `${"0".repeat(8)}-0000-0000-0000-000000000000.json`,
        ),
      ),
  });
  await assert.rejects(
    inspectPreviewMigrationFailure(input),
    /invalid command diagnostics archive/i,
  );
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { migrationChecksumMatches } from "../src/migration-checksum";

const sqlite =
  "ca8b29773ea7b86e43522c94a6b9bc4840605ad739e792c3f3a9ffacc13feb83";
const postgres =
  "aedf9f46d171ccbacadde397f2ecf353dc4619999ded4ad3429a687618860804";
const filename = "0002_bootstrap.sql";

function checksum(directory: string) {
  return createHash("sha256")
    .update(
      readFileSync(
        new URL(
          `../../../packages/db/${directory}/${filename}`,
          import.meta.url,
        ),
      ),
    )
    .digest("hex");
}

it("accepts the previously published bootstrap on each database", () => {
  expect(
    migrationChecksumMatches(filename, checksum("migrations"), sqlite),
  ).toBe(true);
  expect(
    migrationChecksumMatches(filename, checksum("postgres"), postgres),
  ).toBe(true);
});

it("continues to reject unrecognized bytes and different migrations", () => {
  expect(
    migrationChecksumMatches(filename, checksum("migrations"), postgres),
  ).toBe(false);
  expect(
    migrationChecksumMatches(filename, checksum("migrations"), "0".repeat(64)),
  ).toBe(false);
  expect(
    migrationChecksumMatches(
      "0001_initial.sql",
      checksum("migrations"),
      sqlite,
    ),
  ).toBe(false);
});

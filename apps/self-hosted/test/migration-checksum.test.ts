import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { migrationChecksumMatches } from "../src/migration-checksum";

const sqlite =
  "ca8b29773ea7b86e43522c94a6b9bc4840605ad739e792c3f3a9ffacc13feb83";
const postgres =
  "aedf9f46d171ccbacadde397f2ecf353dc4619999ded4ad3429a687618860804";
const filename = "0002_bootstrap.sql";
const mcpFilename = "0048_mcp_collection_sources.sql";
const previousMcpChecksum =
  "eade1a5f6442d75f164eea7fcc88fcfc690671ac2c3c67a25b4b561ba893bd2e";
const previousFlowsChecksums = new Map([
  [
    "0057_savia_flows_collection_events.sql",
    "35aa3bd9d34a2b1f73e704b3f88cb70bcdb699ce9111eca8206a70a30593ade0",
  ],
  [
    "0058_savia_flows_native_causation.sql",
    "b358d11b71f37983bbae64bdc8b764281bd1973b8f1996fc99ef918d41f76a92",
  ],
]);

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

it("accepts only the published PostgreSQL MCP migration revision", () => {
  const current = createHash("sha256")
    .update(
      readFileSync(
        new URL(
          `../../../packages/db/postgres/${mcpFilename}`,
          import.meta.url,
        ),
      ),
    )
    .digest("hex");
  expect(
    migrationChecksumMatches(mcpFilename, current, previousMcpChecksum),
  ).toBe(true);
  expect(migrationChecksumMatches(mcpFilename, current, "0".repeat(64))).toBe(
    false,
  );
});

it("accepts only the published PostgreSQL Flows trigger revisions", () => {
  for (const [filename, previous] of previousFlowsChecksums) {
    const current = createHash("sha256")
      .update(
        readFileSync(
          new URL(`../../../packages/db/postgres/${filename}`, import.meta.url),
        ),
      )
      .digest("hex");
    expect(migrationChecksumMatches(filename, current, previous)).toBe(true);
    expect(migrationChecksumMatches(filename, current, "0".repeat(64))).toBe(
      false,
    );
  }
});

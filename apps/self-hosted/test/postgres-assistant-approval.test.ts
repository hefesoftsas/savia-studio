import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { PendingActionRepository } from "../../api/src/assistant/pending-actions";
import { SaviaAssistantService } from "../../api/src/assistant/service";
import { migratePostgres } from "../src/postgres/migrations.js";
import { postgresTestUrl, withPostgresFixture } from "./postgres-fixture.js";

const coreDirectory = new URL("../../../packages/db/postgres", import.meta.url)
  .pathname;

it.skipIf(!postgresTestUrl)(
  "upgrades legacy approvals and confirms only in the persisted organization",
  async () => {
    await withPostgresFixture(async (db, connectionString) => {
      const baseline = "0001_initial.sql";
      const baselineDirectory = await mkdtemp(
        join(tmpdir(), "savia-approval-"),
      );
      const migration = {
        connectionString,
        schema: "savia_core",
        seed: false,
      } as const;
      const principalId = "assistant-approval-owner";
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      try {
        await copyFile(
          join(coreDirectory, baseline),
          join(baselineDirectory, baseline),
        );
        await migratePostgres({ ...migration, directory: baselineDirectory });
        await db
          .prepare(
            `INSERT INTO assistant_pending_actions
             (id, principal_id, domain, command, input_json, status, created_at, expires_at)
             VALUES (?, ?, 'studio', 'update-record', '{}', 'pending', ?, ?)`,
          )
          .bind(
            "legacy-approval",
            principalId,
            new Date().toISOString(),
            expiresAt,
          )
          .run();
      } finally {
        await rm(baselineDirectory, { recursive: true, force: true });
      }
      await migratePostgres({ ...migration, directory: coreDirectory });

      const callTool = vi.fn(async () => ({
        content: [],
        structuredContent: { updated: true },
      }));
      const mcpClientFactory = vi.fn(async () => ({
        callTool,
        async close() {},
        async tools() {
          throw new Error("Confirmation should not discover tools");
        },
      }));
      const service = new SaviaAssistantService(
        {
          database: db,
          mcpUrl: "http://mcp.test",
          mcpSharedSecret: "test-secret",
        },
        { mcpClientFactory },
      );
      const actor = { principalId, authorization: "Bearer test-user" };
      await expect(
        service.confirmAction({ ...actor, actionId: "legacy-approval" }),
      ).resolves.toEqual({ state: "failed" });
      expect(mcpClientFactory).not.toHaveBeenCalled();

      const repository = new PendingActionRepository(db);
      await repository.issue({
        id: "scoped-approval",
        principalId,
        studioTenantId: 14,
        domain: "studio",
        command: "update-record",
        input: {
          collection: "contacts",
          id: "123",
          data: { status: "active" },
        },
      });
      const confirmation = { ...actor, actionId: "scoped-approval" };
      const results = await Promise.all([
        service.confirmAction(confirmation),
        service.confirmAction(confirmation),
      ]);
      expect(results.map(({ state }) => state).sort()).toEqual([
        "completed",
        "unavailable",
      ]);
      expect(mcpClientFactory).toHaveBeenCalledExactlyOnceWith(
        actor.authorization,
        14,
      );
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(
        await repository.status(confirmation.actionId, principalId),
      ).toMatchObject({
        state: "completed",
        studioTenantId: 14,
      });
    });
  },
);

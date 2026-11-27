import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activePlatformAdministratorCount,
  grantMembership,
  ensureBootstrapAdministrator,
  listGlobalRoles,
  listMemberships,
  removeMembership,
  setPlatformAdministrator,
  setPrincipalActive,
  upsertPrincipal,
} from "../src/auth/identity-repository";
import { beginPrincipalDeletion } from "../src/auth/tenant-membership-invariants";

const migrations = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
).sort(([a], [b]) => a.localeCompare(b));

beforeAll(async () => {
  for (const [, sql] of migrations) {
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((entry) =>
        entry
          .replace(/^--.*$/gm, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean)) {
      await env.DB.exec(statement);
    }
  }
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM identity_tenant_membership");
  await env.DB.exec("DELETE FROM identity_global_role");
  await env.DB.exec("DELETE FROM identity_principal");
  await env.DB.exec(
    "INSERT OR IGNORE INTO tenants (id, id_slug, name, is_active, created_at, updated_at) VALUES (9101, 'tenant-one', 'Tenant One', 1, '2026-09-09', '2026-09-09'), (9102, 'tenant-two', 'Tenant Two', 1, '2026-09-09', '2026-09-09')",
  );
});

async function user() {
  const subject = crypto.randomUUID();
  return upsertPrincipal(env.DB, {
    issuer: "test",
    subject,
    email: `tenant-${subject}@example.test`,
    displayName: "Tenant User",
  });
}

describe("required single tenant membership", () => {
  it("assigns a generic tenant without an agency profile and updates its role", async () => {
    const principal = await user();
    expect(await listMemberships(env.DB, principal.id)).toEqual([]);
    const first = await grantMembership(env.DB, principal.id, 9101, "viewer");
    const updated = await grantMembership(
      env.DB,
      principal.id,
      9101,
      "operator",
    );
    expect(updated).toMatchObject({
      id: first.id,
      tenantId: 9101,
      agencyId: 9101,
      role: "operator",
    });
    expect(await listMemberships(env.DB, principal.id)).toHaveLength(1);
  });

  it("transfers a member directly without an unassigned state", async () => {
    const principal = await user();
    const remainingMember = await user();
    await grantMembership(env.DB, principal.id, 9101, "viewer");
    await grantMembership(env.DB, remainingMember.id, 9101, "tenant_admin");
    await expect(
      grantMembership(env.DB, principal.id, 9102, "operator"),
    ).resolves.toMatchObject({ tenantId: 9102, role: "operator" });
    expect(await listMemberships(env.DB, principal.id)).toEqual([
      expect.objectContaining({ tenantId: 9102, isActive: true }),
    ]);
  });

  const depart = {
    transfer: (id: string) => grantMembership(env.DB, id, 9102, "operator"),
    suspend: (id: string) => setPrincipalActive(env.DB, id, false),
    promote: (id: string) => setPlatformAdministrator(env.DB, id, true),
  };

  it.each([
    { firstAction: "transfer", secondAction: "transfer" },
    { firstAction: "transfer", secondAction: "suspend" },
    { firstAction: "suspend", secondAction: "suspend" },
    { firstAction: "transfer", secondAction: "promote" },
    { firstAction: "suspend", secondAction: "promote" },
    { firstAction: "promote", secondAction: "promote" },
  ] as const)(
    "keeps an active member when $firstAction overlaps with $secondAction",
    async ({ firstAction, secondAction }) => {
      const first = await user();
      const second = await user();
      await grantMembership(env.DB, first.id, 9101, "viewer");
      await grantMembership(env.DB, second.id, 9101, "tenant_admin");

      let checks = 0;
      let release!: () => void;
      const checked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let firstFinished!: () => void;
      const firstWrite = new Promise<void>((resolve) => {
        firstFinished = resolve;
      });
      const prepare = env.DB.prepare.bind(env.DB);
      const intercept = vi
        .spyOn(env.DB, "prepare")
        .mockImplementation((sql) => {
          const statement = prepare(sql);
          if (!sql.endsWith(" AS last_active_member")) return statement;
          return {
            bind: (...args: unknown[]) => ({
              first: async (column?: string) => {
                const result = await statement.bind(...args).first(column);
                if (++checks === 2) release();
                await checked;
                if (args[0] === second.id) await firstWrite;
                return result;
              },
            }),
          } as unknown as D1PreparedStatement;
        });
      try {
        const results = await Promise.allSettled([
          depart[firstAction](first.id).finally(firstFinished),
          depart[secondAction](second.id),
        ]);
        expect(results.map(({ status }) => status)).toEqual([
          "fulfilled",
          "rejected",
        ]);
        const rejected = results.find((result) => result.status === "rejected");
        expect(rejected?.reason).toMatchObject({ code: "LAST_ACTIVE_MEMBER" });
      } finally {
        intercept.mockRestore();
      }
      const sourceMembers = await env.DB.prepare(
        `SELECT m.principal_id FROM identity_tenant_membership m
       JOIN identity_principal p ON p.id=m.principal_id
       WHERE m.tenant_id=9101 AND m.is_active=1 AND p.is_active=1`,
      ).all();
      expect(sourceMembers.results).toEqual([{ principal_id: second.id }]);
      expect(await listGlobalRoles(env.DB, second.id)).toEqual([]);
    },
  );

  it.each([
    {
      id: 9111,
      change: "UPDATE tenants SET is_active=0",
      code: "COMMERCIAL_TENANT_REQUIRED",
    },
    { id: 9112, change: "DELETE FROM tenants", code: "TENANT_NOT_FOUND" },
  ])(
    "keeps the original membership if the destination becomes unavailable ($code)",
    async ({ id, change, code }) => {
      const principal = await user();
      const remainingMember = await user();
      await grantMembership(env.DB, principal.id, 9101, "viewer");
      await grantMembership(env.DB, remainingMember.id, 9101, "tenant_admin");
      await env.DB.prepare(
        "INSERT INTO tenants(id,id_slug,name,created_at,updated_at) VALUES(?,?,?,'now','now')",
      )
        .bind(id, `transfer-destination-${id}`, "Transfer destination")
        .run();
      const prepare = env.DB.prepare.bind(env.DB);
      const intercept = vi
        .spyOn(env.DB, "prepare")
        .mockImplementation((sql) => {
          const statement = prepare(sql);
          if (
            sql !==
            "SELECT tenant_id,is_active FROM identity_tenant_membership WHERE principal_id=?"
          )
            return statement;
          return {
            bind: (...args: unknown[]) => ({
              first: async () => {
                await prepare(`${change} WHERE id=?`).bind(id).run();
                return statement.bind(...args).first();
              },
            }),
          } as unknown as D1PreparedStatement;
        });
      try {
        await expect(
          grantMembership(env.DB, principal.id, id, "operator"),
        ).rejects.toMatchObject({ code });
      } finally {
        intercept.mockRestore();
      }
      expect(await listMemberships(env.DB, principal.id)).toEqual([
        expect.objectContaining({
          tenantId: 9101,
          role: "viewer",
          isActive: true,
        }),
      ]);
    },
  );

  it("rejects removal and deactivation of a commercial tenant's last active member", async () => {
    const principal = await user();
    await grantMembership(env.DB, principal.id, 9101, "tenant_admin");
    await expect(
      removeMembership(env.DB, principal.id, 9101),
    ).rejects.toMatchObject({
      code: "LAST_ACTIVE_MEMBER",
    });
    await expect(
      setPrincipalActive(env.DB, principal.id, false),
    ).rejects.toMatchObject({
      code: "LAST_ACTIVE_MEMBER",
    });
  });

  it("moves a promoted platform administrator to the internal tenant", async () => {
    const principal = await user();
    const remainingMember = await user();
    await grantMembership(env.DB, principal.id, 9101, "tenant_admin");
    await grantMembership(env.DB, remainingMember.id, 9101, "viewer");
    await setPlatformAdministrator(env.DB, principal.id, true);
    expect(await listMemberships(env.DB, principal.id)).toEqual([
      expect.objectContaining({ tenantId: 0, role: "tenant_admin" }),
    ]);
    await expect(
      grantMembership(env.DB, principal.id, 9102, "viewer"),
    ).rejects.toMatchObject({
      code: "PLATFORM_ADMIN_REQUIRES_REVOCATION",
    });
  });

  it("does not advance access policy revisions when admin bootstrap is repeated", async () => {
    const principal = await user();
    const remainingMember = await user();
    await grantMembership(env.DB, principal.id, 9101, "tenant_admin");
    await grantMembership(env.DB, remainingMember.id, 9101, "viewer");
    await setPlatformAdministrator(env.DB, principal.id, true);

    const before = await env.DB.prepare(
      "SELECT revision FROM access_revisions WHERE scope='tenant:0'",
    ).first<{ revision: number }>();
    await ensureBootstrapAdministrator(env.DB, principal.id);
    const after = await env.DB.prepare(
      "SELECT revision FROM access_revisions WHERE scope='tenant:0'",
    ).first<{ revision: number }>();

    expect(after?.revision).toBe(before?.revision);
  });

  it("rejects the internal tenant as an ordinary membership target", async () => {
    const principal = await user();
    await expect(
      grantMembership(env.DB, principal.id, 0, "viewer"),
    ).rejects.toMatchObject({ code: "PLATFORM_TENANT_RESERVED" });
  });

  const removePlatformAccess = {
    suspend: (id: string) => setPrincipalActive(env.DB, id, false),
    delete: (id: string) => beginPrincipalDeletion(env.DB, id),
    revoke: (id: string) => setPlatformAdministrator(env.DB, id, false, 9101),
  };

  it.each([
    ["suspend", "suspend"],
    ["delete", "delete"],
    ["suspend", "delete"],
    ["revoke", "revoke"],
    ["revoke", "suspend"],
    ["revoke", "delete"],
  ] as const)(
    "keeps a platform administrator active when %s overlaps with %s",
    async (firstAction, secondAction) => {
      const principals = [await user(), await user()];
      for (const principal of principals)
        await setPlatformAdministrator(env.DB, principal.id, true);

      const results = await Promise.allSettled([
        removePlatformAccess[firstAction](principals[0].id),
        removePlatformAccess[secondAction](principals[1].id),
      ]);

      expect(results.map(({ status }) => status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejectedIndex = results.findIndex(
        (result) => result.status === "rejected",
      );
      expect(results[rejectedIndex]).toMatchObject({
        reason: { code: "LAST_ACTIVE_PLATFORM_ADMINISTRATOR" },
      });
      const kept = principals[rejectedIndex];
      expect(await activePlatformAdministratorCount(env.DB)).toBe(1);
      expect(await listGlobalRoles(env.DB, kept.id)).toEqual([
        "platform_admin",
      ]);
      expect(await listMemberships(env.DB, kept.id)).toEqual([
        expect.objectContaining({ tenantId: 0, role: "tenant_admin" }),
      ]);
      expect(
        await env.DB.prepare(
          "SELECT is_active,deletion_started_at FROM identity_principal WHERE id=?",
        )
          .bind(kept.id)
          .first(),
      ).toEqual({ is_active: 1, deletion_started_at: null });
    },
  );

  it("keeps the platform membership if revoking the global role fails", async () => {
    const principal = await user();
    const other = await user();
    await setPlatformAdministrator(env.DB, principal.id, true);
    await setPlatformAdministrator(env.DB, other.id, true);
    await env.DB.prepare(
      `CREATE TRIGGER test_revoke_platform_role_failure
       BEFORE DELETE ON identity_global_role
       BEGIN SELECT RAISE(ABORT, 'fixture blocks role removal'); END`,
    ).run();
    try {
      await expect(
        setPlatformAdministrator(env.DB, principal.id, false, 9101, "operator"),
      ).rejects.toThrow("fixture blocks role removal");
    } finally {
      await env.DB.exec("DROP TRIGGER test_revoke_platform_role_failure");
    }
    expect(await listGlobalRoles(env.DB, principal.id)).toEqual([
      "platform_admin",
    ]);
    expect(await listMemberships(env.DB, principal.id)).toEqual([
      expect.objectContaining({ tenantId: 0, role: "tenant_admin" }),
    ]);
  });

  it("rejects missing tenants", async () => {
    const principal = await user();
    await expect(
      grantMembership(env.DB, principal.id, 9199, "viewer"),
    ).rejects.toMatchObject({ code: "TENANT_NOT_FOUND" });
  });
});

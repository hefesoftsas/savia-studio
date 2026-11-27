import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ensureBootstrapAdministrator,
  findPrincipal,
  findPrincipalBySubject,
  grantMembership,
  listGlobalRoles,
  listMemberships,
  readIdentityDirectoryRevision,
  setPlatformAdministrator,
  upsertPrincipal,
} from "../../api/src/auth/identity-repository";
import { deactivateTenantForDeletion } from "../../api/src/tenant-branding/service";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { expect, it, vi } from "vitest";
import { createApplication } from "../src/application";
import { loadConfiguration } from "../src/config";
import { makeConfig } from "../../../packages/studio-shared/src/metadata";
import { migratePostgres } from "../src/postgres/migrations";
import { closePostgresPool, createPostgresPool } from "../src/postgres/pool";
import { postgresTestUrl, withPostgresFixture } from "./postgres-fixture";
function totp(uri: string) {
  const url = new URL(uri);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let buffer = 0,
    bits = 0;
  const bytes: number[] = [];
  for (const character of url.searchParams.get("secret")!.replace(/=+$/, "")) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid TOTP secret");
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(
    BigInt(
      Math.floor(
        Date.now() / 1000 / Number(url.searchParams.get("period") ?? 30),
      ),
    ),
  );
  const hash = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hash.at(-1)! & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000)
    .toString()
    .padStart(6, "0");
}

it.skipIf(!postgresTestUrl)(
  "preserves native tenant/relation metadata and nullable API filters",
  async () => {
    await withPostgresFixture(async (db, url) => {
      const directory = mkdtempSync(join(tmpdir(), "savia-native-api-"));
      const origin = "http://localhost:8080",
        email = "api-native@example.test",
        password = "Native-Api-Password-123!";
      const config = loadConfiguration({
        SAVIA_DATABASE_DRIVER: "postgres",
        SAVIA_POSTGRES_URL: url,
        SAVIA_PUBLIC_ORIGIN: origin,
        SAVIA_DATA_DIR: directory,
        SAVIA_AUTH_SECRET: "native-api-auth-".repeat(4),
        SAVIA_ENCRYPTION_KEY: "native-api-encryption-".repeat(4),
        SAVIA_CAPTCHA_SECRET: "native-api-captcha-".repeat(4),
        SAVIA_BOOTSTRAP_EMAIL: email,
        SAVIA_BOOTSTRAP_PASSWORD: password,
        S3_ENDPOINT: "http://127.0.0.1:1",
        S3_PUBLIC_ENDPOINT: "http://127.0.0.1:1",
        S3_ACCESS_KEY_ID: "test-access",
        S3_SECRET_ACCESS_KEY: "native-api-storage-secret",
      });
      let app: Awaited<ReturnType<typeof createApplication>> | undefined;
      const cookies = new Map<string, string>();
      async function json(
        path: string,
        method = "GET",
        body?: unknown,
        status = 200,
        extra: Record<string, string> = {},
      ) {
        const headers = new Headers({ origin, ...extra });
        headers.set(
          "cookie",
          [...cookies].map(([key, value]) => key + "=" + value).join("; "),
        );
        if (body !== undefined) headers.set("content-type", "application/json");
        const response = await app!.fetch(
          new Request(origin + path, {
            method,
            headers,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(";")[0],
            i = pair.indexOf("=");
          cookies.set(pair.slice(0, i), pair.slice(i + 1));
        }
        expect(
          response.status,
          path + ": " + (await response.clone().text()),
        ).toBe(status);
        return response.json() as Promise<any>;
      }
      try {
        vi.spyOn(nodemailer, "createTransport").mockImplementation(
          () =>
            ({
              sendMail: vi.fn().mockResolvedValue({}),
              close: vi.fn(),
            }) as never,
        );
        app = await createApplication(config, {
          SAVIA_SMTP_HOST: "127.0.0.1",
          SAVIA_SMTP_PORT: "1025",
          SAVIA_SMTP_SECURITY: "plain",
          SAVIA_SMTP_ALLOW_INSECURE: "true",
          SAVIA_SMTP_FROM: "no-reply@savia.test",
        });
        await json("/api/auth/sign-in/email", "POST", { email, password });
        const enrollment = await json("/api/auth/two-factor/enable", "POST", {
          password,
          method: "totp",
        });
        await json("/api/auth/two-factor/verify-totp", "POST", {
          code: totp(enrollment.totpURI),
        });
        const tenant = (
          await json(
            "/v1/tenants",
            "POST",
            {
              name: "Native API Tenant",
              idSlug: "native-api-tenant",
              isActive: true,
              initialUser: {
                email: "tenant-user@example.test",
                firstName: "Tenant",
                lastName: "User",
                role: "tenant_admin",
                temporaryPassword: "Native-Tenant-Password-123!",
              },
            },
            201,
          )
        ).data;
        expect(tenant).toMatchObject({
          idSlug: "native-api-tenant",
          name: "Native API Tenant",
          isActive: true,
          kind: "commercial",
          agencyId: null,
        });
        expect(tenant.id).toBeTypeOf("number");
        expect(tenant.createdAt).toBeTypeOf("string");
        expect(tenant.updatedAt).toBeTypeOf("string");
        expect((await json("/v1/tenants")).data).toEqual(
          expect.arrayContaining([expect.objectContaining(tenant)]),
        );
        expect((await json(`/v1/tenants/${tenant.id}`)).data).toEqual(tenant);
        expect(
          (
            await json("/v1/tenants/current", "GET", undefined, 200, {
              "x-savia-tenant-slug": tenant.idSlug,
            })
          ).data,
        ).toMatchObject({
          id: tenant.id,
          slug: tenant.idSlug,
          name: tenant.name,
          isDedicated: true,
        });
        const base = "/v1/studio/0/api";
        for (const name of ["source_items", "target_items"])
          await json(
            base + "/objects",
            "POST",
            {
              name,
              label: name,
              config: makeConfig({ name: { type: "Textbox", label: "Name" } }),
            },
            201,
          );
        const definition = {
          sourceObject: "source_items",
          targetObject: "target_items",
          sourceLabel: "Sources",
          targetLabel: "Targets",
          cardinality: "one-to-many",
          sourceField: "id",
          targetField: "id",
          sourceDisplayField: "name",
          targetDisplayField: "name",
          storage: "local",
        };
        const relation = (
          await json(base + "/collection-relations", "POST", definition, 201)
        ).data;
        expect((await json(base + "/collection-relations")).data).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: relation.id,
              ...definition,
              version: 1,
            }),
          ]),
        );
        const noFilters = await json("/v1/access-control/audit?scope=platform");
        expect(noFilters.data).toBeInstanceOf(Array);
        const filtered = await json(
          "/v1/access-control/audit?scope=platform&action=role.saved&actorId=missing&targetId=missing&from=2020-01-01T00%3A00%3A00.000Z&to=2099-01-01T00%3A00%3A00.000Z",
        );
        expect(filtered.data).toEqual([]);
        const global = await json("/v1/access-control/members?scope=platform");
        expect(global.members).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ email, displayName: expect.any(String) }),
          ]),
        );
        const scoped = await json(
          `/v1/access-control/members?scope=tenant:${tenant.id}`,
        );
        expect(scoped.members).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              email: "tenant-user@example.test",
              displayName: "Tenant User",
            }),
          ]),
        );
        const scope = `tenant:${tenant.id}`;
        const rolesPath = "/v1/access-control/roles";
        const roleState = await json(rolesPath + "?scope=" + scope);
        const input = {
          scope,
          name: "native_role",
          label: "Native role",
          description: "Native permission contract",
          enabled: true,
          expectedRevision: roleState.revision,
          grants: [],
        };
        const role = await json(rolesPath, "POST", input, 201);
        expect(role.revision).toBe(roleState.revision + 1);
        const updated = await json(rolesPath + "/" + role.id, "PATCH", {
          ...input,
          label: "Updated native role",
          expectedRevision: role.revision,
        });
        expect(updated.revision).toBe(role.revision + 1);
        await json(
          rolesPath + "/" + role.id,
          "PATCH",
          { ...input, label: "Stale write", expectedRevision: role.revision },
          409,
        );
        const principal = scoped.members.find(
          (member: any) => member.email === "tenant-user@example.test",
        );
        const assignmentPath = "/v1/access-control/assignments/" + principal.id;
        const assigned = await json(assignmentPath, "PUT", {
          scope,
          roleIds: [role.id],
          expectedRevision: updated.revision,
        });
        expect(assigned.revision).toBe(updated.revision + 1);
        expect(await json(assignmentPath + "?scope=" + scope)).toMatchObject({
          revision: assigned.revision,
          roleIds: [role.id],
        });
        await json(
          assignmentPath,
          "PUT",
          { scope, roleIds: [], expectedRevision: updated.revision },
          409,
        );
        const committed = await json(rolesPath + "?scope=" + scope);
        expect(committed.roles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: role.id,
              label: "Updated native role",
            }),
          ]),
        );
        const audit = await json("/v1/access-control/audit?scope=" + scope);
        expect(audit.data.map((entry: any) => entry.action)).toEqual(
          expect.arrayContaining(["role.saved", "assignments.saved"]),
        );
        const brandingPath = `/v1/tenants/${tenant.id}/branding`;
        const branding = (await json(brandingPath)).data;
        expect(branding).toMatchObject({ logoUrl: null, coverUrl: null });
        const saved = (
          await json(brandingPath, "PUT", {
            ...branding,
            displayName: "Native Brand",
            loginTitle: "Welcome",
            primaryColor: "#123456",
          })
        ).data;
        expect(saved).toMatchObject({
          displayName: "Native Brand",
          loginTitle: "Welcome",
          primaryColor: "#123456",
          logoUrl: null,
          coverUrl: null,
          version: branding.version + 1,
        });
        expect((await json(brandingPath)).data).toEqual(saved);
        await expect(
          deactivateTenantForDeletion(db, tenant.id, {
            confirmedName: "Stale name",
          }),
        ).resolves.toBe(false);
        expect((await json(`/v1/tenants/${tenant.id}`)).data.isActive).toBe(
          true,
        );
        await expect(
          deactivateTenantForDeletion(db, tenant.id, {
            confirmedName: tenant.name,
          }),
        ).resolves.toBe(true);
        expect((await json(`/v1/tenants/${tenant.id}`)).data.isActive).toBe(
          false,
        );
        await db
          .prepare(
            "INSERT INTO tenant_deletion_leases(tenant_id,lease_token,lease_until) VALUES(?,'cleanup',?)",
          )
          .bind(tenant.id, Date.now() + 60_000)
          .run();
        const endpoint = `/v1/tenants/${tenant.id}`;
        expect(
          await json(endpoint, "PATCH", { isActive: true }, 409),
        ).toMatchObject({ error: { code: "TENANT_PURGE_IN_PROGRESS" } });
        await db
          .prepare("DELETE FROM tenant_deletion_leases WHERE tenant_id=?")
          .bind(tenant.id)
          .run();
        expect(
          (await json(endpoint, "PATCH", { isActive: true })).data,
        ).toMatchObject({ isActive: true });
      } finally {
        vi.restoreAllMocks();
        await app?.close();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  },
  180_000,
);

it.skipIf(!postgresTestUrl)(
  "rechecks the directory revision after waiting for a concurrent principal deletion",
  async () => {
    await withPostgresFixture(async (db, connectionString) => {
      await migratePostgres({
        connectionString,
        schema: "savia_core",
        directory: fileURLToPath(
          new URL("../../../packages/db/postgres", import.meta.url),
        ),
        seed: false,
      });
      const account = {
        issuer: "test-directory",
        subject: "test-directory-user",
        email: "directory-user@example.test",
        displayName: "Directory User",
      };
      const revision = await readIdentityDirectoryRevision(db);
      const original = await upsertPrincipal(db, account);
      await expect(
        upsertPrincipal(
          db,
          { ...account, displayName: "Current User" },
          revision,
        ),
      ).resolves.toMatchObject({
        id: original.id,
        displayName: "Current User",
      });

      const pool = createPostgresPool({ connectionString, max: 2 });
      const transaction = await pool.connect();
      let syncing: Promise<unknown> | undefined;
      try {
        await transaction.query("BEGIN");
        const backend = await transaction.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        await transaction.query(
          "UPDATE savia_core.identity_directory_revision SET revision=revision+1 WHERE id=1",
        );
        await transaction.query(
          "DELETE FROM savia_core.identity_principal WHERE id=$1",
          [original.id],
        );
        syncing = upsertPrincipal(
          db,
          { ...account, displayName: "Stale User" },
          revision,
        );
        void syncing.catch(() => undefined);
        await expect
          .poll(async () => {
            const result = await pool.query<{ waiting: boolean }>(
              `SELECT EXISTS (
               SELECT 1 FROM pg_stat_activity
               WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))
             ) AS waiting`,
              [backend.rows[0].pid],
            );
            return result.rows[0].waiting;
          })
          .toBe(true);
        await transaction.query("COMMIT");
        await expect(syncing).resolves.toBeUndefined();
        await expect(
          findPrincipalBySubject(db, account.issuer, account.subject),
        ).resolves.toBeUndefined();
      } finally {
        await transaction.query("ROLLBACK");
        await syncing?.catch(() => undefined);
        transaction.release();
        await closePostgresPool(pool);
      }
    });
  },
  30_000,
);

it.skipIf(!postgresTestUrl)(
  "keeps a platform revocation and commercial membership when an explicit grant rolls back",
  async () => {
    await withPostgresFixture(async (db, connectionString) => {
      await migratePostgres({
        connectionString,
        schema: "savia_core",
        directory: fileURLToPath(
          new URL("../../../packages/db/postgres", import.meta.url),
        ),
        seed: true,
      });
      await db
        .prepare(
          "INSERT INTO tenants(id,id_slug,name,created_at,updated_at) VALUES(42,'role-revocation-test','Role revocation test','now','now')",
        )
        .run();
      const createPrincipal = (name: string) =>
        upsertPrincipal(db, {
          issuer: "role-test",
          subject: name,
          email: name + "@example.test",
          displayName: name,
        });
      const target = await createPrincipal("target");
      const administrator = await createPrincipal("administrator");
      const member = await createPrincipal("member");
      await ensureBootstrapAdministrator(db, target.id);
      await ensureBootstrapAdministrator(db, administrator.id);
      await grantMembership(db, member.id, 42, "viewer");
      await setPlatformAdministrator(db, target.id, false, 42, "viewer");
      await expect(ensureBootstrapAdministrator(db, target.id)).resolves.toBe(
        false,
      );

      await db.exec(`CREATE FUNCTION savia_core.reject_platform_role_test() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test refused role grant'; END; $$`);
      await db.exec(`CREATE TRIGGER reject_platform_role_test
        BEFORE INSERT ON savia_core.identity_global_role
        FOR EACH ROW EXECUTE FUNCTION savia_core.reject_platform_role_test()`);
      await expect(
        setPlatformAdministrator(db, target.id, true),
      ).rejects.toThrow("test refused role grant");
      await expect(findPrincipal(db, target.id)).resolves.toMatchObject({
        platformAdminRevoked: true,
      });
      await expect(listGlobalRoles(db, target.id)).resolves.toEqual([]);
      await expect(listMemberships(db, target.id)).resolves.toMatchObject([
        { tenantId: 42, role: "viewer" },
      ]);

      await db.exec(
        "DROP TRIGGER reject_platform_role_test ON savia_core.identity_global_role",
      );
      await setPlatformAdministrator(db, target.id, true);
      await expect(findPrincipal(db, target.id)).resolves.toMatchObject({
        platformAdminRevoked: false,
      });
      await expect(listGlobalRoles(db, target.id)).resolves.toEqual([
        "platform_admin",
      ]);
      await expect(listMemberships(db, target.id)).resolves.toMatchObject([
        { tenantId: 0, role: "tenant_admin" },
      ]);
    });
  },
  30_000,
);

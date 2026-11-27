import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app";
import {
  platformAdministratorAuthenticator,
  agencyAdministratorAuthenticator,
} from "./auth-fixtures";
import type { SaviaRequestService } from "../src/routes/savia-request";
import { tenantPurgePlan } from "../src/routes/tenant-purge";
import type { IdentityUserAdministrator } from "../src/auth/better-auth";
import {
  grantMembership,
  upsertPrincipal,
} from "../src/auth/identity-repository";

const migrations = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, s]) => s);

beforeAll(async () => {
  for (const sql of migrations)
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .replace(/^--.*$/gm, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean))
      await env.DB.exec(statement);
});

let counter = 995000;
async function tenant() {
  const highestId = await env.DB.prepare(
    "SELECT MAX(id) AS id FROM tenants",
  ).first<number>("id");
  const id = (counter = Math.max(counter, highestId ?? 0) + 1),
    slug = "purge-" + id,
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO tenants(id,id_slug,name,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)",
  )
    .bind(id, slug, "Purge agency", now, now)
    .run();
  return id;
}

function purgeReceipt(scope: string) {
  return {
    tenant: scope,
    purged: {
      variables: 0,
      versions: 0,
      runs: 0,
      folders: 0,
      bundles: 0,
      flows: 0,
    },
  };
}

describe("tenant deletion purges Savia Request overlays", () => {
  it("purges the tenant scope after deleting the record", async () => {
    const id = await tenant();
    const fetch = vi.fn(async () =>
      Response.json(purgeReceipt(`tenant:${id}`)),
    );
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
      saviaRequestService: { fetch } as SaviaRequestService,
    });

    const response = await app.request(`https://api.test/v1/tenants/${id}`, {
      method: "DELETE",
    });
    expect(response.status, await response.clone().text()).toBe(204);
    expect(
      await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
        .bind(id)
        .first(),
    ).toBe(null);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      fetch.mock.calls.map(([request]) => [request.method, request.url]),
    ).toEqual([
      [
        "DELETE",
        `https://savia-request.internal/api/admin/tenants/tenant:${id}`,
      ],
    ]);
  });

  it("still deletes the tenant when the purge fails", async () => {
    const id = await tenant();
    const errors: unknown[] = [];
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        errors.push(args);
      });
    try {
      const app = createTestApp({
        auth: platformAdministratorAuthenticator(),
        documents: env.DOCUMENTS,
        saviaRequestService: {
          fetch: () => Promise.reject(new Error("worker caído")),
        },
      });
      const response = await app.request(`https://api.test/v1/tenants/${id}`, {
        method: "DELETE",
      });
      expect(response.status, await response.clone().text()).toBe(204);
      expect(
        await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
          .bind(id)
          .first(),
      ).toBe(null);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it("deletes without purge when the service is unavailable", async () => {
    const id = await tenant();
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
    });
    const response = await app.request(`https://api.test/v1/tenants/${id}`, {
      method: "DELETE",
    });
    expect(response.status, await response.clone().text()).toBe(204);
  });
});

const successfulPurge: SaviaRequestService = {
  fetch: async (request) =>
    Response.json(
      purgeReceipt(new URL(request.url).pathname.split("/").at(-1)!),
    ),
};
const authSettingsRemoved = () =>
  Response.json({
    configured: false,
    googleEnabled: false,
    microsoftEnabled: false,
    microsoftTenantId: "",
    googleAvailable: false,
    microsoftAvailable: false,
    googleCallbackUrl: "",
    microsoftCallbackUrl: "",
  });

it.each([
  { state: "uploading", storageAvailable: true, status: 409 },
  { state: "live", storageAvailable: false, status: 503 },
])(
  "preserves Auth settings when ordinary deletion cannot clean up a $state image",
  async ({ state, storageAvailable, status }) => {
    const id = await tenant();
    const assetId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO tenant_branding_assets(id,tenant_id,kind,object_key,state,content_type,size,created_by,created_at) VALUES(?,?,'logo',?,?,'image/png',1,'test',?)",
    )
      .bind(
        assetId,
        id,
        `tenant-branding/${id}/${assetId}`,
        state,
        new Date().toISOString(),
      )
      .run();
    const authFetch = vi.fn(async () => authSettingsRemoved());
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      documents: storageAvailable ? env.DOCUMENTS : undefined,
      authService: { fetch: authFetch },
      identityBridgeKey: "test-identity-bridge",
    });

    const response = await app.request(`https://api.test/v1/tenants/${id}`, {
      method: "DELETE",
    });

    expect(response.status, await response.clone().text()).toBe(status);
    expect(authFetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
        .bind(id)
        .first("is_active"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT state FROM tenant_branding_assets WHERE id=?",
      )
        .bind(assetId)
        .first("state"),
    ).toBe(state);
  },
);

it.each([
  { activity: 1, phase: "before deactivation" },
  { activity: 0, phase: "before deactivation" },
  { activity: 0, phase: "during Auth cleanup" },
])(
  "preserves a membership assigned $phase and keeps activity $activity",
  async ({ activity, phase }) => {
    const id = await tenant();
    if (!activity) {
      await env.DB.prepare("UPDATE tenants SET is_active=0 WHERE id=?")
        .bind(id)
        .run();
    }
    const principal = await upsertPrincipal(env.DB, {
      issuer: "test",
      subject: crypto.randomUUID(),
      email: `new-member-before-deletion-${id}@example.test`,
      displayName: "Deletion test",
    });
    const grant = () =>
      grantMembership(env.DB, principal.id, id, "viewer", {
        allowInactiveTenant: !activity,
      });
    const cleansAuth = phase === "during Auth cleanup";
    const authFetch = vi.fn(async (request: Request) => {
      if (
        cleansAuth &&
        new URL(request.url).pathname === `/_internal/tenant-email/${id}`
      )
        await grant();
      return authSettingsRemoved();
    });
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
      authService: { fetch: authFetch },
      identityBridgeKey: "test-identity-bridge",
    });
    const prepare = env.DB.prepare.bind(env.DB);
    const intercept = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (
        cleansAuth ||
        !sql.startsWith("UPDATE tenants SET is_active=0 WHERE id=? AND name=")
      )
        return statement;
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            await grant();
            return statement.bind(...args).first();
          },
        }),
      } as unknown as D1PreparedStatement;
    });
    try {
      const response = await app.request(`https://api.test/v1/tenants/${id}`, {
        method: "DELETE",
      });
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "TENANT_CONFLICT" },
      });
    } finally {
      intercept.mockRestore();
    }
    expect(authFetch).toHaveBeenCalledTimes(cleansAuth ? 4 : 0);
    expect(
      await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
        .bind(id)
        .first("is_active"),
    ).toBe(activity);
    expect(
      await env.DB.prepare(
        "SELECT role FROM identity_tenant_membership WHERE tenant_id=? AND principal_id=?",
      )
        .bind(id, principal.id)
        .first("role"),
    ).toBe("viewer");
  },
);

it("rejects reactivation and a new membership while ordinary deletion removes Auth settings", async () => {
  const id = await tenant();
  const endpoint = `https://api.test/v1/tenants/${id}`;
  const principal = await upsertPrincipal(env.DB, {
    issuer: "test",
    subject: crypto.randomUUID(),
    email: "deletion-race@example.test",
    displayName: "Deletion test",
  });
  let reactivation: Response | undefined;
  let assignment: PromiseSettledResult<unknown> | undefined;
  const app = createTestApp({
    auth: platformAdministratorAuthenticator(),
    documents: env.DOCUMENTS,
    authService: {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === `/_internal/tenant-email/${id}`) {
          reactivation = await app.request(endpoint, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ isActive: true }),
          });
          [assignment] = await Promise.allSettled([
            grantMembership(env.DB, principal.id, id, "viewer"),
          ]);
        }
        return authSettingsRemoved();
      },
    },
    identityBridgeKey: "test-identity-bridge",
  });

  const response = await app.request(endpoint, { method: "DELETE" });

  expect(response.status, await response.clone().text()).toBe(204);
  expect(reactivation?.status).toBe(409);
  expect(await reactivation?.json()).toMatchObject({
    error: { code: "TENANT_PURGE_IN_PROGRESS" },
  });
  expect(assignment).toMatchObject({
    status: "rejected",
    reason: { code: "COMMERCIAL_TENANT_REQUIRED" },
  });
});

it.each([true, false])(
  "rejects ordinary deletion while an activity update to %s is synchronizing with Auth",
  async (isActive) => {
    const id = await tenant();
    if (isActive) {
      await env.DB.prepare("UPDATE tenants SET is_active=0 WHERE id=?")
        .bind(id)
        .run();
    }
    const endpoint = `https://api.test/v1/tenants/${id}`;
    let deletion: Response | undefined;
    const app = createTestApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
      authService: {
        fetch: async (request: Request) => {
          if (
            new URL(request.url).pathname ===
            `/_internal/tenant-sso/${id}/activity`
          ) {
            deletion = await app.request(endpoint, { method: "DELETE" });
          }
          return authSettingsRemoved();
        },
      },
      identityBridgeKey: "test-identity-bridge",
    });

    const updated = await app.request(endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive }),
    });

    expect(deletion?.status).toBe(409);
    expect(await deletion?.json()).toMatchObject({
      error: { code: "TENANT_PURGE_IN_PROGRESS" },
    });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await updated.json()).toMatchObject({ data: { isActive } });
    const retry = await app.request(endpoint, { method: "DELETE" });
    expect(retry.status, await retry.clone().text()).toBe(204);
  },
);

function createCascadeApp(options: Parameters<typeof createTestApp>[0] = {}) {
  return createTestApp({
    auth: platformAdministratorAuthenticator(),
    documents: env.DOCUMENTS,
    saviaRequestService: successfulPurge,
    ...options,
  });
}

describe("explicit tenant cascade deletion", () => {
  const cascadeUrl = (id: number, confirmation = "Purge agency") =>
    `https://api.test/v1/tenants/${id}?cascade=true&confirmation=${encodeURIComponent(confirmation)}`;

  it.each([
    "first-administrator transfer",
    "tenant deletion preflight",
    "tenant deletion cleanup",
  ])(
    "rejects the competing operation during an ongoing %s",
    async (firstOperation) => {
      const id = await tenant();
      const members = await Promise.all(
        ["moving", "staying"].map(async (name) => {
          const subject = `purge-transfer-${id}-${name}`;
          const principal = await upsertPrincipal(env.DB, {
            issuer: "savia:better-auth",
            subject,
            email: `${subject}@example.test`,
            displayName: name,
          });
          await grantMembership(env.DB, principal.id, id, "tenant_admin");
          return principal;
        }),
      );
      const moving = members[0];
      const transferFirst = firstOperation === "first-administrator transfer";
      const destination = `Transfer destination ${id}`;
      let conflict: Response | undefined;
      const updateUser = vi.fn(async () => {
        if (transferFirst) conflict = await remove();
        return {};
      });
      const fetch = vi.fn(async () => {
        if (firstOperation === "tenant deletion cleanup")
          conflict = await transfer();
        return Response.json(purgeReceipt(`tenant:${id}`));
      });
      const app = createCascadeApp({
        userAdministrator: {
          issuer: "savia:better-auth",
          updateUser,
        } as unknown as IdentityUserAdministrator,
        saviaRequestService: { fetch },
        documents: {
          async list(options) {
            if (firstOperation === "tenant deletion preflight" && !conflict)
              conflict = await transfer();
            return env.DOCUMENTS.list(options);
          },
          delete: env.DOCUMENTS.delete.bind(env.DOCUMENTS),
        } as R2Bucket,
      });
      const remove = () => app.request(cascadeUrl(id), { method: "DELETE" });
      const transfer = () =>
        app.request("/v1/tenants", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: destination,
            existingMember: { principalId: moving.id, role: "tenant_admin" },
          }),
        });

      const completed = await (transferFirst ? transfer() : remove());
      expect(conflict?.status).toBe(409);
      expect(await conflict?.json()).toMatchObject({
        error: { code: "TENANT_PURGE_IN_PROGRESS" },
      });
      if (transferFirst) {
        expect(completed.status).toBe(201);
        expect(fetch).not.toHaveBeenCalled();
        expect(
          await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
            .bind(id)
            .first("is_active"),
        ).toBe(1);
        expect((await remove()).status).toBe(204);
        expect(
          await env.DB.prepare(
            "SELECT tenants.name FROM identity_tenant_membership JOIN tenants ON tenants.id=identity_tenant_membership.tenant_id WHERE principal_id=?",
          )
            .bind(moving.id)
            .first("name"),
        ).toBe(destination);
      } else {
        expect(completed.status).toBe(204);
        expect(updateUser).not.toHaveBeenCalled();
        expect(
          await env.DB.prepare("SELECT id FROM tenants WHERE name=?")
            .bind(destination)
            .first(),
        ).toBeNull();
      }
    },
  );

  it("returns an upload conflict before removing a tenant or its overlays", async () => {
    const id = await tenant();
    const imageId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO tenant_branding_assets(id,tenant_id,kind,object_key,state,content_type,size,created_by,created_at) VALUES(?,?,'logo',?,'uploading','image/png',1,'test',?)",
    )
      .bind(
        imageId,
        id,
        `tenant-branding/${id}/${imageId}`,
        new Date().toISOString(),
      )
      .run();
    const fetch = vi.fn(successfulPurge.fetch);
    const app = createCascadeApp({ saviaRequestService: { fetch } });

    const response = await app.request(cascadeUrl(id), { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "TENANT_BRANDING_UPLOAD_IN_PROGRESS" },
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
        .bind(id)
        .first("is_active"),
    ).toBe(1);
  });

  it("leaves branding and overlays intact if the name changes before deactivation", async () => {
    const id = await tenant();
    const imageId = crypto.randomUUID();
    const imageKey = `tenant-branding/${id}/${imageId}`;
    await env.DB.prepare(
      "INSERT INTO tenant_branding_assets(id,tenant_id,kind,object_key,state,content_type,size,created_by,created_at) VALUES(?,?,'logo',?,'live','image/png',1,'test',?)",
    )
      .bind(imageId, id, imageKey, new Date().toISOString())
      .run();
    await env.DOCUMENTS.put(imageKey, "image");
    const fetch = vi.fn(successfulPurge.fetch);
    const app = createCascadeApp({ saviaRequestService: { fetch } });
    const prepare = env.DB.prepare.bind(env.DB);
    const spy = vi.spyOn(env.DB, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (
        sql !==
        "SELECT name,purge_token,created_at FROM tenants WHERE id=? AND kind='commercial'"
      )
        return statement;
      return {
        bind: (...args: unknown[]) => ({
          first: async () => {
            const row = await statement.bind(...args).first();
            await prepare("UPDATE tenants SET name=? WHERE id=?")
              .bind("Renamed tenant", id)
              .run();
            return row;
          },
        }),
      } as unknown as D1PreparedStatement;
    });
    try {
      const response = await app.request(cascadeUrl(id), { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "TENANT_CONFIRMATION_REQUIRED" },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DOCUMENTS.head(imageKey)).not.toBeNull();
      expect(
        await prepare("SELECT name,is_active FROM tenants WHERE id=?")
          .bind(id)
          .first(),
      ).toEqual({ name: "Renamed tenant", is_active: 1 });
    } finally {
      spy.mockRestore();
    }
    const retry = await app.request(cascadeUrl(id, "Renamed tenant"), {
      method: "DELETE",
    });
    expect(retry.status, await retry.clone().text()).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.DOCUMENTS.head(imageKey)).toBeNull();
  });

  it("leaves external data intact if the name changes during inventory", async () => {
    const id = await tenant();
    const imageId = crypto.randomUUID();
    const imageKey = `tenant-branding/${id}/${imageId}`;
    await env.DB.prepare(
      "INSERT INTO tenant_branding_assets(id,tenant_id,kind,object_key,state,content_type,size,created_by,created_at) VALUES(?,?,'logo',?,'live','image/png',1,'test',?)",
    )
      .bind(imageId, id, imageKey, new Date().toISOString())
      .run();
    await env.DOCUMENTS.put(imageKey, "image");
    const fetch = vi.fn(successfulPurge.fetch);
    const app = createCascadeApp({ saviaRequestService: { fetch } });
    const list = env.DOCUMENTS.list.bind(env.DOCUMENTS);
    const inventory = vi
      .spyOn(env.DOCUMENTS, "list")
      .mockImplementationOnce(async (options) => {
        const page = await list(options);
        await env.DB.prepare("UPDATE tenants SET name=? WHERE id=?")
          .bind("Renamed during inventory", id)
          .run();
        return page;
      });
    try {
      const response = await app.request(cascadeUrl(id), { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "TENANT_CONFIRMATION_REQUIRED" },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await env.DOCUMENTS.head(imageKey)).not.toBeNull();
      expect(
        await env.DB.prepare(
          "SELECT state FROM tenant_branding_assets WHERE id=?",
        )
          .bind(imageId)
          .first("state"),
      ).toBe("live");
    } finally {
      inventory.mockRestore();
    }
    const retry = await app.request(
      cascadeUrl(id, "Renamed during inventory"),
      {
        method: "DELETE",
      },
    );
    expect(retry.status, await retry.clone().text()).toBe(204);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await env.DOCUMENTS.head(imageKey)).toBeNull();
  });

  it("loads table metadata without individual D1 requests for each table", async () => {
    const id = await tenant();
    let directMetadataReads = 0;
    const db = {
      batch: env.DB.batch.bind(env.DB),
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        if (!/^PRAGMA (table_info|foreign_key_list)\(/i.test(sql))
          return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all") {
              return () => {
                directMetadataReads++;
                return target.all();
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as D1Database;

    await tenantPurgePlan(db, id);

    expect(directMetadataReads).toBe(0);
  });

  it("batches file inventory reads and excludes keys used by another tenant", async () => {
    const id = await tenant();
    const other = await tenant();
    const prefix = `test-inventory/${id}`;
    const owned = `${prefix}/owned`;
    const shared = `${prefix}/shared`;
    const samples = Array.from(
      { length: 100 },
      (_, index) => `${prefix}/sample-${index}`,
    );
    const draft = env.DB.prepare(
      `INSERT INTO studio_file_drafts(id,tenant_id,object_name,field_name,name,mime,size,storage_key,expires_at)
       VALUES(?,?,'items','file','file','text/plain',1,?,'2099-01-01')`,
    );
    await env.DB.batch([
      draft.bind(owned, `tenant:${id}`, owned),
      draft.bind(shared, `tenant:${other}`, shared),
    ]);

    let directFileReads = 0;
    let batchedFileReads = 0;
    let fileReadBatches = 0;
    const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    function watch(statement: D1PreparedStatement): D1PreparedStatement {
      const wrapped = new Proxy(statement, {
        get(target, property, receiver) {
          if (property === "bind")
            return (...values: unknown[]) => watch(target.bind(...values));
          if (property === "all")
            return () => {
              directFileReads++;
              return target.all();
            };
          return Reflect.get(target, property, receiver);
        },
      });
      statements.set(wrapped, statement);
      return wrapped;
    }
    const db = {
      batch: (batch: D1PreparedStatement[]) => {
        const count = batch.filter((statement) =>
          statements.has(statement),
        ).length;
        if (count) {
          fileReadBatches++;
          batchedFileReads += count;
        }
        return env.DB.batch(
          batch.map((statement) => statements.get(statement) ?? statement),
        );
      },
      prepare(sql: string) {
        const statement = env.DB.prepare(sql);
        return /^SELECT .+ AS key FROM /i.test(sql)
          ? watch(statement)
          : statement;
      },
    } as D1Database;

    const plan = await tenantPurgePlan(db, id, [...samples, shared]);

    expect(new Set(plan.keys)).toEqual(new Set([...samples, owned]));
    expect(directFileReads).toBe(0);
    expect(fileReadBatches).toBeGreaterThan(0);
    expect(fileReadBatches).toBeLessThan(batchedFileReads);
  });

  it("requires the current tenant name before removing anything", async () => {
    const id = await tenant();
    const app = createCascadeApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
    });
    const response = await app.request(cascadeUrl(id, "wrong name"), {
      method: "DELETE",
    });
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
        .bind(id)
        .first(),
    ).not.toBeNull();
  });

  it.each(["permanent", "ordinary"] as const)(
    "rejects a simultaneous %s delete while one purge is running",
    async (mode) => {
      const id = await tenant();
      let entered!: () => void;
      let release!: () => void;
      const enteredCleanup = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resumeCleanup = new Promise<void>((resolve) => {
        release = resolve;
      });
      let attempts = 0;
      const fetch = vi.fn(async () => {
        if (++attempts === 1) {
          entered();
          await resumeCleanup;
        }
        return Response.json(purgeReceipt(`tenant:${id}`));
      });
      const app = createCascadeApp({ saviaRequestService: { fetch } });
      const first = app.request(cascadeUrl(id), { method: "DELETE" });
      try {
        await Promise.race([
          enteredCleanup,
          first.then((response) => {
            throw new Error(
              `First purge stopped before cleanup with HTTP ${response.status}`,
            );
          }),
        ]);
        const next = await app.request(
          mode === "permanent"
            ? cascadeUrl(id)
            : `https://api.test/v1/tenants/${id}`,
          { method: "DELETE" },
        );
        expect(next.status, await next.clone().text()).toBe(409);
        expect(await next.json()).toMatchObject({
          error: { code: "TENANT_PURGE_IN_PROGRESS" },
        });
        expect(fetch).toHaveBeenCalledOnce();
        expect(
          await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
            .bind(id)
            .first(),
        ).not.toBeNull();
      } finally {
        release();
        await first;
      }
      expect((await first).status).toBe(204);
      expect(
        await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
          .bind(id)
          .first(),
      ).toBeNull();
    },
  );

  it("reclaims an expired deletion lease after a worker stops", async () => {
    const id = await tenant();
    await env.DB.prepare(
      "INSERT INTO tenant_deletion_leases(tenant_id,lease_token,lease_until) VALUES(?,'expired-worker',?)",
    )
      .bind(id, Date.now() - 1)
      .run();
    const fetch = vi.fn(successfulPurge.fetch);
    const app = createCascadeApp({ saviaRequestService: { fetch } });

    const response = await app.request(cascadeUrl(id), { method: "DELETE" });

    expect(response.status, await response.clone().text()).toBe(204);
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM tenant_deletion_leases WHERE tenant_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
  });

  it("preserves files when the current request loses its deletion lease", async () => {
    const id = await tenant();
    const file = `companion/samples/deletion-lease-${id}.ogg`;
    await env.DOCUMENTS.put(file, "audio", {
      customMetadata: { tenantId: String(id) },
    });
    const deleteFiles = vi.fn(env.DOCUMENTS.delete.bind(env.DOCUMENTS));
    const app = createCascadeApp({
      documents: {
        list: env.DOCUMENTS.list.bind(env.DOCUMENTS),
        delete: deleteFiles,
      } as unknown as R2Bucket,
      saviaRequestService: {
        fetch: async () => {
          await env.DB.prepare(
            "UPDATE tenant_deletion_leases SET lease_token='replacement-worker' WHERE tenant_id=?",
          )
            .bind(id)
            .run();
          return Response.json(purgeReceipt(`tenant:${id}`));
        },
      },
    });

    const response = await app.request(cascadeUrl(id), { method: "DELETE" });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "TENANT_PURGE_IN_PROGRESS" },
    });
    expect(deleteFiles).not.toHaveBeenCalled();
    expect(await env.DOCUMENTS.head(file)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT lease_token FROM tenant_deletion_leases WHERE tenant_id=?",
      )
        .bind(id)
        .first("lease_token"),
    ).toBe("replacement-worker");
  });

  it("removes related records and files while preserving another tenant and shared principals", async () => {
    const id = await tenant(),
      other = await tenant();
    const scope = `tenant:${id}`,
      otherScope = `tenant:${other}`;
    await env.DB.prepare(
      "INSERT INTO identity_principal(id,issuer,subject,email,display_name,is_active,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?)",
    )
      .bind(
        `principal-${id}`,
        "test",
        `principal-${id}`,
        `${id}@test.example`,
        "Shared account",
        "now",
        "now",
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO identity_tenant_membership(id,principal_id,tenant_id,role,is_active,created_at,updated_at) VALUES(?,?,?,'tenant_admin',1,'now','now')",
    )
      .bind(`membership-${id}`, `principal-${id}`, id)
      .run();
    for (const tenantScope of [scope, otherScope]) {
      await env.DB.prepare(
        "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES(?,'items','Items','{}')",
      )
        .bind(tenantScope)
        .run();
      await env.DB.prepare(
        "INSERT INTO studio_records(tenant_id,id,object_name,data) VALUES(?,'record','items','{}')",
      )
        .bind(tenantScope)
        .run();
      await env.DB.prepare(
        "INSERT INTO studio_file_drafts(id,tenant_id,object_name,field_name,name,mime,size,storage_key,expires_at) VALUES(?,?,'items','file','file','text/plain',4,?,'2099-01-01')",
      )
        .bind(
          `draft-${tenantScope}`,
          tenantScope,
          `test-cascade/${tenantScope}/file`,
        )
        .run();
      await env.DOCUMENTS.put(`test-cascade/${tenantScope}/file`, "data");
      const pendingKey = `test-cascade/${tenantScope}/deleted-file`;
      await env.DB.prepare(
        "INSERT INTO studio_file_deletions(storage_key,tenant_id,file_id) VALUES (?,?,'deleted-file')",
      )
        .bind(pendingKey, tenantScope)
        .run();
      await env.DOCUMENTS.put(pendingKey, "pending deletion");
      await env.DB.prepare(
        "INSERT INTO access_revisions(scope,revision) VALUES(?,1) ON CONFLICT(scope) DO NOTHING",
      )
        .bind(tenantScope)
        .run();
    }
    // A restrictive FK is one of the reasons ordinary deletion cannot proceed.
    await env.DB.prepare(
      "INSERT INTO tenant_whatsapp_connections(id,tenant_id,created_by_principal_id,nango_connection_id,nango_integration_id,status,created_at,updated_at) VALUES(?,?,?,'connection','integration','connected','now','now')",
    )
      .bind(`connection-${id}`, id, `principal-${id}`)
      .run();
    const app = createCascadeApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
    });
    expect(
      (
        await app.request(`https://api.test/v1/tenants/${id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
    const response = await app.request(cascadeUrl(id), { method: "DELETE" });
    expect(response.status, await response.clone().text()).toBe(204);
    for (const table of [
      "studio_objects",
      "studio_records",
      "crm_sync_changes",
      "studio_file_drafts",
      "studio_file_deletions",
    ]) {
      expect(
        await env.DB.prepare(`SELECT 1 FROM ${table} WHERE tenant_id=?`)
          .bind(scope)
          .first(),
      ).toBeNull();
    }
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM identity_tenant_membership WHERE tenant_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM tenant_whatsapp_connections WHERE tenant_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM access_revisions WHERE scope=?")
        .bind(scope)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM tenants WHERE id=?").bind(id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM identity_principal WHERE id=?")
        .bind(`principal-${id}`)
        .first(),
    ).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM studio_records WHERE tenant_id=?")
        .bind(otherScope)
        .first(),
    ).not.toBeNull();
    expect(await env.DOCUMENTS.get(`test-cascade/${scope}/file`)).toBeNull();
    expect(
      await env.DOCUMENTS.get(`test-cascade/${otherScope}/file`),
    ).not.toBeNull();
    expect(
      await env.DOCUMENTS.head(`test-cascade/${scope}/deleted-file`),
    ).toBeNull();
    expect(
      await env.DOCUMENTS.head(`test-cascade/${otherScope}/deleted-file`),
    ).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM studio_file_deletions WHERE tenant_id=?",
      )
        .bind(otherScope)
        .first(),
    ).not.toBeNull();
  });

  it("keeps the core data retryable when external cleanup fails", async () => {
    const id = await tenant();
    const app = createCascadeApp({
      auth: platformAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
      saviaRequestService: {
        fetch: async () => new Response("Unavailable", { status: 503 }),
      },
    });
    const response = await app.request(cascadeUrl(id), { method: "DELETE" });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TENANT_REQUEST_CLEANUP_UNAVAILABLE" },
    });
    expect(
      await env.DB.prepare("SELECT 1 FROM tenants WHERE id=?").bind(id).first(),
    ).not.toBeNull();
  });

  it.each(["HTML", "another tenant", "missing counters"] as const)(
    "preserves tenant data when Savia Request returns an invalid receipt (%s)",
    async (scenario) => {
      const id = await tenant();
      const scope = `tenant:${id}`;
      const key = `companion/samples/invalid-purge-receipt-${id}.ogg`;
      await env.DOCUMENTS.put(key, "test audio", {
        customMetadata: { tenantId: String(id) },
      });
      const receipt = purgeReceipt(scope);
      const response =
        scenario === "HTML"
          ? new Response("<html>Unexpected service</html>", {
              headers: { "content-type": "text/html" },
            })
          : Response.json({
              tenant:
                scenario === "another tenant" ? `tenant:${id + 1}` : scope,
              purged: scenario === "missing counters" ? {} : receipt.purged,
            });
      const fetch = vi
        .fn(async () => Response.json(receipt))
        .mockResolvedValueOnce(response);
      const app = createCascadeApp({ saviaRequestService: { fetch } });

      const first = await app.request(cascadeUrl(id), { method: "DELETE" });
      expect(first.status).toBe(503);
      expect(await first.json()).toMatchObject({
        error: { code: "TENANT_REQUEST_CLEANUP_UNAVAILABLE" },
      });
      expect(
        await env.DB.prepare(
          "SELECT is_active,purge_token FROM tenants WHERE id=?",
        )
          .bind(id)
          .first(),
      ).toMatchObject({ is_active: 0, purge_token: expect.any(String) });
      expect(await env.DOCUMENTS.head(key)).not.toBeNull();

      const retry = await app.request(cascadeUrl(id), { method: "DELETE" });
      expect(retry.status, await retry.clone().text()).toBe(204);
      expect(await env.DOCUMENTS.head(key)).toBeNull();
      expect(
        await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
          .bind(id)
          .first(),
      ).toBeNull();
    },
  );
});

describe("tenant purge authorization and storage", () => {
  it("reports a rejected Auth cleanup as retryable and preserves the files", async () => {
    const id = await tenant();
    const key = `companion/samples/auth-cleanup-${id}.ogg`;
    await env.DOCUMENTS.put(key, "audio", {
      customMetadata: { tenantId: String(id) },
    });
    const fetch = vi
      .fn(async () => authSettingsRemoved())
      .mockResolvedValueOnce(
        Response.json({ error: "Forbidden bridge access." }, { status: 403 }),
      );
    const app = createCascadeApp({
      identityBridgeKey: "test-identity-bridge",
      authService: { fetch },
    });
    const url = `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`;
    const response = await app.request(url, { method: "DELETE" });

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "TENANT_AUTH_CLEANUP_UNAVAILABLE" },
    });
    expect(await env.DOCUMENTS.head(key)).not.toBeNull();
    expect(
      await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
        .bind(id)
        .first("is_active"),
    ).toBe(0);

    const reactivate = await app.request(`https://api.test/v1/tenants/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    expect(reactivate.status).toBe(409);
    expect(await reactivate.json()).toMatchObject({
      error: { code: "TENANT_PURGE_IN_PROGRESS" },
    });

    const retry = await app.request(url, { method: "DELETE" });
    expect(retry.status).toBe(204);
    expect(await env.DOCUMENTS.head(key)).toBeNull();
  });

  it.each(["missing", "repeated"] as const)(
    "rejects an incomplete Companion inventory with a %s cursor",
    async (kind) => {
      const id = await tenant();
      const key = `companion/samples/incomplete-${id}.ogg`;
      await env.DOCUMENTS.put(key, "audio", {
        customMetadata: { tenantId: String(id) },
      });
      const object = (await env.DOCUMENTS.head(key))!;
      const incompletePage = {
        objects: [object],
        delimitedPrefixes: [],
        truncated: true,
        cursor: kind === "repeated" ? "page-two" : "",
      } satisfies R2Objects;
      const list = vi
        .fn(env.DOCUMENTS.list.bind(env.DOCUMENTS))
        .mockResolvedValueOnce(incompletePage)
        .mockResolvedValueOnce(incompletePage);
      const deleteFiles = vi.fn(env.DOCUMENTS.delete.bind(env.DOCUMENTS));
      const fetch = vi.fn(successfulPurge.fetch);
      const app = createCascadeApp({
        documents: { list, delete: deleteFiles } as unknown as R2Bucket,
        saviaRequestService: { fetch },
      });
      const response = await app.request(
        `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
        { method: "DELETE" },
      );

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: { code: "TENANT_FILE_CLEANUP_UNAVAILABLE" },
      });
      expect(list).toHaveBeenCalledTimes(kind === "missing" ? 1 : 2);
      expect(fetch).not.toHaveBeenCalled();
      expect(deleteFiles).not.toHaveBeenCalled();
      expect(await env.DOCUMENTS.head(key)).not.toBeNull();
      expect(
        await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
          .bind(id)
          .first("is_active"),
      ).toBe(0);
    },
  );

  it.each(["list", "delete"] as const)(
    "reports a retryable file cleanup error when R2 %s fails",
    async (operation) => {
      const id = await tenant();
      const key = `companion/samples/file-cleanup-${id}.ogg`;
      await env.DOCUMENTS.put(key, "audio", {
        customMetadata: { tenantId: String(id) },
      });
      const storage = {
        list: vi.fn(env.DOCUMENTS.list.bind(env.DOCUMENTS)),
        delete: vi.fn(env.DOCUMENTS.delete.bind(env.DOCUMENTS)),
      };
      storage[operation].mockRejectedValueOnce(
        new Error("Storage unavailable"),
      );
      const app = createCascadeApp({
        documents: storage as unknown as R2Bucket,
      });
      const url = `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`;
      const first = await app.request(url, { method: "DELETE" });

      expect(first.status).toBe(503);
      expect(await first.json()).toMatchObject({
        error: { code: "TENANT_FILE_CLEANUP_UNAVAILABLE" },
      });
      expect(await env.DOCUMENTS.head(key)).not.toBeNull();
      expect(
        await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
          .bind(id)
          .first("is_active"),
      ).toBe(0);

      if (operation === "delete") {
        const endpoint = `https://api.test/v1/tenants/${id}`;
        const edit = await app.request(endpoint, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ isActive: true }),
        });
        expect(edit.status).toBe(409);
        expect(await edit.json()).toMatchObject({
          error: { code: "TENANT_PURGE_IN_PROGRESS" },
        });
        const ordinary = await app.request(endpoint, { method: "DELETE" });
        expect(ordinary.status).toBe(409);
        expect(await ordinary.json()).toMatchObject({
          error: { code: "TENANT_PURGE_IN_PROGRESS" },
        });
      }

      const retry = await app.request(url, { method: "DELETE" });
      expect(retry.status).toBe(204);
      expect(await env.DOCUMENTS.head(key)).toBeNull();
      expect(
        await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
          .bind(id)
          .first(),
      ).toBeNull();
    },
  );

  it("denies tenant administrators the cascade option", async () => {
    const id = await tenant();
    const app = createCascadeApp({
      auth: agencyAdministratorAuthenticator(),
      documents: env.DOCUMENTS,
    });
    const response = await app.request(
      `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT 1 FROM tenants WHERE id=?").bind(id).first(),
    ).not.toBeNull();
  });

  it("deletes tenant Companion audio and notes, preserving personal and other tenant recordings", async () => {
    const id = await tenant();
    const base = `companion/samples/test-${id}/`;
    await env.DOCUMENTS.put(`${base}owned.ogg`, "audio", {
      customMetadata: { tenantId: String(id) },
    });
    await env.DOCUMENTS.put(`${base}owned.notes.json`, "{}");
    await env.DOCUMENTS.put(`${base}personal.ogg`, "personal");
    await env.DOCUMENTS.put(`${base}other.ogg`, "other", {
      customMetadata: { tenantId: String(id + 1) },
    });
    const list = vi.fn((options?: R2ListOptions) =>
      env.DOCUMENTS.list({ ...options, limit: 1 }),
    );
    const app = createCascadeApp({
      documents: {
        list,
        delete: env.DOCUMENTS.delete.bind(env.DOCUMENTS),
      } as unknown as R2Bucket,
    });
    const response = await app.request(
      `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(response.status, await response.clone().text()).toBe(204);
    expect(list.mock.calls.length).toBeGreaterThan(1);
    expect(await env.DOCUMENTS.get(`${base}owned.ogg`)).toBeNull();
    expect(await env.DOCUMENTS.get(`${base}owned.notes.json`)).toBeNull();
    expect(await env.DOCUMENTS.get(`${base}personal.ogg`)).not.toBeNull();
    expect(await env.DOCUMENTS.get(`${base}other.ogg`)).not.toBeNull();
  });
});

it.each(["Savia Request", "Auth"] as const)(
  "rejects a tenant rename and reactivation during %s cleanup",
  async (service) => {
    const id = await tenant();
    const endpoint = `https://api.test/v1/tenants/${id}`;
    const observed: Response[] = [];
    async function editTenant() {
      observed.push(
        await app.request(endpoint, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed tenant", isActive: true }),
        }),
      );
    }
    const app = createCascadeApp({
      ...(service === "Savia Request"
        ? {
            saviaRequestService: {
              fetch: async () => {
                await editTenant();
                return Response.json(purgeReceipt(`tenant:${id}`));
              },
            },
          }
        : {
            identityBridgeKey: "test-identity-bridge",
            authService: {
              fetch: async (request: Request) => {
                if (
                  new URL(request.url).pathname ===
                  `/_internal/tenant-email/${id}`
                )
                  await editTenant();
                return authSettingsRemoved();
              },
            },
          }),
    });
    const response = await app.request(
      `${endpoint}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(observed.map((edit) => edit.status)).toEqual([409]);
    expect(await observed[0].json()).toMatchObject({
      error: { code: "TENANT_PURGE_IN_PROGRESS" },
    });
    expect(response.status, await response.clone().text()).toBe(204);
    expect(
      await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
        .bind(id)
        .first(),
    ).toBeNull();
  },
);

it("keeps the confirmed tenant identity fixed during R2 deletion", async () => {
  const id = await tenant();
  const key = `companion/samples/late-rename-${id}.ogg`;
  await env.DOCUMENTS.put(key, "audio", {
    customMetadata: { tenantId: String(id) },
  });
  let rename: Response | undefined;
  let storedRename: unknown;
  const app = createCascadeApp({
    documents: {
      list: env.DOCUMENTS.list.bind(env.DOCUMENTS),
      delete: async (keys: string | string[]) => {
        await env.DOCUMENTS.delete(keys);
        rename = await app.request(`https://api.test/v1/tenants/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Renamed tenant", isActive: true }),
        });
        try {
          await env.DB.prepare(
            "UPDATE tenants SET name='Renamed tenant' WHERE id=?",
          )
            .bind(id)
            .run();
        } catch (error) {
          storedRename = error;
        }
      },
    } as R2Bucket,
  });
  const response = await app.request(
    `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
    { method: "DELETE" },
  );

  expect(await env.DOCUMENTS.head(key)).toBeNull();
  expect(rename?.status, await rename?.clone().text()).toBe(409);
  expect(await rename?.json()).toMatchObject({
    error: { code: "TENANT_PURGE_IN_PROGRESS" },
  });
  expect(String(storedRename)).toContain("TENANT_PURGE_IN_PROGRESS");
  expect(
    await env.DB.prepare("SELECT id FROM tenants WHERE id=?").bind(id).first(),
  ).toBeNull();
  expect(response.status, await response.clone().text()).toBe(204);
});

it("confirms purge when the final batch commits but its reply is lost", async () => {
  const id = await tenant();
  const key = `companion/samples/lost-purge-reply-${id}.ogg`;
  await env.DOCUMENTS.put(key, "audio", {
    customMetadata: { tenantId: String(id) },
  });
  let loseReply = false;
  const app = createCascadeApp({
    documents: {
      list: env.DOCUMENTS.list.bind(env.DOCUMENTS),
      delete: async (keys: string | string[]) => {
        await env.DOCUMENTS.delete(keys);
        loseReply = true;
      },
    } as R2Bucket,
  });
  const batch = env.DB.batch.bind(env.DB);
  const spy = vi
    .spyOn(env.DB, "batch")
    .mockImplementation(async (statements) => {
      const results = await batch(statements);
      if (loseReply) {
        loseReply = false;
        throw new Error("Lost database reply after tenant deletion");
      }
      return results;
    });
  try {
    const response = await app.request(
      `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(loseReply).toBe(false);
    expect(
      await env.DB.prepare("SELECT id FROM tenants WHERE id=?")
        .bind(id)
        .first(),
    ).toBeNull();
    expect(await env.DOCUMENTS.head(key)).toBeNull();
    expect(response.status, await response.clone().text()).toBe(204);
  } finally {
    spy.mockRestore();
  }
});

it.each(["documents", "saviaRequestService"] as const)(
  "refuses complete deletion when %s is unavailable",
  async (binding) => {
    const id = await tenant();
    const app = createCascadeApp({ [binding]: undefined });
    const response = await app.request(
      `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(503);
    expect(
      await env.DB.prepare("SELECT is_active FROM tenants WHERE id=?")
        .bind(id)
        .first("is_active"),
    ).toBe(1);
  },
);

it.each(["branding", "companion"] as const)(
  "preserves %s storage bytes also referenced by another tenant",
  async (source) => {
    const id = await tenant(),
      other = await tenant();
    const principal = `office-owner-${id}`;
    await env.DB.prepare(
      "INSERT INTO identity_principal(id,issuer,subject,email,display_name,is_active,created_at,updated_at) VALUES(?,?,?,?,'Owner',1,'now','now')",
    )
      .bind(principal, "test", principal, `${principal}@test.example`)
      .run();
    const sharedKey =
        source === "companion"
          ? `companion/samples/shared-${id}.ogg`
          : `tenant-branding/${id}/shared`,
      revisionKey = `office/revision-${id}`;
    if (source === "branding")
      await env.DB.prepare(
        "INSERT INTO tenant_branding_assets(id,tenant_id,kind,object_key,state,content_type,size,created_by,created_at) VALUES(?,?,'logo',?,'live','image/png',4,'test',?)",
      )
        .bind(crypto.randomUUID(), id, sharedKey, new Date().toISOString())
        .run();
    for (const ownerTenant of [id, other]) {
      await env.DB.prepare(
        "INSERT INTO office_documents(id,tenant_id,owner_id,name,mime,size,version,storage_key,created_at,updated_at) VALUES(?,?,?,'Shared','text/plain',4,1,?,'now','now')",
      )
        .bind(
          `office-${ownerTenant}`,
          ownerTenant,
          principal,
          source === "companion" && ownerTenant === id
            ? `office/owned-${id}`
            : sharedKey,
        )
        .run();
    }
    await env.DB.prepare(
      "INSERT INTO office_document_revisions(document_id,version,storage_key,size,created_at) VALUES(?,1,?,4,'now')",
    )
      .bind(`office-${id}`, revisionKey)
      .run();
    await env.DOCUMENTS.put(
      sharedKey,
      "data",
      source === "companion"
        ? {
            customMetadata: { tenantId: String(id) },
          }
        : undefined,
    );
    await env.DOCUMENTS.put(revisionKey, "old");
    const app = createCascadeApp();
    const response = await app.request(
      `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(response.status, await response.clone().text()).toBe(204);
    expect(
      await env.DB.prepare("SELECT 1 FROM office_documents WHERE tenant_id=?")
        .bind(id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM office_document_revisions WHERE document_id=?",
      )
        .bind(`office-${id}`)
        .first(),
    ).toBeNull();
    expect(await env.DOCUMENTS.get(revisionKey)).toBeNull();
    expect(await env.DOCUMENTS.get(sharedKey)).not.toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM tenant_branding_assets WHERE tenant_id=?",
      )
        .bind(id)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM office_documents WHERE tenant_id=?")
        .bind(other)
        .first(),
    ).not.toBeNull();
  },
);

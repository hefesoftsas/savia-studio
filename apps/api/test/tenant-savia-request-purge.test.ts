import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app";
import {
  platformAdministratorAuthenticator,
  agencyAdministratorAuthenticator,
} from "./auth-fixtures";
import type { SaviaRequestService } from "../src/routes/savia-request";
import { tenantPurgePlan } from "../src/routes/tenant-purge";

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
  const id = ++counter,
    slug = "purge-" + id,
    now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO tenants(id,id_slug,name,is_active,created_at,updated_at) VALUES(?,?,?,1,?,?)",
  )
    .bind(id, slug, "Purge agency", now, now)
    .run();
  return id;
}

describe("tenant deletion purges Savia Request overlays", () => {
  it("purges both tenant scopes after deleting the record", async () => {
    const id = await tenant();
    const fetch = vi.fn(async () => Response.json({ tenant: "x", purged: {} }));
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
  fetch: async () => Response.json({ purged: {} }),
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
      if (sql !== "SELECT name FROM tenants WHERE id=? AND kind='commercial'")
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
    expect(
      await env.DB.prepare("SELECT 1 FROM tenants WHERE id=?").bind(id).first(),
    ).not.toBeNull();
  });
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
  "preserves tenant files if its name changes during %s cleanup",
  async (service) => {
    const id = await tenant();
    const storageKey = `renamed-tenant/${id}/file`;
    await env.DB.prepare(
      "INSERT INTO studio_file_drafts(id,tenant_id,object_name,field_name,name,mime,size,storage_key,expires_at) VALUES(?,?,'items','file','file','text/plain',4,?,'2099-01-01')",
    )
      .bind(`rename-draft-${id}`, `tenant:${id}`, storageKey)
      .run();
    await env.DOCUMENTS.put(storageKey, "data");
    const rename = () =>
      env.DB.prepare("UPDATE tenants SET name='Renamed tenant' WHERE id=?")
        .bind(id)
        .run();
    const app = createCascadeApp({
      ...(service === "Savia Request"
        ? {
            saviaRequestService: {
              fetch: async () => {
                await rename();
                return Response.json({ purged: {} });
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
                  await rename();
                return authSettingsRemoved();
              },
            },
          }),
    });
    const response = await app.request(
      `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
      { method: "DELETE" },
    );
    expect(await env.DOCUMENTS.get(storageKey)).not.toBeNull();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "TENANT_CONFIRMATION_REQUIRED" },
    });
    expect(
      await env.DB.prepare("SELECT name FROM tenants WHERE id=?")
        .bind(id)
        .first("name"),
    ).toBe("Renamed tenant");
  },
);

it("asks for a fresh confirmation if the tenant name changes during R2 deletion", async () => {
  const id = await tenant();
  const key = `companion/samples/late-rename-${id}.ogg`;
  await env.DOCUMENTS.put(key, "audio", {
    customMetadata: { tenantId: String(id) },
  });
  const app = createCascadeApp({
    documents: {
      list: env.DOCUMENTS.list.bind(env.DOCUMENTS),
      delete: async (keys: string | string[]) => {
        await env.DOCUMENTS.delete(keys);
        await env.DB.prepare(
          "UPDATE tenants SET name='Renamed tenant' WHERE id=?",
        )
          .bind(id)
          .run();
      },
    } as R2Bucket,
  });
  const response = await app.request(
    `https://api.test/v1/tenants/${id}?cascade=true&confirmation=Purge%20agency`,
    { method: "DELETE" },
  );

  expect(await env.DOCUMENTS.head(key)).toBeNull();
  expect(
    await env.DB.prepare("SELECT name FROM tenants WHERE id=?")
      .bind(id)
      .first("name"),
  ).toBe("Renamed tenant");
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    error: { code: "TENANT_CONFIRMATION_REQUIRED" },
  });
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

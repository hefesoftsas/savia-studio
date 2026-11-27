import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import requestApp from "./index";
import { getFlow, getVariables } from "./store";
import { cacheRequest, type RequestCachePolicy } from "./request-cache";
import type { Env } from "./env";

let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;

const TENANT_A = "tenant:101";
const TENANT_B = "tenant:202";

async function applyMigrations() {
  for (const migration of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync("migrations/" + migration, "utf8")
      .split(";")
      .map((statement) =>
        statement.replace(/^.*--> statement-breakpoint.*$/gm, ""),
      )
      .filter((statement) => statement.trim());
    for (const statement of statements)
      await platform.env.DB.prepare(statement).run();
  }
}

beforeAll(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
  });
  await applyMigrations();
  (platform.env as unknown as Record<string, unknown>).ENCRYPTION_KEY =
    Buffer.alloc(32, 7).toString("base64");
});

beforeEach(async () => {
  await platform.env.DB.exec(
    "DELETE FROM flow_variables; DELETE FROM flows; DELETE FROM flow_versions; DELETE FROM flow_runs; DELETE FROM folders; DELETE FROM installed_bundles; DELETE FROM tenant_flows; DELETE FROM tenant_flow_variables; DELETE FROM tenant_flow_versions; DELETE FROM tenant_flow_runs; DELETE FROM tenant_folders; DELETE FROM tenant_bundles; DELETE FROM bundle_flow_state; DELETE FROM savia_request_cache;",
  );
});

afterAll(async () => {
  await platform?.dispose();
});

function call(method: string, path: string, tenantHeader?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (tenantHeader) headers["x-savia-tenant"] = tenantHeader;
  return requestApp.fetch(
    new Request("https://savia-request.internal" + path, {
      method,
      headers,
      body: JSON.stringify({}),
    }),
    platform.env,
  );
}

async function seedScope(tenant: string) {
  const now = new Date().toISOString();
  const suffix = tenant === TENANT_A ? "a" : "b";
  await platform.env.DB.batch([
    platform.env.DB.prepare(
      "INSERT INTO tenant_flows(tenant_id,flow_id,definition,updated_at) VALUES(?,?,?,?)",
    ).bind(
      tenant,
      "flow-a",
      JSON.stringify({ id: "flow-a", name: "A", steps: [], variables: [] }),
      now,
    ),
    platform.env.DB.prepare(
      "INSERT INTO tenant_flow_variables(tenant_id,flow_id,key,value,secret,updated_at) VALUES(?,?,?,?,?,?)",
    ).bind(tenant, "flow-a", "api_token", "sealed-value", 1, now),
    platform.env.DB.prepare(
      "INSERT INTO tenant_flow_versions(id,tenant_id,flow_id,definition,created_at) VALUES(?,?,?,?,?)",
    ).bind(`v-${suffix}`, tenant, "flow-a", "{}", now),
    platform.env.DB.prepare(
      "INSERT INTO tenant_flow_runs(id,tenant_id,flow_id,version_id,mode,status,created_at,summary) VALUES(?,?,?,?,?,?,?,?)",
    ).bind(`r-${suffix}`, tenant, "flow-a", null, "mock", "success", now, "{}"),
    platform.env.DB.prepare(
      "INSERT INTO tenant_folders(tenant_id,path) VALUES(?,?)",
    ).bind(tenant, "Carpeta"),
    platform.env.DB.prepare(
      "INSERT INTO tenant_bundles(tenant_id,id,version,installed_at) VALUES(?,?,?,?)",
    ).bind(tenant, "example-request-bundle", "1.1.0", now),
  ]);
}

describe("tenant purge", () => {
  it("removes every overlay row of the tenant and reports counts", async () => {
    await seedScope(TENANT_A);
    await seedScope(TENANT_B);
    await platform.env.DB.prepare(
      "INSERT INTO flows(id,definition) VALUES(?,?)",
    )
      .bind(
        "global",
        JSON.stringify({
          id: "global",
          name: "G",
          description: "",
          steps: [
            {
              id: "s1",
              name: "paso",
              url: "https://provider.test/q",
              method: "GET",
              headers: {},
              body: "",
              pre: "",
              post: "",
            },
          ],
          input: {},
          variables: [],
          folderPath: "Base",
        }),
      )
      .run();

    const response = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant: TENANT_A,
      purged: {
        variables: 1,
        versions: 1,
        runs: 1,
        folders: 1,
        bundles: 1,
        bundleFlowStates: 0,
        flows: 1,
        cache: 0,
      },
    });

    expect(await getFlow(platform.env, "flow-a", TENANT_A)).toBeNull();
    expect(await getVariables(platform.env, "flow-a", true, TENANT_A)).toEqual(
      [],
    );
    // Other tenant and the platform catalog are untouched.
    expect(await getFlow(platform.env, "flow-a", TENANT_B)).not.toBeNull();
    expect(await getFlow(platform.env, "global", "")).not.toBeNull();
  });

  it("reports zeros for a tenant without overlays", async () => {
    const response = await call("DELETE", `/api/admin/tenants/${TENANT_B}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      tenant: TENANT_B,
      purged: {
        variables: 0,
        versions: 0,
        runs: 0,
        folders: 0,
        bundles: 0,
        bundleFlowStates: 0,
        flows: 0,
        cache: 0,
      },
    });
  });

  it("removes only the purged tenant's bundle flow tracking", async () => {
    const db = platform.env.DB;
    const insert = db.prepare(
      "INSERT INTO bundle_flow_state(scope,flow_id,bundle_version,content_hash,updated_at) VALUES(?,?,?,?,?)",
    );
    await db.batch(
      ["", TENANT_A, TENANT_B].map((scope) =>
        insert.bind(
          scope,
          "flow-a",
          "1.1.0",
          "a0000001",
          new Date().toISOString(),
        ),
      ),
    );

    const response = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      purged: { bundleFlowStates: 1 },
    });
    const remaining = await db
      .prepare("SELECT scope FROM bundle_flow_state ORDER BY scope")
      .all<{ scope: string }>();
    expect(remaining.results.map(({ scope }) => scope)).toEqual(["", TENANT_B]);
  });

  it("rejects a workspace mutation delivered after its tenant was purged", async () => {
    const admittedAt = Date.now();
    const purge = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
    expect(purge.status).toBe(200);

    const createFolderIn = (tenant: string) =>
      requestApp.fetch(
        new Request("https://savia-request.internal/api/folders", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-savia-tenant": tenant,
            "x-savia-request-started-at": String(admittedAt),
          },
          body: JSON.stringify({ path: "Late" }),
        }),
        platform.env,
      );
    expect((await createFolderIn(TENANT_A)).status).toBe(409);
    expect((await createFolderIn(TENANT_B)).status).toBe(201);
    expect(
      await platform.env.DB.prepare(
        "SELECT path FROM tenant_folders WHERE tenant_id=?",
      )
        .bind(TENANT_A)
        .first(),
    ).toBeNull();
  });

  it("does not create a run when a tenant is purged while its input is being read", async () => {
    await seedScope(TENANT_A);
    const request = new Request(
      "https://savia-request.internal/api/flows/flow-a/runs",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-savia-tenant": TENANT_A,
        },
      },
    );
    const readInput = vi
      .spyOn(request, "text")
      .mockImplementationOnce(async () => {
        // The worker has already read the flow definition at this point.
        const purge = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
        expect(purge.status).toBe(200);
        return JSON.stringify({ input: {}, mode: "mock" });
      });

    const response = await requestApp.fetch(request, platform.env);

    expect(readInput).toHaveBeenCalledOnce();
    expect(response.status).toBe(409);
    expect(
      await platform.env.DB.prepare(
        "SELECT id FROM tenant_flow_runs WHERE tenant_id=?",
      )
        .bind(TENANT_A)
        .first(),
    ).toBeNull();
  });

  it("stops remaining provider calls when a tenant is purged during a run", async () => {
    const flowId = "two-step-flow";
    await platform.env.DB.prepare(
      "INSERT INTO flows(id,definition) VALUES(?,?)",
    )
      .bind(
        flowId,
        JSON.stringify({
          id: flowId,
          name: "Two-step flow",
          description: "",
          input: {},
          variables: [],
          steps: ["first", "second"].map((step) => ({
            id: step,
            name: step,
            url: `https://provider.test/${step}`,
            method: "GET",
            headers: {},
            body: "",
            pre: "",
            post: "",
          })),
        }),
      )
      .run();
    let purgeStatus: number | undefined;
    const provider = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === "/first")
        purgeStatus = (await call("DELETE", `/api/admin/tenants/${TENANT_A}`))
          .status;
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", provider);
    let response: Response;
    try {
      response = await requestApp.fetch(
        new Request(`https://savia-request.internal/api/flows/${flowId}/runs`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-savia-tenant": TENANT_A,
          },
          body: JSON.stringify({ mode: "live", input: {} }),
        }),
        platform.env,
      );
    } finally {
      vi.unstubAllGlobals();
    }

    expect(purgeStatus).toBe(200);
    expect(provider.mock.calls.map(([request]) => request.url)).toEqual([
      "https://provider.test/first",
    ]);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Los datos del tenant se eliminaron durante la solicitud.",
    });
    expect(
      await platform.env.DB.prepare(
        "SELECT id FROM tenant_flow_runs WHERE tenant_id=?",
      )
        .bind(TENANT_A)
        .first(),
    ).toBeNull();
  });

  it("purges private cache entries and preserves other tenants and public reads", async () => {
    const db = platform.env.DB;
    const startedAt = Date.now() - 1;
    const read = (
      tenant: string,
      scope: RequestCachePolicy["scope"],
      revision: string,
      requestStartedAt?: number,
    ) =>
      cacheRequest(
        platform.env,
        new Request("https://provider.test/reference"),
        { enabled: true, ttlSeconds: 60, scope },
        {
          tenant,
          revision,
          connectionId: "fixture-connection",
          requestStartedAt,
        },
        async () => Response.json({ value: revision }),
      );
    await read(TENANT_A, "tenant", "a-private");
    await read(TENANT_A, "connection", "a-connection");
    await read(TENANT_B, "tenant", "b-private");
    await read(TENANT_A, "public", "shared");
    const legacy = "a".repeat(64);
    await db
      .prepare(
        "INSERT INTO savia_request_cache(cache_key,state,created_at) VALUES(?,'ready',?)",
      )
      .bind(legacy, new Date().toISOString())
      .run();

    const purge = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
    expect(purge.status).toBe(200);
    expect(await purge.json()).toMatchObject({
      tenant: TENANT_A,
      purged: { cache: 3 },
    });
    expect(
      await db
        .prepare("SELECT cache_key FROM savia_request_cache WHERE cache_key=?")
        .bind(legacy)
        .first(),
    ).toBeNull();
    for (const [scope, revision] of [
      ["tenant", "a-private"],
      ["connection", "a-connection"],
    ] as const) {
      const stale = await read(TENANT_A, scope, revision, startedAt);
      expect(stale.headers.get("x-savia-cache")).toBe("bypass");
    }
    expect(
      (await read(TENANT_B, "tenant", "b-private")).headers.get(
        "x-savia-cache",
      ),
    ).toBe("hit");
    expect(
      (await read(TENANT_B, "public", "shared")).headers.get("x-savia-cache"),
    ).toBe("hit");
  });

  it("rolls back all overlay deletions if one statement fails", async () => {
    await seedScope(TENANT_A);
    await seedScope(TENANT_B);
    const db = platform.env.DB;
    const overlayTables = [
      "tenant_flow_variables",
      "tenant_flow_versions",
      "tenant_flow_runs",
      "tenant_folders",
      "tenant_bundles",
      "tenant_flows",
    ];
    await db
      .prepare(
        "CREATE TRIGGER fail_version_purge BEFORE DELETE ON tenant_flow_versions " +
          "WHEN OLD.tenant_id='tenant:101' BEGIN SELECT RAISE(ABORT, 'fixture version purge failed'); END",
      )
      .run();

    try {
      const response = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
      const counts = await db.batch<{ count: number }>(
        overlayTables.map((table) =>
          db
            .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id=?`)
            .bind(TENANT_A),
        ),
      );
      expect(counts.map(({ results }) => results[0].count)).toEqual([
        1, 1, 1, 1, 1, 1,
      ]);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error:
          "No se pudo completar la eliminación de datos del tenant en Savia Request.",
      });
    } finally {
      await db.prepare("DROP TRIGGER fail_version_purge").run();
    }

    const retry = await call("DELETE", `/api/admin/tenants/${TENANT_A}`);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({
      tenant: TENANT_A,
      purged: {
        variables: 1,
        versions: 1,
        runs: 1,
        folders: 1,
        bundles: 1,
        bundleFlowStates: 0,
        flows: 1,
        cache: 0,
      },
    });
    expect(await getFlow(platform.env, "flow-a", TENANT_B)).not.toBeNull();
  });

  it("refuses invalid tenants and the platform catalog", async () => {
    expect(
      (await call("DELETE", "/api/admin/tenants/agency%2F..%2Fx")).status,
    ).toBe(400);
    // Empty scope never reaches the store: purging "" throws instead.
    const { purgeTenant } = await import("./store");
    await expect(purgeTenant(platform.env, "")).rejects.toThrow();
  });

  it("blocks a scoped caller from purging another scope", async () => {
    await seedScope(TENANT_B);
    const response = await call(
      "DELETE",
      `/api/admin/tenants/${TENANT_B}`,
      TENANT_A,
    );
    expect(response.status).toBe(403);
    expect(await getFlow(platform.env, "flow-a", TENANT_B)).not.toBeNull();
  });

  it("lets a scoped caller purge its own scope", async () => {
    await seedScope(TENANT_A);
    const response = await call(
      "DELETE",
      `/api/admin/tenants/${TENANT_A}`,
      TENANT_A,
    );
    expect(response.status).toBe(200);
    expect(await getFlow(platform.env, "flow-a", TENANT_A)).toBeNull();
  });
});

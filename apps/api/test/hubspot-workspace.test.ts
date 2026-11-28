import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createHubspotWorkspaceApp,
  capabilities,
} from "../src/external-crm/hubspot-workspace";
import { hubspotObjects } from "../src/external-crm/hubspot-workspace-catalog";
import { createNangoClient } from "../src/external-crm/nango";
import { createCollectionSourceApp } from "../src/studio/collection-sources";
let conn: any = {
  id: "connection",
  status: "connected",
  externalAccountId: "123",
  externalAccountLabel: "Test",
  scopes: ["crm.objects.contacts.write", "crm.objects.companies.write"],
};
vi.mock("../src/external-crm/repository", () => ({
  createCrmRepository: () => ({
    findActiveConnection: async (
      tenantId: number,
      _provider: string,
      principal: string,
    ) =>
      tenantId === 99007
        ? undefined
        : principal === "owner"
          ? conn
          : principal === "member"
            ? {
                ...conn,
                id: "unrelated-connection",
                externalAccountId: "456",
              }
            : undefined,
    findActiveConnectionForPrincipal: async (_: string, principal: string) =>
      principal === "owner"
        ? conn
        : principal === "member"
          ? { ...conn, id: "unrelated-connection", externalAccountId: "456" }
          : undefined,
  }),
}));
const calls: any[] = [];
const context: any = {
  db: env.DB,
  files: env.FILES,
  tenant: "tenant:99006",
  actor: {
    principal: { id: "owner", isActive: true },
    globalRoles: ["platform_admin"],
    memberships: [],
  },
  seedObjects: [],
  crm: {
    nango: {
      proxy: async (request: any) => {
        calls.push(request);
        const path = request.path;
        if (path.includes("/properties/"))
          return Response.json({
            results: [
              { name: "firstname", type: "string" },
              {
                name: "lastname",
                type: "string",
                modificationMetadata: { readOnlyValue: true },
              },
              { name: "name", type: "string" },
            ],
          });
        if (path.endsWith("/labels"))
          return Response.json({
            results: [{ label: null, category: "HUBSPOT_DEFINED", typeId: 1 }],
          });
        if (path.includes("/associations/"))
          return request.method === "GET"
            ? Response.json({ results: [{ id: "9" }] })
            : new Response(null, { status: 204 });
        if (path.includes("/batch/read"))
          return Response.json({
            results: [{ id: "9", properties: { name: "Acme" } }],
          });
        if (!path.includes("/contacts") && !path.includes("/companies"))
          return new Response(null, { status: 403 });
        if (request.method === "DELETE")
          return new Response(null, { status: 204 });
        if (request.method === "POST" && !path.endsWith("/search"))
          return Response.json({
            id: "8",
            properties: request.body.properties,
          });
        if (request.method === "PATCH")
          return Response.json({
            id: "7",
            properties: request.body.properties,
          });
        if (/\/7\?/.test(path) || path.endsWith("/7"))
          return Response.json({ id: "7", properties: { firstname: "Ada" } });
        const nextPage = path.includes("after=");
        return Response.json({
          results: [
            {
              id: nextPage ? "8" : "7",
              properties: { firstname: nextPage ? "Bea" : "Ada", name: "Acme" },
            },
          ],
          ...(nextPage ? {} : { paging: { next: { after: "7" } } }),
        });
      },
    },
  },
};
beforeAll(async () => {
  for (const [, sql] of Object.entries(
    import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
      eager: true,
      import: "default",
      query: "?raw",
    }),
  ).sort(([a], [b]) => a.localeCompare(b)))
    for (const part of sql.split("--> statement-breakpoint")) {
      const statement = part
        .replace(/^--.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
      if (statement) await env.DB.exec(statement);
    }
});
const request = (path: string, method = "GET", body?: any) =>
  createHubspotWorkspaceApp(context).request(path, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });

it("installs all selected HubSpot screens and loads the owners once per batch", async () => {
  const tenant = "tenant:hubspot-install-all";
  const resources = hubspotObjects.map(({ resource }) => resource);
  const previous = conn;
  conn = {
    ...previous,
    scopes: [...previous.scopes, "crm.objects.owners.read"],
  };
  const proxy = vi.fn(async ({ path }: { path: string }) => {
    if (path.startsWith("/crm/v3/properties/"))
      return Response.json({
        results: [{ name: "hubspot_owner_id", type: "string" }],
      });
    if (path.startsWith("/crm/v3/owners?"))
      return Response.json({ results: [{ id: "42", firstName: "Morgan" }] });
    return Response.json({ results: [] });
  });
  try {
    const app = createHubspotWorkspaceApp({
      ...context,
      tenant,
      crm: { nango: { proxy } },
    });
    const response = await app.request("/api/crm-workspace/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        objects: resources.map((resource) => ({ name: `hubspot_${resource}` })),
        unavailable: [],
      },
    });
    const ownersRequests = proxy.mock.calls.filter(([{ path }]) =>
      path.startsWith("/crm/v3/owners?"),
    );
    expect(ownersRequests).toHaveLength(1);
    const { results } = await env.DB.prepare(
      "SELECT config FROM studio_objects WHERE tenant_id=?",
    )
      .bind(tenant)
      .all<{ config: string }>();
    expect(results).toHaveLength(resources.length);
    for (const { config } of results) {
      expect(JSON.parse(config).fields.hubspot_owner_id).toMatchObject({
        type: "Dropdown",
        options: [{ value: "42", label: "Morgan" }],
      });
    }
  } finally {
    conn = previous;
  }
});

it("installs permitted objects idempotently, with actual scope capabilities", async () => {
  expect(capabilities([], "contacts").create).toBe(false);
  const response = await request("/api/crm-workspace/install", "POST", {});
  expect(await response.clone().text()).not.toContain("error");
  expect(response.status).toBe(200);
  const data = ((await response.json()) as any).data;
  expect(data.objects.map((x: any) => x.name)).toEqual([
    "hubspot_contacts",
    "hubspot_companies",
  ]);
  expect(data.unavailable).toHaveLength(10);
  expect((await request("/api/crm-workspace/install", "POST", {})).status).toBe(
    200,
  );
});
it("reports installed state only for matching tenant objects and bindings", async () => {
  const response = await request("/api/crm-workspace");
  expect(response.status).toBe(200);
  const objects = ((await response.json()) as any).data.objects;
  expect(
    objects.find((item: any) => item.resource === "contacts"),
  ).toMatchObject({
    available: true,
    installed: true,
  });
  expect(
    objects.find((item: any) => item.resource === "companies"),
  ).toMatchObject({
    available: true,
    installed: true,
  });
  expect(objects.find((item: any) => item.resource === "deals")).toMatchObject({
    available: false,
    installed: false,
  });

  const binding = await env.DB.prepare(
    "SELECT config FROM crm_collection_bindings WHERE tenant_id=? AND object_name=?",
  )
    .bind(context.tenant, "hubspot_contacts")
    .first<{ config: string }>();
  const config = JSON.parse(binding!.config);
  config.connectionId = "stale-connection";
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name=?",
  )
    .bind(JSON.stringify(config), context.tenant, "hubspot_contacts")
    .run();
  const mismatched = await request("/api/crm-workspace");
  expect(
    ((await mismatched.json()) as any).data.objects.find(
      (item: any) => item.resource === "contacts",
    ).installed,
  ).toBe(false);
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name=?",
  )
    .bind(binding!.config, context.tenant, "hubspot_contacts")
    .run();
});
it("installs only selected resources and avoids provider calls for other resources", async () => {
  const tenant = "tenant:selective-install";
  const start = calls.length;
  const response = await createHubspotWorkspaceApp({
    ...context,
    tenant,
  }).request("/api/crm-workspace/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resources: ["companies"] }),
  });
  expect(response.status).toBe(200);
  expect(
    ((await response.json()) as any).data.objects.map((x: any) => x.name),
  ).toEqual(["hubspot_companies"]);
  const selectedCalls = calls.slice(start);
  expect(selectedCalls.every((call) => !call.path.includes("contacts"))).toBe(
    true,
  );
  const rows = await env.DB.prepare(
    "SELECT name FROM studio_objects WHERE tenant_id=? ORDER BY name",
  )
    .bind(tenant)
    .all<{ name: string }>();
  expect(rows.results.map((row) => row.name)).toEqual(["hubspot_companies"]);
  const bindings = await env.DB.prepare(
    "SELECT object_name FROM crm_collection_bindings WHERE tenant_id=?",
  )
    .bind(tenant)
    .all<{ object_name: string }>();
  expect(bindings.results.map((row) => row.object_name)).toEqual([
    "hubspot_companies",
  ]);
});
it("uninstalls only an empty unreferenced local HubSpot screen", async () => {
  const tenant = "tenant:selective-install";
  const sources = createCollectionSourceApp(env.DB, env.FILES, tenant, "owner");
  const path = "/api/collection-bindings/hubspot_companies";
  await env.DB.prepare(
    "INSERT INTO studio_objects(tenant_id,name,label,description,config) VALUES (?,?,?,?,?)",
  )
    .bind(
      tenant,
      "hubspot_company_reference",
      "Reference",
      "",
      JSON.stringify({
        fields: {
          company: {
            type: "Dropdown",
            label: "Company",
            config: { relation: "hubspot_companies" },
          },
        },
      }),
    )
    .run();
  expect((await sources.request(path, { method: "DELETE" })).status).toBe(409);
  expect(
    await env.DB.prepare(
      "SELECT 1 FROM studio_objects WHERE tenant_id=? AND name='hubspot_companies'",
    )
      .bind(tenant)
      .first(),
  ).toBeTruthy();
  await env.DB.prepare(
    "DELETE FROM studio_objects WHERE tenant_id=? AND name='hubspot_company_reference'",
  )
    .bind(tenant)
    .run();

  await env.DB.prepare(
    "INSERT INTO studio_objects(tenant_id,name,label,description,config) VALUES (?,?,?,?,?)",
  )
    .bind(
      tenant,
      "hubspot_relation_source",
      "Source",
      "",
      JSON.stringify({ fields: {} }),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO studio_collection_relations(tenant_id,id,source_object,target_object,source_label,target_label,cardinality) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      tenant,
      "hubspot-uninstall-relation",
      "hubspot_relation_source",
      "hubspot_companies",
      "Source",
      "Companies",
      "many-to-many",
    )
    .run();
  expect((await sources.request(path, { method: "DELETE" })).status).toBe(409);
  await env.DB.prepare(
    "DELETE FROM studio_collection_relations WHERE tenant_id=? AND id=?",
  )
    .bind(tenant, "hubspot-uninstall-relation")
    .run();
  await env.DB.prepare(
    "DELETE FROM studio_objects WHERE tenant_id=? AND name='hubspot_relation_source'",
  )
    .bind(tenant)
    .run();

  await env.DB.prepare(
    "INSERT INTO studio_records(id,tenant_id,object_name,data) VALUES (?,?,?,?)",
  )
    .bind(
      "hubspot-local-record",
      tenant,
      "hubspot_companies",
      JSON.stringify({ name: "Local" }),
    )
    .run();
  expect((await sources.request(path, { method: "DELETE" })).status).toBe(409);
  await env.DB.prepare("DELETE FROM studio_records WHERE tenant_id=? AND id=?")
    .bind(tenant, "hubspot-local-record")
    .run();

  const remoteCalls = calls.length;
  const response = await sources.request(path, { method: "DELETE" });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { name: "hubspot_companies", unbound: true },
  });
  expect(calls).toHaveLength(remoteCalls);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS total FROM studio_objects WHERE tenant_id=? AND name='hubspot_companies'",
    )
      .bind(tenant)
      .first<{ total: number }>(),
  ).toMatchObject({ total: 0 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS total FROM crm_collection_bindings WHERE tenant_id=? AND object_name='hubspot_companies'",
    )
      .bind(tenant)
      .first<{ total: number }>(),
  ).toMatchObject({ total: 0 });
  const refreshed = await createHubspotWorkspaceApp({
    ...context,
    tenant,
  }).request("/api/crm-workspace");
  expect(refreshed.status).toBe(200);
  expect(
    ((await refreshed.json()) as any).data.objects.find(
      (item: any) => item.resource === "companies",
    ).installed,
  ).toBe(false);
});
it("rejects invalid and unavailable resource lists before installation writes", async () => {
  const tenant = "tenant:invalid-install";
  const app = createHubspotWorkspaceApp({ ...context, tenant });
  const count = calls.length;
  for (const resources of [
    [],
    ["unknown"],
    ["companies", "companies"],
    "companies",
  ])
    expect(
      (
        await app.request("/api/crm-workspace/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resources }),
        })
      ).status,
    ).toBe(422);
  expect(calls).toHaveLength(count);
  const unavailable = await app.request("/api/crm-workspace/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resources: ["deals"] }),
  });
  expect(unavailable.status).toBe(422);
  expect(calls.slice(count).map((call) => call.path)).toEqual([
    "/crm/v3/objects/deals?limit=1",
  ]);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS total FROM studio_objects WHERE tenant_id=?",
    )
      .bind(tenant)
      .first<{ total: number }>(),
  ).toMatchObject({ total: 0 });
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS total FROM crm_collection_bindings WHERE tenant_id=?",
    )
      .bind(tenant)
      .first<{ total: number }>(),
  ).toMatchObject({ total: 0 });
});
it("reads remote pages and rejects invalid fields before writes", async () => {
  const response = await request(
    "/api/records/hubspot_contacts?page=2&perPage=1",
  );
  expect(response.status).toBe(200);
  expect(calls.at(-1).path).toContain("after=7");
  expect(await response.json()).toMatchObject({
    data: [{ id: "8", firstname: "Bea" }],
    total: 2,
  });
  const count = calls.length;
  expect(
    (
      await request("/api/records/hubspot_contacts/7", "PATCH", {
        lastname: "readonly",
      })
    ).status,
  ).toBe(422);
  expect(calls).toHaveLength(count);
  expect(
    (
      await request("/api/records/hubspot_contacts/7", "PATCH", {
        firstname: "Grace",
      })
    ).status,
  ).toBe(200);
  expect(calls.at(-1).body).toEqual({ properties: { firstname: "Grace" } });
  expect(
    (await request("/api/records/hubspot_contacts/7", "DELETE")).status,
  ).toBe(200);
});
it("stops owner lookup on a repeated cursor and installs the screen without owner labels", async () => {
  const tenant = "tenant:hubspot-repeated-owners";
  const previous = conn;
  conn = {
    ...previous,
    scopes: [...previous.scopes, "crm.objects.owners.read"],
  };
  let ownersRequests = 0;
  const proxy = vi.fn(async ({ path }: { path: string }) => {
    if (path.startsWith("/crm/v3/properties/"))
      return Response.json({
        results: [{ name: "hubspot_owner_id", type: "string" }],
      });
    if (path.startsWith("/crm/v3/owners?")) {
      ownersRequests++;
      if (ownersRequests > 2) return new Response(null, { status: 403 });
      return Response.json({
        results: [],
        paging: { next: { after: "repeated" } },
      });
    }
    return Response.json({ results: [] });
  });
  try {
    const response = await createHubspotWorkspaceApp({
      ...context,
      tenant,
      crm: { nango: { proxy } },
    }).request("/api/crm-workspace/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources: ["contacts"] }),
    });
    expect(response.status).toBe(200);
    expect(ownersRequests).toBe(2);
    const stored = await env.DB.prepare(
      "SELECT config FROM studio_objects WHERE tenant_id=? AND name='hubspot_contacts'",
    )
      .bind(tenant)
      .first<string>("config");
    expect(JSON.parse(stored!).fields.hubspot_owner_id.type).toBe("Textbox");
  } finally {
    conn = previous;
  }
});

it("returns an exact total when the requested HubSpot list page is final", async () => {
  const proxy = vi.fn(async ({ path }: { path: string }) => {
    const after = new URL(`https://hubspot.test${path}`).searchParams.get(
      "after",
    );
    return Response.json({
      results: after
        ? [{ id: "6" }]
        : Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1) })),
      ...(after ? {} : { paging: { next: { after: "cursor-2" } } }),
    });
  });
  const response = await createHubspotWorkspaceApp({
    ...context,
    crm: { nango: { proxy } },
  }).request("/api/records/hubspot_contacts?page=2&perPage=5");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: [{ id: "6" }],
    page: 2,
    perPage: 5,
    total: 6,
    pageInfo: { hasNextPage: false, hasPreviousPage: true },
  });
});
describe("HubSpot record pagination", () => {
  const pageContext = { ...context, tenant: "tenant:hubspot-page-integrity" };
  beforeAll(async () => {
    const response = await createHubspotWorkspaceApp(pageContext).request(
      "/api/crm-workspace/install",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resources: ["contacts"] }),
      },
    );
    expect(response.status, await response.text()).toBe(200);
  });

  it.each([
    "/api/records/hubspot_contacts",
    "/api/records/hubspot_contacts/summary",
    "/api/export/hubspot_contacts",
  ])("accepts only empty structured filters for %s", async (path) => {
    const proxy = vi.fn(async () =>
      Response.json({
        results: [{ id: "1", properties: { firstname: "Ana" } }],
      }),
    );
    const app = createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    });
    const request = (filters: string) =>
      app.request(`${path}?${new URLSearchParams({ filters })}`);
    const condition = { field: "firstname", op: "eq", value: "Ana" };
    expect(
      (await request(JSON.stringify({ conditions: [condition] }))).status,
    ).toBe(422);
    expect((await request('{"conditions":[]}')).status).toBe(200);
    expect((await request("[ ]")).status).toBe(200);
    expect((await request("{")).status).toBe(422);
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/api/records/hubspot_contacts",
    "/api/records/hubspot_contacts/summary",
    "/api/export/hubspot_contacts",
  ])(
    "rejects unsupported query options for %s before reading HubSpot",
    async (path) => {
      const proxy = vi.fn(async () =>
        Response.json({
          results: [{ id: "1", properties: { firstname: "Ana" } }],
        }),
      );
      const app = createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      });

      for (const query of [
        "sort=firstname&order=ASC",
        "q=Ana&searchField=firstname",
        "emptyStage=true",
      ]) {
        expect((await app.request(`${path}?${query}`)).status, query).toBe(422);
      }
      expect(proxy).not.toHaveBeenCalled();

      const supported = await app.request(`${path}?q=Ana&order=DESC`);
      expect(supported.status).toBe(200);
      expect(proxy).toHaveBeenCalledOnce();
    },
  );

  it("continues from the previous page and preserves the exact total without replaying it", async () => {
    const proxy = vi.fn(async ({ path }: { path: string }) => {
      const after = new URL(path, "https://hubspot.test").searchParams.get(
        "after",
      );
      return after
        ? Response.json({ results: [{ id: "3" }] })
        : Response.json({
            results: [{ id: "1" }],
            paging: { next: { after: "second-page" } },
          });
    });
    const app = () =>
      createHubspotWorkspaceApp({ ...pageContext, crm: { nango: { proxy } } });
    const path = "/api/records/hubspot_contacts?perPage=2";
    const first = await app().request(path);
    const { nextCursor } = (await first.json()) as { nextCursor?: string };
    expect(nextCursor).toEqual(expect.any(String));
    expect(nextCursor).not.toBe("second-page");
    const cursor = encodeURIComponent(nextCursor!);

    const wrongPage = await app().request(`${path}&page=3&cursor=${cursor}`);
    expect(await wrongPage.json()).toMatchObject({
      data: [],
      total: 2,
      meta: { recordOffset: 2 },
    });
    expect(proxy).toHaveBeenCalledTimes(3);

    proxy.mockClear();
    const wrongLimit = await app().request(
      `/api/records/hubspot_contacts?perPage=3&page=2&cursor=${cursor}`,
    );
    expect(await wrongLimit.json()).toMatchObject({
      data: [{ id: "3" }],
      total: 2,
    });
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy.mock.calls[0]?.[0].path).not.toContain("after=");

    proxy.mockClear();
    const second = await app().request(`${path}&page=2&cursor=${cursor}`);
    expect(second.status).toBe(200);
    const response = await second.json();
    expect(response).toMatchObject({
      data: [{ id: "3" }],
      total: 2,
      meta: { recordOffset: 1 },
      pageInfo: { hasNextPage: false },
    });
    expect(response).not.toHaveProperty("nextCursor");
    expect(proxy).toHaveBeenCalledOnce();
    expect(proxy.mock.calls[0]?.[0].path).toContain("after=second-page");

    proxy.mockClear();
    const retry = await app().request(`${path}&page=2&cursor=${cursor}`);
    expect(await retry.json()).toEqual(response);
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it.each([
    { failure: "rate limit", providerStatus: 429, status: 429 },
    { failure: "cancellation", status: 499 },
    { failure: "provider error", providerStatus: 503, status: 502 },
    { failure: "connection error", status: 502 },
  ])(
    "resumes a HubSpot page after $failure",
    async ({ providerStatus, status }) => {
      const abort = new AbortController();
      let interrupt = true;
      const proxy = vi.fn(async ({ path }: { path: string }) => {
        const after = new URL(path, "https://hubspot.test").searchParams.get(
          "after",
        );
        if (!after)
          return Response.json({
            results: [{ id: "1" }, { id: "2" }],
            paging: { next: { after: "second-page" } },
          });
        if (interrupt) {
          interrupt = false;
          if (status === 499) abort.abort();
          else if (providerStatus)
            return new Response(null, {
              status: providerStatus,
              headers:
                providerStatus === 429 ? { "Retry-After": "1" } : undefined,
            });
          else throw new TypeError("The HubSpot connection closed");
        }
        return Response.json({ results: [{ id: "3" }] });
      });
      const app = createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      });
      const path = "/api/records/hubspot_contacts?perPage=2";
      const first = await app.request(path);
      const { nextCursor } = await first.json<{ nextCursor: string }>();
      expect(nextCursor).toEqual(expect.any(String));
      const second = `${path}&page=2&cursor=${encodeURIComponent(nextCursor)}`;
      const interrupted = await app.request(second, { signal: abort.signal });
      expect(interrupted.status).toBe(status);
      if (status === 429)
        expect(interrupted.headers.get("Retry-After")).toBe("1");

      proxy.mockClear();
      const retry = await app.request(second);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({
        data: [{ id: "3" }],
        total: 3,
      });
      expect(proxy).toHaveBeenCalledOnce();
      expect(proxy.mock.calls[0]?.[0].path).toContain("after=second-page");
    },
  );

  it("rejects a duplicate record on a continued HubSpot page", async () => {
    const proxy = vi.fn(async ({ path }: { path: string }) => {
      const after = new URL(path, "https://hubspot.test").searchParams.get(
        "after",
      );
      return Response.json({
        results: [{ id: "1" }],
        ...(after ? {} : { paging: { next: { after: "second-page" } } }),
      });
    });
    const app = createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    });
    const path = "/api/records/hubspot_contacts?perPage=1";
    const { nextCursor } = (await (await app.request(path)).json()) as {
      nextCursor?: string;
    };
    expect(nextCursor).toEqual(expect.any(String));
    const response = await app.request(
      `${path}&page=2&cursor=${encodeURIComponent(nextCursor!)}`,
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "HubSpot devolvió registros repetidos durante la paginación.",
    });
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "missing records", body: JSON.stringify({ status: "unknown" }) },
    { label: "an invalid record", body: JSON.stringify({ results: [null] }) },
    {
      label: "an inconsistent total",
      body: JSON.stringify({ results: [{ id: "1" }], total: 0 }),
    },
    {
      label: "a string in place of pagination",
      body: JSON.stringify({ results: [{ id: "1" }], paging: "next" }),
    },
    {
      label: "an array in place of pagination",
      body: JSON.stringify({ results: [{ id: "1" }], paging: [] }),
    },
    { label: "invalid JSON", body: "<html>Gateway unavailable</html>" },
  ])("rejects a successful HubSpot response with $label", async ({ body }) => {
    const app = createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy: vi.fn(async () => new Response(body)) } },
    });
    for (const path of [
      "/api/records/hubspot_contacts",
      "/api/records/hubspot_contacts/summary",
      "/api/export/hubspot_contacts",
    ]) {
      const response = await app.request(path);
      expect(response.status).toBe(502);
    }
  });

  it("stops fetching contacts when HubSpot repeats a pagination cursor", async () => {
    const proxy = vi.fn(async () =>
      Response.json({
        results: [{ id: "1" }],
        paging: { next: { after: "same-cursor" } },
      }),
    );
    const response = await createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    }).request("/api/records/hubspot_contacts?page=5");
    expect(response.status).toBe(502);
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/api/records/hubspot_contacts",
    "/api/records/hubspot_contacts/summary",
    "/api/export/hubspot_contacts",
  ])("reports HubSpot's rate limit for %s", async (path) => {
    const { createCollectionGateway } =
      await import("../src/studio/collection-gateway");
    const proxy = vi.fn(async () =>
      Response.json(
        { message: "Provider rate limit" },
        {
          status: 429,
          headers: { "Retry-After": "30", "X-Provider-Internal": "test" },
        },
      ),
    );
    const response = await createCollectionGateway({
      ...pageContext,
      crm: { nango: { proxy } },
    }).fetch(new Request(`https://savia.test${path}`));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(response.headers.has("X-Provider-Internal")).toBe(false);
    expect(await response.json()).toMatchObject({
      error: "HubSpot alcanzó el límite de solicitudes. Inténtalo más tarde.",
    });
    expect(proxy).toHaveBeenCalledOnce();
  });

  it("exports the selected HubSpot columns across all pages", async () => {
    const { createCollectionGateway } =
      await import("../src/studio/collection-gateway");
    const proxy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [{ id: "1", properties: { firstname: "Ana" } }],
          paging: { next: { after: "page-two" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [{ id: "2", properties: { firstname: "=SUM(1,2)" } }],
        }),
      );
    const query = new URLSearchParams({
      columns: JSON.stringify(["firstname"]),
      headers: JSON.stringify(["Nombre"]),
      q: "an",
      trash: "false",
    });
    const response = await createCollectionGateway({
      ...pageContext,
      crm: { nango: { proxy } },
    }).fetch(
      new Request(`https://savia.test/api/export/hubspot_contacts?${query}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/csv/);
    expect(await response.text()).toBe(
      '"Nombre"\r\n"Ana"\r\n"\'=SUM(1,2)"\r\n',
    );
    expect(proxy).toHaveBeenCalledTimes(2);
    expect(proxy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: "POST",
        body: expect.objectContaining({
          query: "an",
          after: "page-two",
          properties: ["firstname"],
        }),
      }),
    );
  });

  it("persists the CRM column in saved HubSpot views and table preferences", async () => {
    const { createCollectionGateway } =
      await import("../src/studio/collection-gateway");
    const gateway = createCollectionGateway(pageContext);
    const url = "https://savia.test/api/views/hubspot_contacts";
    const config = {
      columns: ["__crm_integration", "firstname"],
      columnOrder: ["__crm_integration", "firstname"],
    };
    for (const [target, method, body, status] of [
      [
        url,
        "POST",
        {
          name: "CRM view",
          config: { ...config, sort: { field: "updated_at", order: "DESC" } },
        },
        201,
      ],
      [url + "/default", "PUT", { config }, 200],
    ] as const) {
      const response = await gateway.fetch(
        new Request(target, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status, await response.text()).toBe(status);
    }
    const response = await gateway.fetch(new Request(url));
    expect(await response.json()).toMatchObject({
      data: [{ name: "CRM view", config }],
      default: { config },
    });
  });

  it.each([
    "/api/records/hubspot_contacts?page=2",
    "/api/records/hubspot_contacts/summary",
    "/api/records/hubspot_contacts/summary?group=firstname",
    "/api/export/hubspot_contacts",
  ])("rejects an overlapping contact scan at %s", async (path) => {
    const proxy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [{ id: "1", properties: { firstname: "Ana" } }],
          paging: { next: { after: "page-two" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [{ id: 1, properties: { firstname: "Ana" } }],
        }),
      );
    const response = await createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    }).request(path);

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "HubSpot devolvió registros repetidos durante la paginación.",
    });
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it("rejects an export above the HubSpot CSV limit before sending a file", async () => {
    const proxy = vi.fn(async () =>
      Response.json({ results: [{ id: "1" }], total: 1001 }),
    );
    const response = await createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    }).request("/api/export/hubspot_contacts");
    expect(response.status).toBe(422);
    expect(response.headers.has("content-disposition")).toBe(false);
    expect(proxy).toHaveBeenCalledOnce();
  });

  it.each([
    ["/api/records/hubspot_contacts?page=2", "first"],
    ["/api/records/hubspot_contacts?page=2", "second"],
    ["/api/records/hubspot_contacts/summary", "second"],
  ])(
    "rejects a total below the scanned records at %s (%s page)",
    async (path, totalPage) => {
      const proxy = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            results: [{ id: "1" }],
            paging: { next: { after: "page-two" } },
            ...(totalPage === "first" ? { total: 1 } : {}),
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            results: [{ id: "2" }],
            ...(totalPage === "second" ? { total: 1 } : {}),
          }),
        );
      const response = await createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      }).request(path);

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: "El total de HubSpot es menor que los registros leídos.",
      });
      expect(proxy).toHaveBeenCalledTimes(2);
    },
  );

  it.each([false, true])(
    "does not report a contradictory unfiltered total after the last cursor (multiple pages: %s)",
    async (multiplePages) => {
      const proxy = vi.fn(async ({ path }: { path: string }) => {
        const after = new URL(path, "https://hubspot.test").searchParams.has(
          "after",
        );
        if (multiplePages && !after)
          return Response.json({
            results: [{ id: "1" }],
            paging: { next: { after: "last-page" } },
          });
        return Response.json({ results: [{ id: "2" }], total: 6 });
      });
      const app = createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      });
      const list = await app.request(
        `/api/records/hubspot_contacts?page=${multiplePages ? 2 : 1}`,
      );
      expect(list.status).toBe(200);
      const result = await list.json();
      expect(result).toMatchObject({
        data: [{ id: "2" }],
        pageInfo: { hasNextPage: false, hasPreviousPage: multiplePages },
      });
      expect(result).not.toHaveProperty("total");

      const summary = await app.request(
        "/api/records/hubspot_contacts/summary",
      );
      expect(summary.status).toBe(502);
      expect(await summary.json()).toEqual({
        error: "El total de HubSpot no coincide con los registros del resumen.",
      });
    },
  );

  it.each([
    "/api/records/hubspot_contacts?q=contact&page=2",
    "/api/records/hubspot_contacts/summary?q=contact",
  ])(
    "retains the HubSpot search total beyond the available cursor for %s",
    async (path) => {
      const proxy = vi.fn(async () =>
        Response.json({ results: [{ id: "1" }], total: 10_001 }),
      );
      const response = await createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      }).request(path);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ data: [], total: 10_001 });
    },
  );

  it("preserves the total but stops navigation at the supported page limit", async () => {
    let current = 0;
    const proxy = vi.fn(async () => {
      current++;
      return Response.json({
        results: [{ id: String(current) }],
        total: 150,
        paging: { next: { after: String(current) } },
      });
    });
    const app = createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    });
    const url = "/api/records/hubspot_contacts?q=contact&perPage=1";
    const final = await app.request(`${url}&page=100`);
    expect(final.status).toBe(200);
    expect(await final.json()).toMatchObject({
      total: 150,
      pageInfo: { hasNextPage: false, hasPreviousPage: true },
      meta: { maxPage: 100, pageLimitReached: true },
    });
    expect((await app.request(`${url}&page=101`)).status).toBe(422);
    expect(proxy).toHaveBeenCalledTimes(100);
  });

  it("uses HubSpot's search total without scanning all matching records", async () => {
    const proxy = vi.fn(async () =>
      Response.json({
        total: 1_500,
        results: [{ id: "1" }],
        paging: { next: { after: "next" } },
      }),
    );
    const response = await createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    }).request("/api/records/hubspot_contacts/summary?q=Ana");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], total: 1_500 });
    expect(proxy).toHaveBeenCalledOnce();
  });

  it("counts the remaining records when a zero total has a next cursor and the last page omits the total", async () => {
    const proxy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [],
          total: 0,
          paging: { next: { after: "next" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ results: [{ id: "1" }, { id: "2" }] }),
      );
    const response = await createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    }).request("/api/records/hubspot_contacts/summary");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [], total: 2 });
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/api/records/hubspot_contacts/summary",
    "/api/records/hubspot_contacts?page=3&perPage=1",
    "/api/records/hubspot_contacts?q=Ana&page=3&perPage=1",
    "/api/export/hubspot_contacts",
    "/api/export/hubspot_contacts?q=Ana",
  ])(
    "cancels the provider request when a HubSpot read is abandoned (%s)",
    async (path) => {
      const abort = new AbortController();
      let providerSignal: AbortSignal | null | undefined;
      let releasePage!: () => void;
      const unfinishedPage = new Promise<void>((resolve) => {
        releasePage = resolve;
      });
      let startRequest!: () => void;
      const started = new Promise<void>((resolve) => {
        startRequest = resolve;
      });
      const fetcher = vi.fn(
        async (_url: RequestInfo | URL, options?: RequestInit) => {
          providerSignal = options?.signal;
          startRequest();
          await unfinishedPage;
          return Response.json({
            results: [{ id: "1" }],
            paging: { next: { after: "2" } },
          });
        },
      );
      const nango = createNangoClient(
        {
          baseUrl: "https://nango.example.test",
          apiKey: "test-key",
          hubspotIntegrationId: "test-hubspot",
        },
        fetcher,
      );
      const request = new Request(`https://savia.test${path}`, {
        signal: abort.signal,
      });
      const result = createHubspotWorkspaceApp({
        ...pageContext,
        crm: {
          nango: {
            proxy: (input: Parameters<typeof nango.proxy>[0]) =>
              nango.proxy({
                ...input,
                connection: {
                  ...input.connection,
                  provider: "hubspot",
                  nangoIntegrationId: "test-hubspot",
                },
              }),
          },
        },
      }).fetch(request);
      await started;
      abort.abort();
      releasePage();

      expect((await result).status).toBe(499);
      expect(providerSignal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("omits a zero total for a list with a next cursor and counts the last page without it", async () => {
    const proxy = vi.fn(async ({ path }: { path: string }) => {
      const after = new URL(path, "https://hubspot.test").searchParams.get(
        "after",
      );
      return Response.json(
        after === "next"
          ? { results: [{ id: "1" }, { id: "2" }] }
          : { results: [], total: 0, paging: { next: { after: "next" } } },
      );
    });
    const app = createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    });
    const path = "/api/records/hubspot_contacts";
    const response = await app.request(path);

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      data: [],
      pageInfo: { hasNextPage: true, hasPreviousPage: false },
    });
    expect(result).not.toHaveProperty("total");
    expect(result.nextCursor).toEqual(expect.any(String));

    const lastPage = await app.request(
      `${path}?page=2&cursor=${encodeURIComponent(result.nextCursor)}`,
    );
    expect(lastPage.status).toBe(200);
    expect(await lastPage.json()).toMatchObject({
      data: [{ id: "1" }, { id: "2" }],
      total: 2,
      pageInfo: { hasNextPage: false, hasPreviousPage: true },
    });
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it("exports records after an empty HubSpot page with a zero total and a next cursor", async () => {
    const proxy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [],
          total: 0,
          paging: { next: { after: "next" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          results: [{ id: "1", properties: { firstname: "Ana" } }],
        }),
      );
    const query = new URLSearchParams({
      columns: JSON.stringify(["firstname"]),
      headers: JSON.stringify(["Name"]),
    });
    const response = await createHubspotWorkspaceApp({
      ...pageContext,
      crm: { nango: { proxy } },
    }).request(`/api/export/hubspot_contacts?${query}`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"Ana"\r\n');
    expect(proxy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "complete",
      () => Response.json({ total: 1_243, results: [{ id: "1" }] }),
      200,
    ],
    ["stale", () => Response.json({ total: 800, results: [{ id: "1" }] }), 422],
    ["unsupported", () => new Response(null, { status: 404 }), 422],
  ] as const)(
    "handles a %s unfiltered count after reaching the list scan limit",
    async (_scenario, search, status) => {
      let page = 0;
      const proxy = vi.fn(
        async ({ path }: { path: string; body?: unknown }) => {
          if (path.endsWith("/search")) return search();
          const start = page++ * 100;
          return Response.json({
            results: Array.from({ length: 100 }, (_, index) => ({
              id: String(start + index + 1),
            })),
            paging: { next: { after: String(start + 100) } },
          });
        },
      );
      const response = await createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      }).request("/api/records/hubspot_contacts/summary");

      expect(response.status).toBe(status);
      expect(page).toBe(10);
      expect(proxy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          path: "/crm/v3/objects/contacts/search",
          method: "POST",
          body: { limit: 1, properties: ["hs_object_id"] },
        }),
      );
      if (status === 200)
        expect(await response.json()).toEqual({ data: [], total: 1_243 });
    },
  );

  it.each([
    [3, 502],
    [1_500, 422],
  ])(
    "rejects a partial grouped summary when HubSpot reports %s matches",
    async (total, status) => {
      const proxy = vi.fn(async () =>
        Response.json({
          total,
          results: [{ id: "1", properties: { firstname: "Ana" } }],
        }),
      );
      const response = await createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy } },
      }).request("/api/records/hubspot_contacts/summary?group=firstname&q=Ana");

      expect(response.status).toBe(status);
      expect(proxy).toHaveBeenCalledOnce();
    },
  );

  it.each([{ id: "124" }, { properties: {} }, null])(
    "rejects an inconsistent HubSpot detail response",
    async (body) => {
      const app = createHubspotWorkspaceApp({
        ...pageContext,
        crm: { nango: { proxy: vi.fn(async () => Response.json(body)) } },
      });
      for (const surface of ["records", "record-detail"]) {
        const response = await app.request(
          `/api/${surface}/hubspot_contacts/123`,
        );
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
          error: "HubSpot devolvió un registro distinto o inválido.",
        });
      }
    },
  );
});

it("groups a fully paginated HubSpot summary and supports total-only scans", async () => {
  const proxy = vi.fn(async ({ path }: { path: string }) => {
    const after = new URL(`https://hubspot.test${path}`).searchParams.get(
      "after",
    );
    return Response.json({
      results: after
        ? [{ id: "3", properties: { firstname: "C" } }]
        : [
            { id: "1", properties: { firstname: "A" } },
            { id: "2", properties: { firstname: "A" } },
          ],
      ...(after ? {} : { paging: { next: { after: "cursor-2" } } }),
    });
  });
  const app = createHubspotWorkspaceApp({
    ...context,
    crm: { nango: { proxy } },
  });
  const grouped = await app.request(
    "/api/records/hubspot_contacts/summary?group=firstname",
  );
  expect(grouped.status).toBe(200);
  expect(await grouped.json()).toEqual({
    data: [
      { value: "A", count: 2 },
      { value: "C", count: 1 },
    ],
    total: 3,
  });
  const totalOnly = await app.request("/api/records/hubspot_contacts/summary");
  expect(totalOnly.status).toBe(200);
  expect(await totalOnly.json()).toEqual({ data: [], total: 3 });
});

it.each([
  ["not-a-number", "10"],
  ["1e309", "10"],
  [false, "10"],
  ["1e308", "1e308"],
])(
  "retains the verified HubSpot count when amounts %j and %j cannot be summed",
  async (firstAmount, nextAmount) => {
    const summaryContext = {
      ...context,
      tenant: "tenant:hubspot-summary-invalid-amount",
    };
    const proxy = vi.fn(async ({ path }: { path: string }) => {
      if (path.startsWith("/crm/v3/properties/"))
        return Response.json({
          results: [
            { name: "dealname", type: "string" },
            { name: "pipeline", type: "enumeration" },
            { name: "dealstage", type: "enumeration" },
            { name: "amount", type: "number" },
          ],
        });
      if (path.startsWith("/crm/v3/pipelines/"))
        return Response.json({
          results: [
            {
              id: "sales",
              label: "Sales",
              stages: [
                { id: "Qualified", label: "Qualified" },
                { id: "Won", label: "Won" },
              ],
            },
          ],
        });
      const after = new URL(`https://hubspot.test${path}`).searchParams.get(
        "after",
      );
      return Response.json({
        total: 3,
        results: after
          ? [
              {
                id: "3",
                properties: { dealstage: "Qualified", amount: nextAmount },
              },
            ]
          : [
              {
                id: "1",
                properties: { dealstage: "Qualified", amount: firstAmount },
              },
              { id: "2", properties: { dealstage: "Won", amount: "20.50" } },
            ],
        ...(after ? {} : { paging: { next: { after: "next" } } }),
      });
    });
    const app = createHubspotWorkspaceApp({
      ...summaryContext,
      crm: { nango: { proxy } },
    });
    const installed = await app.request("/api/crm-workspace/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources: ["deals"] }),
    });
    expect(installed.status, await installed.text()).toBe(200);
    proxy.mockClear();

    const response = await app.request(
      "/api/records/hubspot_deals/summary?group=dealstage&amountField=amount",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        { value: "Qualified", count: 2 },
        { value: "Won", count: 1, amount: 20.5 },
      ],
      total: 3,
    });
    expect(proxy).toHaveBeenCalledTimes(2);
  },
);

it("groups only HubSpot records that match the search across pages", async () => {
  const summaryContext = {
    ...context,
    tenant: "tenant:hubspot-summary-search",
  };
  const installed = await createHubspotWorkspaceApp(summaryContext).request(
    "/api/crm-workspace/install",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resources: ["contacts"] }),
    },
  );
  expect(installed.status).toBe(200);
  const proxy = vi.fn(
    async ({ path, body }: { path: string; body?: unknown }) => {
      if (!path.endsWith("/search"))
        return Response.json({
          results: [{ id: "9", properties: { firstname: "Unrelated" } }],
        });
      const { after } = body as { after?: string };
      return Response.json({
        total: 2,
        results: [{ id: after ? "2" : "1", properties: { firstname: "Ana" } }],
        ...(after ? {} : { paging: { next: { after: "search-cursor" } } }),
      });
    },
  );
  const response = await createHubspotWorkspaceApp({
    ...summaryContext,
    crm: { nango: { proxy } },
  }).request("/api/records/hubspot_contacts/summary?group=firstname&q=Ana");

  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: [{ value: "Ana", count: 2 }],
    total: 2,
  });
  expect(proxy.mock.calls.map(([request]) => request.body)).toEqual([
    { query: "Ana", properties: ["firstname"], limit: 100 },
    {
      query: "Ana",
      properties: ["firstname"],
      limit: 100,
      after: "search-cursor",
    },
  ]);
});

it("rejects invalid HubSpot summary fields", async () => {
  const response = await request(
    "/api/records/hubspot_contacts/summary?group=not_a_field",
  );
  expect(response.status).toBe(422);
});
it("enforces principal, tenant, active connection, account and current grants", async () => {
  const foreign = {
    ...context,
    actor: {
      principal: { id: "other", isActive: true },
      globalRoles: [],
      memberships: [],
    },
  };
  expect(
    (
      await createHubspotWorkspaceApp(foreign).request(
        "/api/records/hubspot_contacts",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await createHubspotWorkspaceApp({ ...context, tenant: "other" }).request(
        "/api/records/hubspot_contacts",
      )
    ).status,
  ).toBe(404);
  const before = conn;
  conn = { ...before, id: "other" };
  expect((await request("/api/records/hubspot_contacts")).status).toBe(403);
  conn = { ...before, externalAccountId: "456" };
  expect((await request("/api/records/hubspot_contacts")).status).toBe(403);
  conn = { ...before, scopes: [] };
  expect(
    (
      await request("/api/records/hubspot_contacts/7", "PATCH", {
        firstname: "x",
      })
    ).status,
  ).toBe(405);
  conn = before;
});
it("resolves native links and performs safe provider association mutations", async () => {
  const response = await request("/api/record-links/hubspot_contacts/7");
  expect(response.status).toBe(200);
  const data = ((await response.json()) as any).data;
  expect(
    data.find((x: any) => x.targetObject === "hubspot_companies").records,
  ).toEqual([{ id: "9", label: "Acme" }]);
  const link = await request(
    "/api/record-links/hubspot_contacts/7/hubspot%3Ahubspot_contacts%3Ahubspot_companies",
    "POST",
    { targetId: "9" },
  );
  expect(link.status).toBe(200);
  expect(calls.at(-1).path).toBe(
    "/crm/v4/objects/contacts/7/associations/default/companies/9",
  );
  expect(calls.at(-1).body).toEqual({});
});
describe("HubSpot association pages", () => {
  const relationContext = {
    ...context,
    tenant: "tenant:hubspot-relation-pages",
  };
  beforeAll(async () => {
    const installed = await createHubspotWorkspaceApp(relationContext).request(
      "/api/crm-workspace/install",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resources: ["contacts", "companies"] }),
      },
    );
    expect(installed.status).toBe(200);
  });

  it.each([
    { name: "zero cursor", repeated: false, batchIds: ["4", "3"], status: 200 },
    {
      name: "repeated target",
      repeated: true,
      batchIds: ["4", "3"],
      status: 200,
    },
    { name: "incomplete batch", repeated: false, batchIds: ["3"], status: 502 },
    { name: "unrelated record", repeated: false, batchIds: ["5"], status: 502 },
  ])("validates related records for a $name", async (scenario) => {
    const proxy = vi.fn(async ({ path }: { path: string; body?: unknown }) => {
      if (path.endsWith("/labels"))
        return Response.json({
          results: [{ label: null, category: "HUBSPOT_DEFINED", typeId: 1 }],
        });
      if (path.includes("/associations/")) {
        const after = new URL(`https://hubspot.test${path}`).searchParams.get(
          "after",
        );
        return Response.json(
          after === "0"
            ? {
                results: [
                  ...(scenario.repeated ? [{ id: 2 }] : []),
                  { id: "3" },
                  { id: "4" },
                ],
              }
            : {
                results: [{ id: "1" }, { id: "2" }],
                paging: { next: { after: 0 } },
              },
        );
      }
      if (path.endsWith("/batch/read"))
        return Response.json({
          results: scenario.batchIds.map((id) => ({
            id,
            properties: { name: `Company ${id}` },
          })),
        });
      return Response.json({ id: "7" });
    });
    const app = createHubspotWorkspaceApp({
      ...relationContext,
      crm: { nango: { proxy } },
    });
    const url =
      "/api/record-links/hubspot_contacts/7?relationId=hubspot:hubspot_contacts:hubspot_companies&page=2&perPage=2";
    const response = await app.request(url);

    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/crm/v3/objects/companies/batch/read",
        body: expect.objectContaining({ inputs: [{ id: "3" }, { id: "4" }] }),
      }),
    );
    expect(response.status).toBe(scenario.status);
    if (scenario.status === 200) {
      expect(await response.json()).toMatchObject({
        data: [
          {
            records: [
              { id: "3", label: "Company 3" },
              { id: "4", label: "Company 4" },
            ],
            total: 4,
            hasNextPage: false,
          },
        ],
      });
    }

    if (scenario.repeated) {
      proxy.mockClear();
      const metadata = await app.request(`${url}&includeRecords=false`);
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        data: [{ records: [], total: 4, hasNextPage: false }],
      });
      expect(
        proxy.mock.calls.some(([request]) =>
          request.path.endsWith("/batch/read"),
        ),
      ).toBe(false);
    }
  });
});

it("keeps bound field contracts immutable through generic metadata routes", async () => {
  const app = createCollectionSourceApp(
    env.DB,
    env.FILES,
    context.tenant,
    "owner",
  );
  const object = (
    (await (await app.request("/api/objects/hubspot_contacts")).json()) as any
  ).data;
  object.config.fields.firstname.readOnly = true;
  expect(
    (
      await app.request("/api/objects/hubspot_contacts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(object),
      })
    ).status,
  ).toBe(422);
});

it("reconciles provider fields without losing screen and field labels", async () => {
  const row = await env.DB.prepare(
    "SELECT config FROM studio_objects WHERE tenant_id=? AND name=?",
  )
    .bind(context.tenant, "hubspot_contacts")
    .first<{ config: string }>();
  const config = JSON.parse(row!.config);
  config.fields.firstname.label = "Nombre preferido";
  await env.DB.prepare(
    "UPDATE studio_objects SET label=?,config=? WHERE tenant_id=? AND name=?",
  )
    .bind(
      "Mis contactos",
      JSON.stringify(config),
      context.tenant,
      "hubspot_contacts",
    )
    .run();
  expect((await request("/api/crm-workspace/install", "POST", {})).status).toBe(
    200,
  );
  const after = await env.DB.prepare(
    "SELECT label,config FROM studio_objects WHERE tenant_id=? AND name=?",
  )
    .bind(context.tenant, "hubspot_contacts")
    .first<{ label: string; config: string }>();
  expect(after!.label).toBe("Mis contactos");
  expect(JSON.parse(after!.config).fields.firstname.label).toBe(
    "Nombre preferido",
  );
});
it("accepts a full record edit while excluding server-owned metadata from provider body", async () => {
  const response = await request("/api/records/hubspot_contacts/7", "PATCH", {
    id: "7",
    created_at: "now",
    updated_at: "now",
    _version: 1,
    _crmLinks: [],
    firstname: "Grace",
  });
  expect(response.status).toBe(200);
  expect(calls.at(-1).body).toEqual({ properties: { firstname: "Grace" } });
});
it("validates mandatory create fields and rejects traversal ids", async () => {
  expect(
    (await request("/api/records/hubspot_companies", "POST", { name: "" }))
      .status,
  ).toBe(422);
  const count = calls.length;
  expect(
    (await request("/api/records/hubspot_contacts/%2e%2e%2fcompanies")).status,
  ).toBe(422);
  expect(calls).toHaveLength(count);
});
it("normalizes provider datetime and date fields without silently losing time", async () => {
  const row = await env.DB.prepare(
    "SELECT config FROM crm_collection_bindings WHERE tenant_id=? AND object_name=?",
  )
    .bind(context.tenant, "hubspot_contacts")
    .first<{ config: string }>();
  const original = row!.config;
  const binding = JSON.parse(original);
  binding.propertyTypes.firstname = "datetime";
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name=?",
  )
    .bind(JSON.stringify(binding), context.tenant, "hubspot_contacts")
    .run();
  expect(
    (
      await request("/api/records/hubspot_contacts/7", "PATCH", {
        firstname: "2026-09-11T09:30:00-05:00",
      })
    ).status,
  ).toBe(200);
  expect(calls.at(-1).body.properties.firstname).toBe(
    "2026-09-11T14:30:00.000Z",
  );
  expect(
    (
      await request("/api/records/hubspot_contacts/7", "PATCH", {
        firstname: "2026-09-11",
      })
    ).status,
  ).toBe(422);
  binding.propertyTypes.firstname = "date";
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name=?",
  )
    .bind(JSON.stringify(binding), context.tenant, "hubspot_contacts")
    .run();
  expect(
    (
      await request("/api/records/hubspot_contacts/7", "PATCH", {
        firstname: "2026-09-11",
      })
    ).status,
  ).toBe(200);
  expect(calls.at(-1).body.properties.firstname).toBe(
    String(Date.parse("2026-09-11T00:00:00Z")),
  );
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name=?",
  )
    .bind(original, context.tenant, "hubspot_contacts")
    .run();
});
it("allows explicit reinstall after same-account reconnect but rejects another account", async () => {
  const original = conn;
  conn = { ...original, id: "reconnected" };
  expect((await request("/api/records/hubspot_contacts")).status).toBe(403);
  expect((await request("/api/crm-workspace/install", "POST", {})).status).toBe(
    200,
  );
  expect((await request("/api/records/hubspot_contacts")).status).toBe(200);
  conn = { ...conn, externalAccountId: "another-account" };
  expect((await request("/api/crm-workspace/install", "POST", {})).status).toBe(
    403,
  );
  conn = original;
  expect((await request("/api/crm-workspace/install", "POST", {})).status).toBe(
    200,
  );
});
it("does not partially update installed metadata when a later provider inspection fails", async () => {
  const before = await env.DB.prepare(
    "SELECT version FROM studio_objects WHERE tenant_id=? AND name=?",
  )
    .bind(context.tenant, "hubspot_contacts")
    .first<{ version: number }>();
  const proxy = context.crm.nango.proxy;
  context.crm.nango.proxy = async (r: any) =>
    r.path === "/crm/v3/properties/companies"
      ? new Response(null, { status: 500 })
      : proxy(r);
  try {
    expect(
      (await request("/api/crm-workspace/install", "POST", {})).status,
    ).toBe(502);
    const after = await env.DB.prepare(
      "SELECT version FROM studio_objects WHERE tenant_id=? AND name=?",
    )
      .bind(context.tenant, "hubspot_contacts")
      .first<{ version: number }>();
    expect(after!.version).toBe(before!.version);
  } finally {
    context.crm.nango.proxy = proxy;
  }
});
it("refreshes generated datetime labels and flags while preserving customized labels", async () => {
  const proxy = context.crm.nango.proxy;
  context.crm.nango.proxy = async (r: any) => {
    if (r.path === "/crm/v3/properties/contacts")
      return Response.json({
        results: [
          { name: "firstname", type: "datetime" },
          { name: "lastname", type: "datetime" },
        ],
      });
    return proxy(r);
  };
  try {
    const row = await env.DB.prepare(
      "SELECT config FROM studio_objects WHERE tenant_id=? AND name=?",
    )
      .bind(context.tenant, "hubspot_contacts")
      .first<{ config: string }>();
    const config = JSON.parse(row!.config);
    config.fields.firstname.label = "Nombres (fecha y hora ISO)";
    config.fields.firstname.config = {
      dateTime: false,
      placeholder: "2026-09-11T14:30:00-05:00",
    };
    config.fields.lastname.label = "Mi fecha personalizada";
    await env.DB.prepare(
      "UPDATE studio_objects SET config=? WHERE tenant_id=? AND name=?",
    )
      .bind(JSON.stringify(config), context.tenant, "hubspot_contacts")
      .run();
    expect(
      (await request("/api/crm-workspace/install", "POST", {})).status,
    ).toBe(200);
    const after = await env.DB.prepare(
      "SELECT config FROM studio_objects WHERE tenant_id=? AND name=?",
    )
      .bind(context.tenant, "hubspot_contacts")
      .first<{ config: string }>();
    const fields = JSON.parse(after!.config).fields;
    expect(fields.firstname.label).toBe("Nombres");
    expect(fields.firstname.config.dateTime).toBe(true);
    expect(fields.firstname.config.placeholder).toBeUndefined();
    expect(fields.lastname.label).toBe("Mi fecha personalizada");
    expect(fields.lastname.config.dateTime).toBe(true);
  } finally {
    context.crm.nango.proxy = proxy;
  }
});

it("shares installed collections with authorized domain users without their own connection", async () => {
  const teammate = {
    ...context,
    actor: {
      principal: { id: "teammate", isActive: true },
      globalRoles: ["platform_admin"],
      memberships: [],
    },
  };
  const response = await createHubspotWorkspaceApp(teammate).request(
    "/api/records/hubspot_contacts",
  );
  expect(response.status).toBe(200);
  expect(calls.at(-1).connection.id).toBe(conn.id);
  const audit = await env.DB.prepare(
    "SELECT detail FROM studio_audit WHERE tenant_id=? AND action='hubspot.read' ORDER BY rowid DESC LIMIT 1",
  )
    .bind(context.tenant)
    .first<{ detail: string }>();
  expect(JSON.parse(audit!.detail).principalId).toBe("teammate");
});
it("does not share a legacy personal binding or allow inactive actors", async () => {
  const row = await env.DB.prepare(
    "SELECT config FROM crm_collection_bindings WHERE tenant_id=? AND object_name='hubspot_contacts'",
  )
    .bind(context.tenant)
    .first<{ config: string }>();
  const original = row!.config;
  const privateBinding = JSON.parse(original);
  delete privateBinding.accessScope;
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name='hubspot_contacts'",
  )
    .bind(JSON.stringify(privateBinding), context.tenant)
    .run();
  const teammate = {
    ...context,
    actor: {
      principal: { id: "teammate", isActive: true },
      globalRoles: ["platform_admin"],
      memberships: [],
    },
  };
  expect(
    (
      await createHubspotWorkspaceApp(teammate).request(
        "/api/records/hubspot_contacts",
      )
    ).status,
  ).toBe(403);
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name='hubspot_contacts'",
  )
    .bind(original, context.tenant)
    .run();
  teammate.actor.principal.isActive = false;
  expect(
    (
      await createHubspotWorkspaceApp(teammate).request(
        "/api/records/hubspot_contacts",
      )
    ).status,
  ).toBe(403);
});

it("lets a tenant member read the shared connection but blocks writes, inactive membership and revoked connections", async () => {
  const tenantContext = { ...context, tenant: "tenant:101" };
  expect(
    (
      await createHubspotWorkspaceApp(tenantContext).request(
        "/api/crm-workspace/install",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        },
      )
    ).status,
  ).toBe(200);
  const member = {
    ...tenantContext,
    actor: {
      principal: { id: "member", isActive: true },
      globalRoles: [],
      memberships: [{ tenantId: 101, isActive: true, role: "viewer" }],
    },
  };
  expect(
    (
      await createHubspotWorkspaceApp(member as any).request(
        "/api/records/hubspot_contacts",
      )
    ).status,
  ).toBe(200);
  expect(calls.at(-1).connection.id).toBe(conn.id);
  expect(
    (
      await createHubspotWorkspaceApp(member as any).request(
        "/api/records/hubspot_contacts/7",
        { method: "DELETE" },
      )
    ).status,
  ).toBe(403);
  member.actor.memberships[0].isActive = false;
  expect(
    (
      await createHubspotWorkspaceApp(member as any).request(
        "/api/records/hubspot_contacts",
      )
    ).status,
  ).toBe(403);
  member.actor.memberships[0].isActive = true;
  const before = conn;
  conn = { ...conn, status: "disconnected" };
  try {
    const app = createHubspotWorkspaceApp(member as any);
    for (const suffix of ["", "/summary"]) {
      const response = await app.request(
        `/api/records/hubspot_contacts${suffix}`,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "HUBSPOT_CONNECTION_UNAVAILABLE" },
      });
    }
  } finally {
    conn = before;
  }
});

it("shares related records while excluding private targets and auditing batch reads as reads", async () => {
  const member = {
    ...context,
    tenant: "tenant:101",
    actor: {
      principal: { id: "member", isActive: true },
      globalRoles: [],
      memberships: [{ tenantId: 101, isActive: true, role: "viewer" }],
    },
  };
  const response = await createHubspotWorkspaceApp(member as any).request(
    "/api/record-links/hubspot_contacts/7",
  );
  expect(response.status).toBe(200);
  const data = ((await response.json()) as any).data;
  expect(
    data.find((item: any) => item.targetObject === "hubspot_companies").records,
  ).toEqual([{ id: "9", label: "Acme" }]);
  const events = await env.DB.prepare(
    "SELECT action,detail FROM studio_audit WHERE tenant_id=?",
  )
    .bind(member.tenant)
    .all<{ action: string; detail: string }>();
  const memberPosts = events.results.filter((event) => {
    const detail = JSON.parse(event.detail);
    return detail.principalId === "member" && detail.method === "POST";
  });
  expect(memberPosts.length).toBeGreaterThan(0);
  expect(memberPosts.every((event) => event.action === "hubspot.read")).toBe(
    true,
  );
  await env.DB.prepare(
    "UPDATE crm_collection_bindings SET config=json_remove(config,'$.accessScope') WHERE tenant_id=? AND object_name='hubspot_companies'",
  )
    .bind(member.tenant)
    .run();
  const privateResponse = await createHubspotWorkspaceApp(
    member as any,
  ).request("/api/record-links/hubspot_contacts/7");
  expect(privateResponse.status).toBe(200);
  expect(
    ((await privateResponse.json()) as any).data.some(
      (item: any) => item.targetObject === "hubspot_companies",
    ),
  ).toBe(false);
});

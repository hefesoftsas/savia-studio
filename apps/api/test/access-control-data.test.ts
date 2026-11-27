import { beforeAll, it, expect } from "vitest";
import { createAccessFixture } from "./access-control-fixtures";
import {
  saveAccessRole,
  replaceAccessAssignments,
  loadAccessPolicy,
} from "../src/auth/access-repository";
let f: Awaited<ReturnType<typeof createAccessFixture>>;
let rowId: string;
beforeAll(async () => {
  f = await createAccessFixture();
  const admin = await f.actor("agency_admin");
  const revision = (await loadAccessPolicy(f.db, admin, "tenant:101")).revision;
  const role = await saveAccessRole(f.db, admin, {
    scope: "tenant:101",
    name: "filtered",
    label: "Filtered",
    description: "",
    enabled: true,
    expectedRevision: revision,
    grants: [
      {
        resource: "collection:acl_contacts",
        action: "read",
        predicate: { field: "commission", op: "lt", value: { literal: 150 } },
        fields: ["name"],
      },
      {
        resource: "collection:acl_contacts",
        action: "update",
        predicate: { field: "commission", op: "lt", value: { literal: 150 } },
        fields: ["name"],
      },
      {
        resource: "collection:acl_contacts",
        action: "export",
        predicate: { field: "commission", op: "lt", value: { literal: 150 } },
        fields: ["name"],
      },
    ],
  });
  await replaceAccessAssignments(f.db, admin, {
    scope: "tenant:101",
    principalId: f.principalId("viewer"),
    roleIds: [role.id],
    expectedRevision: role.revision,
  });
  const row = await f.db
    .prepare(
      "SELECT id FROM studio_records WHERE tenant_id='tenant:101' AND object_name='acl_contacts'",
    )
    .first<{ id: string }>();
  rowId = row!.id;
  await f.request(
    "agency_admin",
    101,
    "/v1/dynamic-crm/101/api/records/acl_contacts",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Hidden client", commission: 200 }),
    },
  );
});
const base = "/v1/dynamic-crm/101/api";
it("reports allowed CSV fields, then exports them with the requested headers and order", async () => {
  const admin = await f.actor("agency_admin");
  const revision = (await loadAccessPolicy(f.db, admin, "tenant:101")).revision;
  const role = await saveAccessRole(f.db, admin, {
    scope: "tenant:101",
    name: "csv-export",
    label: "CSV export",
    description: "",
    enabled: true,
    expectedRevision: revision,
    grants: [
      {
        resource: "page:acl_contacts",
        action: "read",
        predicate: { all: true },
        fields: [],
      },
      {
        resource: "collection:acl_contacts",
        action: "read",
        predicate: { all: true },
        fields: ["name", "commission"],
      },
      {
        resource: "collection:acl_contacts",
        action: "export",
        predicate: { all: true },
        fields: ["name"],
      },
    ],
  });
  await replaceAccessAssignments(f.db, admin, {
    scope: "tenant:101",
    principalId: f.principalId("operator"),
    roleIds: [role.id],
    expectedRevision: role.revision,
  });
  const response = await f.request(
    "operator",
    101,
    base + "/objects/acl_contacts",
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    data: { exportFields: ["name"] },
  });
  const csv = await f.request(
    "operator",
    101,
    base +
      "/export/acl_contacts?" +
      new URLSearchParams({ columns: '["name"]' }),
  );
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
  expect(await csv.text()).toContain("Tenant 101");
  for (const [order, expected] of [
    ["ASC", ['"Hidden client"', '"Tenant 101"']],
    ["DESC", ['"Tenant 101"', '"Hidden client"']],
  ] as const) {
    const query = new URLSearchParams({
      columns: '["name"]',
      headers: '["Nombre de contacto"]',
      sort: "name",
      order,
    });
    const result = await f.request(
      "operator",
      101,
      base + "/export/acl_contacts?" + query,
    );
    expect(result.status).toBe(200);
    expect((await result.text()).trim().split("\r\n")).toEqual([
      '"Nombre de contacto"',
      ...expected,
    ]);
  }
  const invalidHeaders = await f.request(
    "operator",
    101,
    base +
      "/export/acl_contacts?" +
      new URLSearchParams({ columns: '["name"]', headers: "[]" }),
  );
  expect(invalidHeaders.status).toBe(422);
  const unexportableField = await f.request(
    "operator",
    101,
    base +
      "/export/acl_contacts?" +
      new URLSearchParams({
        columns: '["commission"]',
        headers: '["Commission"]',
      }),
  );
  expect(unexportableField.status).toBe(403);
});

it("filters before pagination and count, and projects fields", async () => {
  const response = await f.request(
    "viewer",
    101,
    base + "/records/acl_contacts?perPage=1",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: Record<string, unknown>[];
    total: number;
  };
  expect(body.total).toBe(1);
  expect(body.data).toHaveLength(1);
  expect(body.data[0].name).toBe("Tenant 101");
  expect(body.data[0]).not.toHaveProperty("commission");
});
it("protects single-record reads and rejects hidden query fields", async () => {
  const response = await f.request(
    "viewer",
    101,
    base + "/records/acl_contacts/" + rowId,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("commission");
  expect(
    (
      await f.request(
        "viewer",
        101,
        base + "/records/acl_contacts?sort=commission",
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request(
        "viewer",
        101,
        base +
          "/records/acl_contacts?filters=" +
          encodeURIComponent(
            JSON.stringify({
              conditions: [{ field: "commission", op: "eq", value: 101 }],
            }),
          ),
      )
    ).status,
  ).toBe(403);
});
it.each([
  "null",
  '{"conditions":{}}',
  '{"conditions":[null]}',
  '{"conditions":[{"field":"name"}]}',
])(
  "returns 422 for malformed filters in scoped record queries and exports (%s)",
  async (filters) => {
    const query = new URLSearchParams({ filters });
    for (const surface of ["records", "export"])
      expect(
        (
          await f.request(
            "viewer",
            101,
            `${base}/${surface}/acl_contacts?${query}`,
          )
        ).status,
      ).toBe(422);
  },
);

it("rejects unauthorized write fields and allows a permitted update", async () => {
  const init = (body: unknown) => ({
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(
    (
      await f.request(
        "viewer",
        101,
        base + "/records/acl_contacts/" + rowId,
        init({ commission: 1, _version: 1 }),
      )
    ).status,
  ).toBe(403);
  const response = await f.request(
    "viewer",
    101,
    base + "/records/acl_contacts/" + rowId,
    init({ name: "Permitted", _version: 1 }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("commission");
});
it("does not grant configuration, bulk or unrelated source operations", async () => {
  for (const path of [
    "/objects",
    "/records/acl_contacts/bulk",
    "/collection-bindings",
  ])
    expect(
      (
        await f.request("viewer", 101, base + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
});
it("does not grant bundle creates through a read/update-only role", async () => {
  const result = await f.request(
    "viewer",
    101,
    base + "/record-bundles/acl_contacts",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        record: { data: { name: "Unauthorized create" } },
        relations: [],
      }),
    },
  );
  expect(result.status).toBe(403);
});
it("does not bypass restrictions through published aliases", async () => {
  const response = await f.request(
    "viewer",
    101,
    base + "/published/acl_contacts/" + rowId,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("commission");
});
it("projects synchronization and binds cursors to the current policy", async () => {
  const response = await f.request(
    "viewer",
    101,
    base + "/local-sync/pull/acl_contacts",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    documents: Record<string, unknown>[];
    cursor: string;
  };
  expect(body.documents).toHaveLength(1);
  expect(body.documents[0]).not.toHaveProperty("commission");
  const manifest = await f.request(
    "viewer",
    101,
    base + "/local-sync/manifest",
  );
  expect(await manifest.text()).not.toContain('"commission"');
  const cursor = JSON.parse(atob(body.cursor));
  cursor.revision--;
  expect(
    (
      await f.request(
        "viewer",
        101,
        base +
          "/local-sync/pull/acl_contacts?cursor=" +
          encodeURIComponent(btoa(JSON.stringify(cursor))),
      )
    ).status,
  ).toBe(409);
});
it("sends removals only for records previously delivered to this principal", async () => {
  const first = await f.request(
    "viewer",
    101,
    base + "/local-sync/pull/acl_contacts",
  );
  const batch = (await first.json()) as { cursor: string };
  await f.request(
    "agency_admin",
    101,
    base + "/records/acl_contacts/" + rowId,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commission: 300, _version: 2 }),
    },
  );
  const response = await f.request(
    "viewer",
    101,
    base +
      "/local-sync/pull/acl_contacts?cursor=" +
      encodeURIComponent(batch.cursor),
  );
  const next = (await response.json()) as {
    removedIds: string[];
    documents: unknown[];
  };
  expect(next.removedIds).toEqual([rowId]);
  expect(JSON.stringify(next.documents)).not.toContain("commission");
});
it("rechecks current row visibility before replaying an acknowledged mutation", async () => {
  const created = await f.request(
    "agency_admin",
    101,
    base + "/records/acl_contacts",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Replay", commission: 100 }),
    },
  );
  const { data } = (await created.json()) as { data: { id: string } };
  const revision = (
    await loadAccessPolicy(f.db, await f.actor("viewer"), "tenant:101")
  ).revision;
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-savia-policy-revision": String(revision),
    },
    body: JSON.stringify({
      mutationId: crypto.randomUUID(),
      action: "update",
      id: data.id,
      data: { name: "Changed" },
      baseVersion: 1,
    }),
  };
  expect(
    (
      await f.request(
        "viewer",
        101,
        base + "/local-sync/push/acl_contacts",
        request,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(
        "agency_admin",
        101,
        base + "/records/acl_contacts/" + data.id,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commission: 300, _version: 2 }),
        },
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await f.request(
        "viewer",
        101,
        base + "/local-sync/push/acl_contacts",
        request,
      )
    ).status,
  ).toBe(403);
});
it("denies delegated access to extension, integration and configuration routes", async () => {
  for (const path of [
    "/extensions",
    "/connections",
    "/integrations",
    "/collection-bindings",
    "/automations",
  ]) {
    const response = await f.request("viewer", 101, base + path);
    expect(response.status).toBe(403);
  }
});
it("keeps page visibility separate from authorized data reads", async () => {
  expect(
    (await f.request("viewer", 101, base + "/objects/acl_contacts")).status,
  ).toBe(403);
  expect(
    (await f.request("viewer", 101, base + "/records/acl_contacts")).status,
  ).toBe(200);
});

it("restores only readable rows without committing a rejected restore", async () => {
  const admin = await f.actor("agency_admin");
  const revision = (await loadAccessPolicy(f.db, admin, "tenant:101")).revision;
  const role = await saveAccessRole(f.db, admin, {
    scope: "tenant:101",
    name: "trash-restorer",
    label: "Trash restorer",
    description: "",
    enabled: true,
    expectedRevision: revision,
    grants: [
      {
        resource: "page:acl_contacts",
        action: "read",
        predicate: { all: true },
        fields: [],
      },
      {
        resource: "collection:acl_contacts",
        action: "read",
        predicate: { field: "commission", op: "lt", value: { literal: 150 } },
        fields: ["name"],
      },
      {
        resource: "collection:acl_contacts",
        action: "restore",
        predicate: { all: true },
        fields: [],
      },
    ],
  });
  await replaceAccessAssignments(f.db, admin, {
    scope: "tenant:101",
    principalId: f.principalId("operator"),
    roleIds: [role.id],
    expectedRevision: role.revision,
  });
  const records = base + "/records/acl_contacts";
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const inTrash = async (name: string, commission: number) => {
    const created = await f.request(
      "agency_admin",
      101,
      records,
      json({ name, commission }),
    );
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };
    expect(
      (
        await f.request(
          "agency_admin",
          101,
          `${records}/${data.id}?version=1`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    return data.id;
  };
  const allowed = await inTrash("Readable", 100);
  const denied = await inTrash("Restricted", 200);
  const restore = (id: string) =>
    f.request(
      "operator",
      101,
      `${records}/${id}/restore`,
      json({ version: 2 }),
    );
  expect((await restore(denied)).status).toBe(403);
  expect(
    await f.db
      .prepare(
        "SELECT deleted_at, version FROM studio_records WHERE tenant_id='tenant:101' AND id=?",
      )
      .bind(denied)
      .first(),
  ).toMatchObject({ deleted_at: expect.any(String), version: 2 });
  const metadata = await f.request(
    "operator",
    101,
    base + "/objects/acl_contacts",
  );
  expect(await metadata.json()).toMatchObject({
    data: {
      config: { studio: { capabilities: { delete: false, restore: true } } },
    },
  });
  const trash = await f.request("operator", 101, records + "?trash=true");
  expect(await trash.json()).toMatchObject({
    data: [{ id: allowed, name: "Readable", _version: 2 }],
    total: 1,
  });
  const restored = await restore(allowed);
  expect(restored.status).toBe(200);
  const { data } = (await restored.json()) as { data: unknown };
  expect(data).toMatchObject({
    id: allowed,
    name: "Readable",
    _version: 3,
    deleted_at: null,
  });
  expect(data).not.toHaveProperty("commission");
});

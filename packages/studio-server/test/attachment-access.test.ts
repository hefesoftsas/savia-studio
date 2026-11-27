import { readFileSync, readdirSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AccessGrant } from "@savia/studio-shared/access-control";
import { makeConfig } from "@savia/studio-shared/metadata";
import { createStudioApp } from "../src/index";
import type { Env } from "../src/context";
import { migrationStatements } from "./migration-statements";

const tenant = "tenant:101";
const object = "attachment_access";
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env["Bindings"]>>>;

function scopedApp(principalId: string, action: "create" | "update") {
  const grant: AccessGrant = {
    id: "write-grant",
    roleId: "attachment-editor",
    resource: `collection:${object}`,
    action,
    predicate: { field: "region", op: "eq", value: { literal: "north" } },
    fields: ["name", "region", "contract"],
  };
  const app = createStudioApp(tenant, {
    principalId,
    accessPolicy: { principalId, scope: tenant, revision: 1, grants: [grant] },
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(`/api${path}`, init, platform.env);
  const json = (path: string, method: string, body: unknown, key?: string) =>
    request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify(body),
    });
  const upload = (target: Record<string, string>, field = "contract") => {
    const form = new FormData();
    form.set("field", field);
    form.set(
      "file",
      new File(["test contents"], "contract.pdf", { type: "application/pdf" }),
    );
    for (const [name, value] of Object.entries(target)) form.set(name, value);
    return request(`/file-drafts/${object}`, { method: "POST", body: form });
  };
  return { request, json, upload };
}

async function result(response: Response, status: number) {
  const body = await response.text();
  expect(response.status, body).toBe(status);
  return JSON.parse(body) as { data: { id: string; version: number } };
}

beforeAll(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
  });
  const db = platform.env.DB;
  for (const file of readdirSync("migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    for (const sql of migrationStatements(
      readFileSync(`migrations/${file}`, "utf8"),
    )) {
      await db.prepare(sql).run();
    }
  }
  await db.exec(
    "CREATE TABLE access_revisions(scope TEXT PRIMARY KEY,revision INTEGER); INSERT INTO access_revisions VALUES ('tenant:101',1)",
  );
  const config = makeConfig({
    name: { type: "Textbox", label: "Name" },
    region: { type: "Textbox", label: "Region" },
    contract: { type: "R2Attachment", label: "Contract" },
    restricted: { type: "R2Attachment", label: "Restricted" },
  });
  await db
    .prepare(
      "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES(?,?,?,?)",
    )
    .bind(tenant, object, "Attachments", JSON.stringify(config))
    .run();
  await db
    .prepare(
      "INSERT INTO studio_records(tenant_id,id,object_name,data,created_by) VALUES(?,'older',?,'{\"region\":\"north\"}','alice'),(?,'south',?,'{\"region\":\"south\"}','alice')",
    )
    .bind(tenant, object, tenant, object)
    .run();
});

afterAll(async () => platform?.dispose());

it("allows a creator to attach their own draft only to the record created by the matching request", async () => {
  const alice = scopedApp("alice", "create");
  const bob = scopedApp("bob", "create");
  const createRequestKey = "create-attachment-record";
  expect((await alice.upload({ createRequestKey }, "restricted")).status).toBe(
    403,
  );
  const { data: draft } = await result(
    await alice.upload({ createRequestKey }),
    201,
  );
  const path = `/file-drafts/${draft.id}/attach`;
  const download = `/file/${draft.id}/download`;
  expect(await (await alice.request(download)).text()).toBe("test contents");
  expect((await bob.request(download)).status).toBe(403);
  expect(
    (
      await bob.json(`/file/${draft.id}`, "DELETE", {
        version: draft.version,
        draftOnly: true,
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await alice.json(path, "POST", {
        recordId: "older",
        version: draft.version,
      })
    ).status,
  ).toBe(403);

  const { data: created } = await result(
    await alice.json(
      `/records/${object}`,
      "POST",
      { name: "New", region: "north" },
      createRequestKey,
    ),
    201,
  );
  expect((await alice.upload({ createRequestKey })).status).toBe(409);
  const body = { recordId: created.id, version: draft.version };
  expect((await bob.json(path, "POST", body)).status).toBe(403);
  const saved = await result(await alice.json(path, "POST", body), 200);
  expect(saved.data.id).toBe(draft.id);
  expect(await result(await alice.json(path, "POST", body), 200)).toEqual(
    saved,
  );
  expect((await alice.request(download)).status).toBe(403);
});

it("limits update drafts to their authorized record and lets the owner discard them", async () => {
  const alice = scopedApp("alice", "update");
  expect((await alice.upload({ recordId: "south" })).status).toBe(403);
  const { data: draft } = await result(
    await alice.upload({ recordId: "older" }),
    201,
  );
  const path = `/file/${draft.id}`;
  expect(
    (
      await alice.json(`/file-drafts/${draft.id}/attach`, "POST", {
        recordId: "south",
        version: draft.version,
      })
    ).status,
  ).toBe(403);
  await result(
    await alice.json(path, "DELETE", {
      version: draft.version,
      draftOnly: true,
    }),
    200,
  );
  expect(
    await platform.env.FILES.head(`${tenant}/temporary/${draft.id}`),
  ).toBeNull();
});

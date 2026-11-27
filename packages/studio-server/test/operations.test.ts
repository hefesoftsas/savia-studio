import { migrationStatements } from "./migration-statements";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { getPlatformProxy } from "wrangler";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { createStudioApp } from "../src/index";
import { registerOperations, runAutomations } from "../src/operations";
import { cleanDeletedAttachmentObjects } from "../src/attachment-deletions";
import {
  createRecord,
  updateRecord,
  deleteRecord,
  getRecord,
} from "../src/services";
import { createObject } from "../src/schema";
import { makeConfig, type StudioObject } from "@savia/studio-shared/metadata";
import { inferSpreadsheetSchema } from "@savia/studio-shared/spreadsheet-inference";
import {
  parseCsv,
  csvCell,
  csvLine,
  mapCsvRow,
} from "@savia/studio-shared/csv";
import type { AccessPolicy } from "@savia/studio-shared/access-control";
import type { Env } from "../src/context";
let platform: Awaited<ReturnType<typeof getPlatformProxy<Env["Bindings"]>>>;
const app = new Hono<Env>();
app.use("*", async (c, next) => {
  c.set("tenant", "demo");
  await next();
});
app.onError((error, c) =>
  error instanceof HTTPException
    ? c.json({ error: error.message }, error.status)
    : error instanceof z.ZodError
      ? c.json({ error: error.message }, 422)
      : c.json({ error: error.message }, 500),
);
registerOperations(app);
const request = (
  path: string,
  method = "GET",
  data?: unknown,
  env = platform.env,
) =>
  app.request(
    "http://localhost/api" + path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    },
    env,
  );
async function json(path: string, method = "GET", data?: unknown) {
  const response = await request(path, method, data),
    body = (await response.json()) as any;
  expect(response.status, JSON.stringify(body)).toBeLessThan(300);
  return body;
}
async function uploadFile(field: string, file: File) {
  const form = new FormData();
  form.set("file", file);
  form.set("field", field);
  const response = await app.request(
    `http://localhost/api/files/${object.name}/${record.id}`,
    { method: "POST", body: form },
    platform.env,
  );
  const body = (await response.json()) as { data?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body;
}
const object: StudioObject = {
  name: "operations_contact",
  label: "Contactos de operaciones",
  description: "",
  version: 1,
  config: makeConfig({
    name: { type: "Textbox", label: "Nombre", required: true },
    email: {
      type: "Textbox",
      label: "Correo",
      config: { unique: true, format: "email" },
    },
    amount: { type: "Number", label: "Importe" },
    stage: {
      type: "Dropdown",
      label: "Etapa",
      options: [
        { value: "Open", label: "Abierta" },
        { value: "Won", label: "Ganada" },
        { value: "Lost", label: "Perdida" },
      ],
    },
    owner: { type: "Textbox", label: "Responsable" },
    contract: {
      type: "R2Attachment",
      label: "Contrato",
      config: { accept: ["application/pdf"] },
    },
    photo: {
      type: "R2Attachment",
      label: "Foto",
      config: { accept: ["image/*"] },
    },
  }),
};
object.config.studio = {
  pipeline: {
    field: "stage",
    amountField: "amount",
    ownerField: "owner",
    wonValues: ["Won"],
    lostValues: ["Lost"],
  },
};
let record: Awaited<ReturnType<typeof createRecord>>;
beforeAll(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
  });
  for (const name of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort())
    for (const sql of migrationStatements(
      readFileSync(`migrations/${name}`, "utf8"),
    ))
      await platform.env.DB.prepare(sql).run();
  await platform.env.DB.prepare(
    "INSERT INTO studio_objects(tenant_id,name,label,description,config) VALUES (?,?,?,?,?)",
  )
    .bind("demo", object.name, object.label, "", JSON.stringify(object.config))
    .run();
  record = await createRecord(platform.env.DB, "demo", object.name, {
    name: "Inicial",
    email: "initial@example.com",
    amount: 200,
    stage: "Open",
    owner: "Ana",
  });
});
afterAll(async () => {
  await platform?.dispose();
});

describe("CSV parsing and mapping", () => {
  it("parses BOM, quoted newlines, escaped quotes and semicolon files", () => {
    expect(parseCsv('\uFEFFname,email\r\n"Uno, dos\nTres","a""b"\r\n')).toEqual(
      { headers: ["name", "email"], rows: [["Uno, dos\nTres", 'a"b']] },
    );
    expect(parseCsv("name;email\na;b").rows).toEqual([["a", "b"]]);
    expect(
      parseCsv(
        '\uFEFF\r\n""\r\n"Nombre, ""principal""\r\ncompleto";Correo\r\n"Ana; María";ana@example.com\r\n',
      ),
    ).toEqual({
      headers: ['Nombre, "principal"\r\ncompleto', "Correo"],
      rows: [["Ana; María", "ana@example.com"]],
    });
    expect(parseCsv('"Nombre; completo",Correo\nAna,ana@example.com')).toEqual({
      headers: ["Nombre; completo", "Correo"],
      rows: [["Ana", "ana@example.com"]],
    });
    expect(() => parseCsv('name\n"unfinished')).toThrow("comillas");
    expect(() => parseCsv("name,email\na,b,c")).toThrow("Fila 2");
    expect(() => parseCsv("a,a\n1,2")).toThrow("únicos");
  });
  it("neutralizes spreadsheet formulas and reports typed validation", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe('"\'=HYPERLINK(1)"');
    expect(csvCell(-12)).toBe('"-12"');
    expect(
      mapCsvRow(object, ["n", "a"], ["Alice", "bad"], {
        n: "name",
        a: "amount",
      }).errors.amount,
    ).toContain("número");
  });
});
describe("Operations with real D1 and R2", () => {
  it("previews errors and duplicates, imports good rows, and replays without duplicate records", async () => {
    const input = {
      csv: '"Nombre, completo";Correo;Importe\nNueva;new@example.com;20,00\nDuplicada;INITIAL@example.com;30\nInválida;not-email;abc',
      mapping: {
        "Nombre, completo": "name",
        Correo: "email",
        Importe: "amount",
      },
    };
    const preview = await json(`/import/${object.name}/preview`, "POST", input);
    expect(preview.summary).toEqual({
      ready: 1,
      created: 0,
      skipped: 1,
      errors: 1,
    });
    expect(preview.data[0]).toMatchObject({
      status: "ready",
      data: { amount: 20 },
    });
    const commit = await json(`/import/${object.name}/commit`, "POST", {
      ...input,
      importId: preview.importId,
    });
    expect(commit.summary.created).toBe(1);
    expect(commit.summary.errors).toBe(1);
    const saved = await platform.env.DB.prepare(
      "SELECT data FROM studio_records WHERE tenant_id=? AND object_name=? AND id=?",
    )
      .bind("demo", object.name, commit.data[0].id)
      .first<{ data: string }>();
    expect(JSON.parse(saved!.data)).toMatchObject({ amount: 20 });
    const replay = await json(`/import/${object.name}/commit`, "POST", {
      ...input,
      importId: preview.importId,
    });
    expect(replay).toEqual(commit);

    const conflict = await json(`/import/${object.name}/commit`, "POST", {
      ...input,
      csv: input.csv.replace("Nueva;", "Cambiada;"),
      importId: preview.importId,
    });
    expect(conflict.data[0]).toMatchObject({
      row: 2,
      status: "error",
      error: "Esta clave ya se usó con otros datos.",
    });
    expect(
      (
        await platform.env.DB.prepare(
          "SELECT count(*) AS total FROM studio_records WHERE object_name=?",
        )
          .bind(object.name)
          .first<any>()
      ).total,
    ).toBe(2);
  });
  it("keeps spreadsheet IDs and dates separate from record metadata", async () => {
    const db = platform.env.DB;
    const name = "imported_identifiers";
    const headers = ["ID", "Created at", "Name"];
    const rows = [
      ["00042", "2021-06-15", "Ana"],
      ["00043", "2021-06-16", "Luis"],
    ];
    const { columns, config } = inferSpreadsheetSchema({ headers, rows });
    await createObject(db, "demo", { name, label: "Imported records", config });
    const input = {
      csv: csvLine(headers) + rows.map(csvLine).join(""),
      mapping: Object.fromEntries(
        columns.map(({ originalHeader, key }) => [originalHeader, key]),
      ),
    };
    const preview = await json(`/import/${name}/preview`, "POST", input);
    const committed = await json(`/import/${name}/commit`, "POST", {
      ...input,
      importId: preview.importId,
    });
    expect(committed.summary.created).toBe(2);
    const saved = await getRecord(db, "demo", name, committed.data[0].id);
    expect(saved).toMatchObject({
      id_2: "00042",
      created_at_2: "2021-06-15",
      name: "Ana",
    });
    expect(saved.id).not.toBe("00042");
    expect(saved.created_at).not.toBe("2021-06-15");
  });

  it.each(["skip", "error"] as const)(
    "applies the CSV %s policy to concurrent duplicates",
    async (duplicatePolicy) => {
      const db = platform.env.DB;
      const name = `csv_race_${duplicatePolicy}`;
      await db
        .prepare(
          "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
        )
        .bind(
          "demo",
          name,
          "CSV",
          JSON.stringify(
            makeConfig({
              code: { type: "Textbox", label: "Código" },
            }),
          ),
        )
        .run();

      // Let both requests finish their preflight before either transaction starts.
      let reached = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const concurrent = new Proxy(db, {
        get(target, key) {
          if (key === "batch")
            return async (statements: D1PreparedStatement[]) => {
              if (++reached === 2) release();
              await gate;
              return target.batch(statements);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const input = {
        csv: "code\nA-1",
        mapping: { code: "code" },
        duplicateField: "code",
        duplicatePolicy,
      };
      const previews = await Promise.all([
        json(`/import/${name}/preview`, "POST", input),
        json(`/import/${name}/preview`, "POST", input),
      ]);
      const results = await Promise.all(
        previews.map(async ({ importId }) => {
          const response = await request(
            `/import/${name}/commit`,
            "POST",
            { ...input, importId },
            { ...platform.env, DB: concurrent },
          );
          const body = (await response.json()) as {
            data: { status: string; error?: string }[];
          };
          expect(response.status, JSON.stringify(body)).toBe(200);
          return body.data[0];
        }),
      );
      expect(results.map(({ status }) => status).sort()).toEqual([
        "created",
        duplicatePolicy === "skip" ? "skipped" : "error",
      ]);
      expect(
        results.find(({ status }) => status !== "created")?.error,
      ).toContain("valor duplicado");
      const saved = await db
        .prepare(
          "SELECT count(*) AS total FROM studio_records WHERE tenant_id=? AND object_name=?",
        )
        .bind("demo", name)
        .first<{ total: number }>();
      expect(saved?.total).toBe(1);
    },
  );

  it("allows a later CSV row to reuse a value after a failed write", async () => {
    const name = "csv_failed_write";
    const db = platform.env.DB;
    const config = makeConfig({
      name: { type: "Textbox", label: "Nombre" },
      code: { type: "Textbox", label: "Código" },
    });
    await db
      .prepare(
        "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
      )
      .bind("demo", name, "CSV", JSON.stringify(config))
      .run();
    await db
      .prepare(
        `
      CREATE TRIGGER csv_reject_failed_write BEFORE INSERT ON studio_records
      WHEN NEW.tenant_id='demo' AND NEW.object_name='csv_failed_write'
        AND json_extract(NEW.data, '$.name')='Bloqueada'
      BEGIN SELECT RAISE(ABORT, 'CSV fixture rejected the record'); END
    `,
      )
      .run();

    const input = {
      csv: "name,code\nBloqueada,A-1\nVálida,A-1\nDuplicada,A-1",
      mapping: { name: "name", code: "code" },
      duplicateField: "code",
    };
    const preview = await json(`/import/${name}/preview`, "POST", input);
    const confirmation = { ...input, importId: preview.importId };
    const result = await json(`/import/${name}/commit`, "POST", confirmation);
    expect(result.summary).toMatchObject({ created: 1, skipped: 1, errors: 1 });
    expect(result.data.map(({ status }: { status: string }) => status)).toEqual(
      ["error", "created", "skipped"],
    );

    const retry = await json(`/import/${name}/commit`, "POST", confirmation);
    expect(retry.data[1]).toMatchObject({
      status: "created",
      id: result.data[1].id,
    });
    const saved = await db
      .prepare(
        "SELECT data FROM studio_records WHERE tenant_id=? AND object_name=?",
      )
      .bind("demo", name)
      .all<{ data: string }>();
    expect(saved.results.map(({ data }) => JSON.parse(data))).toEqual([
      { name: "Válida", code: "A-1" },
    ]);
  });

  it("checks updated CSV import grants before writing any rows", async () => {
    const tenant = "tenant:304";
    const name = "csv_permission_changes";
    const db = platform.env.DB;
    await db.exec(
      "CREATE TABLE IF NOT EXISTS access_revisions(scope TEXT PRIMARY KEY,revision INTEGER)",
    );
    await db
      .prepare("INSERT INTO access_revisions VALUES (?,1)")
      .bind(tenant)
      .run();
    const config = makeConfig({
      name: { type: "Textbox", label: "Nombre" },
      amount: { type: "Number", label: "Importe" },
    });
    await db
      .prepare(
        "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
      )
      .bind(tenant, name, "Importaciones", JSON.stringify(config))
      .run();

    const requestImport = (
      revision: number,
      predicate: AccessPolicy["grants"][number]["predicate"],
      phase: "preview" | "commit",
      body: object,
    ) => {
      const principalId = "csv-importer";
      const resource = `collection:${name}` as const;
      const fields = ["name", "amount"];
      const app = createStudioApp(tenant, {
        principalId,
        accessPolicy: {
          scope: tenant,
          revision,
          principalId,
          grants: [
            {
              id: "import",
              roleId: "importer",
              resource,
              action: "import",
              fields,
              predicate,
            },
            {
              id: "create",
              roleId: "importer",
              resource,
              action: "create",
              fields,
              predicate: { all: true },
            },
          ],
        },
      });
      return app.request(
        `http://localhost/api/import/${name}/${phase}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
        platform.env,
      );
    };
    const input = {
      csv: "name;amount\nPermitida;9,50\nRestringida;12,50",
      mapping: { name: "name", amount: "amount" },
    };
    const preview = await requestImport(1, { all: true }, "preview", input);
    expect(preview.status).toBe(200);
    const { importId, summary } = (await preview.json()) as {
      importId: string;
      summary: { ready: number };
    };
    expect(summary.ready).toBe(2);

    await db
      .prepare("UPDATE access_revisions SET revision=2 WHERE scope=?")
      .bind(tenant)
      .run();
    const result = await requestImport(
      2,
      { field: "amount", op: "lte", value: { literal: 10 } },
      "commit",
      { ...input, importId },
    );
    expect(result.status).toBe(403);
    const saved = await db
      .prepare(
        "SELECT count(*) AS total FROM studio_records WHERE tenant_id=? AND object_name=?",
      )
      .bind(tenant, name)
      .first<{ total: number }>();
    expect(saved?.total).toBe(0);
    const receipts = await db
      .prepare(
        "SELECT count(*) AS total FROM studio_requests WHERE tenant_id=?",
      )
      .bind(tenant)
      .first<{ total: number }>();
    expect(receipts?.total).toBe(0);
  });

  it("rejects only CSV rows with unavailable relations under scoped access", async () => {
    const tenant = "tenant:303";
    const db = platform.env.DB;
    const groups = "csv_groups";
    const name = "csv_members";
    await db.exec(
      "CREATE TABLE IF NOT EXISTS access_revisions(scope TEXT PRIMARY KEY,revision INTEGER)",
    );
    await db
      .prepare("INSERT INTO access_revisions VALUES (?,1)")
      .bind(tenant)
      .run();

    const groupConfig = makeConfig({
      name: { type: "Textbox", label: "Grupo" },
    });
    const memberConfig = makeConfig({
      name: { type: "Textbox", label: "Nombre" },
      groups: {
        type: "Dropdown",
        label: "Grupos",
        config: {
          relation: groups,
          collectionRelation: "manual",
          multiple: true,
        },
      },
    });
    const insertObject = db.prepare(
      "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
    );
    await db.batch([
      insertObject.bind(tenant, groups, "Grupos", JSON.stringify(groupConfig)),
      insertObject.bind(tenant, name, "Miembros", JSON.stringify(memberConfig)),
    ]);
    const visible = await createRecord(db, tenant, groups, { name: "Visible" });
    const hidden = await createRecord(db, tenant, groups, {
      name: "Restringido",
    });
    const policy: AccessPolicy = {
      principalId: "csv-importer",
      scope: tenant,
      revision: 1,
      grants: [
        ...(["create", "import"] as const).map((action) => ({
          id: `member-${action}`,
          roleId: "importer",
          resource: `collection:${name}` as const,
          action,
          predicate: { all: true } as const,
          fields: ["name", "groups"],
        })),
        {
          id: "visible-groups",
          roleId: "importer",
          resource: `collection:${groups}`,
          action: "read",
          predicate: { field: "name", op: "eq", value: { literal: "Visible" } },
          fields: ["name"],
        },
      ],
    };
    const scopedApp = createStudioApp(tenant, {
      principalId: policy.principalId,
      accessPolicy: policy,
    });
    const input = {
      csv:
        csvLine(["name", "groups"]) +
        csvLine(["Ausente", JSON.stringify(["missing"])]) +
        csvLine(["Restringido", JSON.stringify([visible.id, hidden.id])]) +
        csvLine(["Válido", JSON.stringify([visible.id])]),
      mapping: { name: "name", groups: "groups" },
    };
    const send = async (phase: "preview" | "commit", data: object) => {
      const response = await scopedApp.request(
        `http://localhost/api/import/${name}/${phase}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        },
        platform.env,
      );
      const result = (await response.json()) as any;
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    };

    const preview = await send("preview", input);
    expect(preview.summary).toMatchObject({ ready: 1, errors: 2 });
    expect(preview.data.map((row: { status: string }) => row.status)).toEqual([
      "error",
      "error",
      "ready",
    ]);
    expect(preview.data[0].error).toBe(
      "Grupos requiere un registro relacionado disponible.",
    );
    expect(preview.data[0].error).toEqual(preview.data[1].error);

    const committed = await send("commit", {
      ...input,
      importId: preview.importId,
    });
    expect(committed.summary).toMatchObject({ created: 1, errors: 2 });
    expect(committed.data.map((row: { status: string }) => row.status)).toEqual(
      ["error", "error", "created"],
    );
    expect(committed.data[0].error).toEqual(committed.data[1].error);
    const saved = await db
      .prepare(
        "SELECT data FROM studio_records WHERE tenant_id=? AND object_name=?",
      )
      .bind(tenant, name)
      .all<{ data: string }>();
    expect(saved.results.map(({ data }) => JSON.parse(data))).toEqual([
      { name: "Válido", groups: [visible.id] },
    ]);
  });

  it("paginates inbound relations and excludes deleted records", async () => {
    const config = makeConfig({
      name: { type: "Textbox", label: "Nombre" },
      contacts: {
        type: "Dropdown",
        label: "Contactos",
        config: { relation: object.name, multiple: true },
      },
    });
    await platform.env.DB.prepare(
      "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
    )
      .bind(
        "demo",
        "operations_related",
        "Relacionados",
        JSON.stringify(config),
      )
      .run();
    await platform.env.DB.batch(
      Array.from({ length: 26 }, (_, i) =>
        platform.env.DB.prepare(
          "INSERT INTO studio_records(id,tenant_id,object_name,data,deleted_at) VALUES (?,?,?,?,?)",
        ).bind(
          `related-${i}`,
          "demo",
          "operations_related",
          JSON.stringify({ name: `Relacionado ${i}`, contacts: [record.id] }),
          i === 25 ? new Date().toISOString() : null,
        ),
      ),
    );
    const first = await json(`/record-detail/${object.name}/${record.id}`),
      second = await json(`/record-detail/${object.name}/${record.id}?page=2`);
    expect(first.data.relations[0].total).toBe(25);
    expect(first.data.relations[0].records).toHaveLength(20);
    expect(second.data.relations[0].records).toHaveLength(5);
  });
  it("saves notes and uploads/downloads/deletes real R2 content", async () => {
    const note = await json(
      `/record-notes/${object.name}/${record.id}`,
      "POST",
      { body: "Llamada: próxima reunión el lunes.", kind: "call" },
    );
    expect(
      (await json(`/record-activity/${object.name}/${record.id}`)).data.some(
        (n: any) => n.id === note.data.id,
      ),
    ).toBe(true);
    const form = new FormData();
    form.set(
      "file",
      new File(["contenido verificable"], "acuerdo.txt", {
        type: "text/plain",
      }),
    );
    const upload = await app.request(
      `http://localhost/api/files/${object.name}/${record.id}`,
      { method: "POST", body: form },
      platform.env,
    );
    const file = (await upload.json()) as any;
    expect(upload.status, JSON.stringify(file)).toBe(201);
    const download = await request(`/file/${file.data.id}/download`);
    expect(await download.text()).toBe("contenido verificable");
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(
      (await request(`/file/${file.data.id}`, "DELETE", { version: 99 }))
        .status,
    ).toBe(409);
    await json(`/file/${file.data.id}`, "DELETE", { version: 1 });
    expect(
      (await json(`/files/${object.name}/${record.id}`)).data,
    ).toHaveLength(0);
    expect((await request(`/file/${file.data.id}/download`)).status).toBe(404);
  });

  it("retries storage cleanup for a deleted attachment and its revisions", async () => {
    const uploaded = await uploadFile(
      "contract",
      new File(["latest"], "contract.pdf", { type: "application/pdf" }),
    );
    const { id } = uploaded.data as { id: string };
    const db = platform.env.DB;
    const latest = (await db
      .prepare("SELECT storage_key FROM studio_files WHERE id=?")
      .bind(id)
      .first<string>("storage_key"))!;
    const original = `${latest}/revisions/original`;
    await platform.env.FILES.put(original, "original");
    await db.batch([
      db.prepare("UPDATE studio_files SET version=2 WHERE id=?").bind(id),
      db
        .prepare(
          "INSERT INTO studio_file_revisions (tenant_id,file_id,version,storage_key,size) VALUES ('demo',?,1,?,8),('demo',?,2,?,6)",
        )
        .bind(id, original, id, latest),
    ]);

    const failDelete = vi.fn(async () => {
      throw new Error("R2 delete unavailable");
    });
    const unavailable = {
      ...platform.env,
      FILES: new Proxy(platform.env.FILES, {
        get(target, property, receiver) {
          return property === "delete"
            ? failDelete
            : Reflect.get(target, property, receiver);
        },
      }),
    };
    const path = `/file/${id}`;
    const deleted = await request(path, "DELETE", { version: 2 }, unavailable);
    expect(deleted.status, await deleted.text()).toBe(200);
    expect(failDelete).toHaveBeenCalledTimes(1);
    expect((await request(`${path}/download`)).status).toBe(404);
    expect(await platform.env.FILES.head(latest)).not.toBeNull();
    expect(await platform.env.FILES.head(original)).not.toBeNull();

    await json(path, "DELETE", { version: 2 });
    const pending = await db
      .prepare(
        "SELECT storage_key,next_attempt_at FROM studio_file_deletions WHERE file_id=? ORDER BY storage_key",
      )
      .bind(id)
      .all<{ storage_key: string; next_attempt_at: number }>();
    expect(pending.results.map(({ storage_key }) => storage_key)).toEqual([
      latest,
      original,
    ]);
    expect(
      pending.results.every(
        ({ next_attempt_at }) => next_attempt_at > Date.now(),
      ),
    ).toBe(true);
    await db
      .prepare(
        "UPDATE studio_file_deletions SET next_attempt_at=0 WHERE file_id=?",
      )
      .bind(id)
      .run();
    await cleanDeletedAttachmentObjects(db, platform.env.FILES);
    expect(await platform.env.FILES.head(latest)).toBeNull();
    expect(await platform.env.FILES.head(original)).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT storage_key FROM studio_file_deletions WHERE file_id=?",
        )
        .bind(id)
        .first(),
    ).toBeNull();
    const deletions = await db
      .prepare(
        "SELECT count(*) AS total FROM studio_audit WHERE action='file.deleted' AND record_id=? AND detail=?",
      )
      .bind(record.id, JSON.stringify({ name: "contract.pdf" }))
      .first<number>("total");
    expect(deletions).toBe(1);
  });

  it.each(["draft", "saved"] as const)(
    "confirms a %s upload when the database commits before losing its reply",
    async (kind) => {
      const filename = `${kind}-confirmed.pdf`;
      const table = kind === "draft" ? "studio_file_drafts" : "studio_files";
      const path =
        kind === "draft"
          ? `/file-drafts/${object.name}`
          : `/files/${object.name}/${record.id}`;
      const db = platform.env.DB;
      const commitAndDisconnect = vi.fn(
        async (statements: D1PreparedStatement[]) => {
          await db.batch(statements);
          throw new Error("Database reply lost after commit");
        },
      );
      const environment = {
        ...platform.env,
        DB: new Proxy(db, {
          get(target, property, receiver) {
            return property === "batch"
              ? commitAndDisconnect
              : Reflect.get(target, property, receiver);
          },
        }),
      };
      const form = new FormData();
      form.set("field", "contract");
      form.set(
        "file",
        new File(["stored bytes"], filename, { type: "application/pdf" }),
      );
      const response = await app.request(
        `http://localhost/api${path}`,
        { method: "POST", body: form },
        environment,
      );

      const stored = await db
        .prepare(
          `SELECT id,storage_key FROM ${table} WHERE tenant_id=? AND name=?`,
        )
        .bind("demo", filename)
        .first<{ id: string; storage_key: string }>();
      expect(stored).not.toBeNull();
      expect(
        await (await platform.env.FILES.get(stored!.storage_key))?.text(),
      ).toBe("stored bytes");
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({
        data: { id: stored!.id, version: 1 },
      });
      expect(commitAndDisconnect).toHaveBeenCalledOnce();
      await json(`/file/${stored!.id}`, "DELETE", { version: 1 });
    },
  );

  it("keeps a failed upload eligible for cleanup through an R2 outage", async () => {
    const db = platform.env.DB;
    const dbFailure = vi.fn(async () => {
      throw new Error("Database write unavailable");
    });
    const deleteFailure = vi.fn(async (_keys: string[]) => {
      throw new Error("R2 delete unavailable");
    });
    const environment = {
      ...platform.env,
      DB: new Proxy(db, {
        get: (target, property, receiver) =>
          property === "batch"
            ? dbFailure
            : Reflect.get(target, property, receiver),
      }),
      FILES: new Proxy(platform.env.FILES, {
        get: (target, property, receiver) =>
          property === "delete"
            ? deleteFailure
            : Reflect.get(target, property, receiver),
      }),
    };
    const form = new FormData();
    form.set("field", "contract");
    form.set(
      "file",
      new File(["orphaned"], "failed-upload.pdf", { type: "application/pdf" }),
    );
    const response = await app.request(
      `http://localhost/api/files/${object.name}/${record.id}`,
      { method: "POST", body: form },
      environment,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Database write unavailable",
    });
    expect(dbFailure).toHaveBeenCalledOnce();
    expect(deleteFailure).toHaveBeenCalledOnce();

    const [keys] = deleteFailure.mock.calls[0];
    expect(keys).toHaveLength(1);
    const [key] = keys;
    const entry = db
      .prepare(
        "SELECT next_attempt_at FROM studio_file_deletions WHERE storage_key=?",
      )
      .bind(key);
    expect(await entry.first<number>("next_attempt_at")).toBeGreaterThan(
      Date.now(),
    );
    expect(await platform.env.FILES.head(key)).not.toBeNull();
    expect(
      await db
        .prepare("SELECT 1 FROM studio_files WHERE storage_key=?")
        .bind(key)
        .first(),
    ).toBeNull();
    await db
      .prepare(
        "UPDATE studio_file_deletions SET next_attempt_at=0 WHERE storage_key=?",
      )
      .bind(key)
      .run();
    await cleanDeletedAttachmentObjects(db, platform.env.FILES);

    expect(await platform.env.FILES.head(key)).toBeNull();
    expect(await entry.first()).toBeNull();
  });

  it("does not publish a late upload after maintenance claims its key", async () => {
    const { DB: db, FILES: files } = platform.env;
    let removed!: () => void;
    let finish!: () => void;
    const bytesRemoved = new Promise<void>((resolve) => {
      removed = resolve;
    });
    const finishCleanup = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const slowCleanup = new Proxy(files, {
      get(target, property, receiver) {
        if (property === "delete")
          return async (keys: string[]) => {
            await target.delete(keys);
            removed();
            await finishCleanup;
          };
        return Reflect.get(target, property, receiver);
      },
    });
    let key = "";
    let cleanup: Promise<unknown> | undefined;
    const lateUpload = new Proxy(files, {
      get(target, property, receiver) {
        if (property === "put")
          return async (
            storageKey: string,
            bytes: ArrayBuffer,
            options: R2PutOptions,
          ) => {
            key = storageKey;
            const clock = vi
              .spyOn(Date, "now")
              .mockReturnValue(Date.now() + 48 * 60 * 60 * 1000);
            cleanup = cleanDeletedAttachmentObjects(db, slowCleanup, {
              tenant: "demo",
              fileId: storageKey.split("/").at(-1)!,
            });
            clock.mockRestore();
            await bytesRemoved;
            return target.put(storageKey, bytes, options);
          };
        return Reflect.get(target, property, receiver);
      },
    });
    const form = new FormData();
    form.set("field", "contract");
    form.set(
      "file",
      new File(["late"], "late-upload.pdf", { type: "application/pdf" }),
    );

    try {
      const response = await app.request(
        `http://localhost/api/files/${object.name}/${record.id}`,
        { method: "POST", body: form },
        { ...platform.env, FILES: lateUpload },
      );
      expect(response.status, await response.text()).toBe(409);
    } finally {
      finish();
      await cleanup;
    }

    expect(
      await db
        .prepare("SELECT 1 FROM studio_files WHERE storage_key=?")
        .bind(key)
        .first(),
    ).toBeNull();
    expect(await platform.env.FILES.head(key)).not.toBeNull();
    const rearmed = await db
      .prepare(
        "UPDATE studio_file_deletions SET next_attempt_at=0 WHERE storage_key=?",
      )
      .bind(key)
      .run();
    expect(rearmed.meta.changes).toBe(1);
    await cleanDeletedAttachmentObjects(db, files);
    expect(await files.head(key)).toBeNull();
  });

  it("keeps an uploaded attachment temporary until a record is saved and deletes it on cancellation", async () => {
    const form = new FormData();
    form.set("field", "contract");
    form.set(
      "file",
      new File(["temporary contract"], "temporary-contract.pdf", {
        type: "application/pdf",
      }),
    );
    const upload = await app.request(
      `http://localhost/api/file-drafts/${object.name}`,
      { method: "POST", body: form },
      platform.env,
    );
    const temporaryBody = await upload.text();
    expect(upload.status, temporaryBody).toBe(201);
    const temporary = JSON.parse(temporaryBody) as {
      data?: any;
      error?: string;
    };
    expect(temporary.data).toMatchObject({
      name: "temporary-contract.pdf",
      field: "contract",
      version: 1,
    });
    expect(
      await (await request(`/file/${temporary.data.id}/download`)).text(),
    ).toBe("temporary contract");

    const target = { id: "temporary-target-9" };
    await platform.env.DB.prepare(
      "INSERT INTO studio_records(id,tenant_id,object_name,data) VALUES (?,?,?,?)",
    )
      .bind(
        target.id,
        "demo",
        object.name,
        JSON.stringify({ name: "Con adjunto temporal" }),
      )
      .run();
    expect((await json(`/files/${object.name}/${target.id}`)).data).toEqual([]);

    const attachPath = `/file-drafts/${temporary.data.id}/attach`;
    const attachInput = {
      recordId: target.id,
      version: temporary.data.version,
    };
    const [attached, concurrent] = await Promise.all([
      json(attachPath, "POST", attachInput),
      json(attachPath, "POST", attachInput),
    ]);
    expect(concurrent).toEqual(attached);
    expect(attached.data).toMatchObject({
      id: temporary.data.id,
      recordId: target.id,
      version: 2,
    });
    await expect(json(attachPath, "POST", attachInput)).resolves.toEqual(
      attached,
    );
    for (const input of [
      { ...attachInput, recordId: record.id },
      { ...attachInput, version: 2 },
    ]) {
      const response = await request(attachPath, "POST", input);
      expect(response.status).toBe(404);
      expect(await response.json()).not.toHaveProperty("code");
    }
    const auditCount = await platform.env.DB.prepare(
      "SELECT count(*) AS total FROM studio_audit WHERE tenant_id=? AND action=? AND record_id=?",
    )
      .bind("demo", "file.attached", target.id)
      .first<{ total: number }>();
    expect(auditCount?.total).toBe(1);
    await json(`/file/${temporary.data.id}`, "DELETE", {
      version: attached.data.version,
      draftOnly: true,
    });
    expect((await json(`/files/${object.name}/${target.id}`)).data).toEqual([
      expect.objectContaining({
        id: temporary.data.id,
        name: "temporary-contract.pdf",
        field: "contract",
        version: 2,
      }),
    ]);
    expect(
      await (await request(`/file/${temporary.data.id}/download`)).text(),
    ).toBe("temporary contract");

    const abandonedForm = new FormData();
    abandonedForm.set("field", "contract");
    abandonedForm.set(
      "file",
      new File(["cancelled contract"], "cancelled-contract.pdf", {
        type: "application/pdf",
      }),
    );
    const abandonedUpload = await app.request(
      `http://localhost/api/file-drafts/${object.name}`,
      { method: "POST", body: abandonedForm },
      platform.env,
    );
    const abandoned = (await abandonedUpload.json()) as { data?: any };
    expect(abandonedUpload.status).toBe(201);
    await json(`/file/${abandoned.data.id}`, "DELETE", {
      version: abandoned.data.version,
      draftOnly: true,
    });
    expect((await request(`/file/${abandoned.data.id}/download`)).status).toBe(
      404,
    );
    await json(`/file/${temporary.data.id}`, "DELETE", { version: 2 });
    await platform.env.DB.prepare(
      "DELETE FROM studio_records WHERE tenant_id=? AND id=?",
    )
      .bind("demo", target.id)
      .run();
  });
  it("accepts a new attachment if deleting an expired draft fails", async () => {
    const upload = (env = platform.env) => {
      const form = new FormData();
      form.set("field", "contract");
      form.set(
        "file",
        new File(["file contents"], "contract.pdf", {
          type: "application/pdf",
        }),
      );
      return app.request(
        `http://localhost/api/file-drafts/${object.name}`,
        { method: "POST", body: form },
        env,
      );
    };
    const previous = await upload();
    expect(previous.status).toBe(201);
    const { data: draft } = (await previous.json()) as {
      data: { id: string; version: number };
    };
    const key = `demo/temporary/${draft.id}`;
    const expireDraft = (id: string) =>
      platform.env.DB.prepare(
        "UPDATE studio_file_drafts SET expires_at=? WHERE tenant_id=? AND id=?",
      )
        .bind("2000-01-01T00:00:00.000Z", "demo", id)
        .run();
    await expireDraft(draft.id);

    const failDelete = vi.fn(async () => {
      throw new Error("R2 delete unavailable");
    });
    const unavailableCleanup = {
      ...platform.env,
      FILES: new Proxy(platform.env.FILES, {
        get(target, property, receiver) {
          return property === "delete"
            ? failDelete
            : Reflect.get(target, property, receiver);
        },
      }),
    };
    const uploaded = await upload(unavailableCleanup);
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { data: newDraft } = (await uploaded.json()) as {
      data: { id: string; version: number };
    };
    expect(failDelete).toHaveBeenCalled();

    expect(
      (
        await request(
          `/file-drafts/${draft.id}/attach`,
          "POST",
          {
            recordId: record.id,
            version: draft.version,
          },
          unavailableCleanup,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/file/${draft.id}/download`,
          "GET",
          undefined,
          unavailableCleanup,
        )
      ).status,
    ).toBe(404);
    expect(await platform.env.FILES.head(key)).not.toBeNull();
    expect(
      await platform.env.DB.prepare(
        "SELECT id FROM studio_file_drafts WHERE id=?",
      )
        .bind(draft.id)
        .first(),
    ).not.toBeNull();

    expect((await request(`/file/${draft.id}/download`)).status).toBe(404);
    expect(await platform.env.FILES.head(key)).toBeNull();
    expect(
      await platform.env.DB.prepare(
        "SELECT id FROM studio_file_drafts WHERE id=?",
      )
        .bind(draft.id)
        .first(),
    ).toBeNull();

    const racingExpiry = new Proxy(platform.env.DB, {
      get(target, property, receiver) {
        if (property !== "batch")
          return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          await expireDraft(newDraft.id);
          return target.batch(statements);
        };
      },
    });
    const expiredBeforeCommit = await request(
      `/file-drafts/${newDraft.id}/attach`,
      "POST",
      { recordId: record.id, version: newDraft.version },
      { ...platform.env, DB: racingExpiry },
    );
    expect(expiredBeforeCommit.status).toBe(409);
    const retry = await request(`/file-drafts/${newDraft.id}/attach`, "POST", {
      recordId: record.id,
      version: newDraft.version,
    });
    expect(retry.status).toBe(404);
    expect(await retry.json()).toMatchObject({
      code: "ATTACHMENT_DRAFT_UNAVAILABLE",
    });
    expect(
      await platform.env.DB.prepare("SELECT id FROM studio_files WHERE id=?")
        .bind(newDraft.id)
        .first(),
    ).toBeNull();
    expect((await request(`/file/${newDraft.id}/download`)).status).toBe(404);
  });

  it.each([
    ["draft", "field"],
    ["direct", "field"],
    ["draft", "record"],
  ] as const)(
    "checks the %s attachment against the %s limit at commit time",
    async (delayedUpload, limit) => {
      const { id: recordId } = await createRecord(
        platform.env.DB,
        "demo",
        object.name,
        { name: "Concurrent attachments" },
      );
      const filePath = `/files/${object.name}/${recordId}`;
      const fieldPath = `${filePath}?field=contract`;
      if (limit === "record") {
        await platform.env.DB.batch(
          Array.from({ length: 49 }, (_, index) => {
            const id = `${recordId}-existing-${index}`;
            return platform.env.DB.prepare(
              `INSERT INTO studio_files (id,tenant_id,object_name,record_id,field_name,name,mime,size,storage_key)
               VALUES (?,?,?,?,'photo','existing.png','image/png',1,?)`,
            ).bind(id, "demo", object.name, recordId, id);
          }),
        );
      }
      const upload = (path: string, env = platform.env) => {
        const form = new FormData();
        form.set("field", "contract");
        form.set(
          "file",
          new File(["test attachment"], "contract.pdf", {
            type: "application/pdf",
          }),
        );
        return app.request(
          `http://localhost/api${path}`,
          { method: "POST", body: form },
          env,
        );
      };
      const uploaded = await upload(`/file-drafts/${object.name}`);
      expect(uploaded.status).toBe(201);
      const { data: draft } = (await uploaded.json()) as {
        data: { id: string; version: number };
      };
      const attach = (env = platform.env) =>
        request(
          `/file-drafts/${draft.id}/attach`,
          "POST",
          { recordId, version: draft.version },
          env,
        );
      const direct = (env = platform.env) => upload(filePath, env);
      const [delayed, first] =
        delayedUpload === "draft" ? [attach, direct] : [direct, attach];
      const beforeCommit = vi.fn(async (statements: D1PreparedStatement[]) => {
        const response = await first();
        expect(response.ok, await response.text()).toBe(true);
        return platform.env.DB.batch(statements);
      });
      const racingDatabase = new Proxy(platform.env.DB, {
        get(target, property, receiver) {
          return property === "batch"
            ? beforeCommit
            : Reflect.get(target, property, receiver);
        },
      });
      try {
        const response = await delayed({ ...platform.env, DB: racingDatabase });
        expect(beforeCommit).toHaveBeenCalledTimes(1);
        const files = (await json(fieldPath)).data;
        expect(files).toHaveLength(1);
        const failure = (await response.json()) as { error: string };
        expect(response.status, failure.error).toBe(422);
        expect(failure.error).toBe(
          limit === "record"
            ? "Máximo 50 adjuntos por registro."
            : "Máximo de archivos alcanzado para este campo.",
        );
        const directKeys = await platform.env.FILES.list({
          prefix: `demo/${recordId}/`,
        });
        expect(directKeys.objects).toHaveLength(
          delayedUpload === "draft" ? 1 : 0,
        );
        if (delayedUpload === "draft") {
          await json(`/file/${files[0].id}`, "DELETE", {
            version: files[0].version,
          });
          expect((await attach()).status).toBe(200);
        }
      } finally {
        for (const file of (await json(fieldPath)).data) {
          await json(`/file/${file.id}`, "DELETE", { version: file.version });
        }
        await request(`/file/${draft.id}`, "DELETE", {
          version: draft.version,
          draftOnly: true,
        });
        await platform.env.DB.prepare(
          "DELETE FROM studio_files WHERE tenant_id=? AND record_id=?",
        )
          .bind("demo", recordId)
          .run();
        await platform.env.DB.prepare(
          "DELETE FROM studio_records WHERE tenant_id=? AND id=?",
        )
          .bind("demo", recordId)
          .run();
      }
    },
  );

  it("isolates R2 attachments by configured field", async () => {
    await uploadFile(
      "contract",
      new File(["contract"], "contract.pdf", { type: "application/pdf" }),
    );
    await uploadFile(
      "photo",
      new File(["photo"], "photo.png", { type: "image/png" }),
    );

    expect(
      (await json(`/files/${object.name}/${record.id}?field=contract`)).data,
    ).toMatchObject([{ name: "contract.pdf", field: "contract" }]);
    expect(
      (await json(`/files/${object.name}/${record.id}?field=photo`)).data,
    ).toMatchObject([{ name: "photo.png", field: "photo" }]);
  });
  it("creates an idempotent automated task and protects task edits with versions", async () => {
    await json("/automations", "POST", {
      name: "Bienvenida",
      object_name: object.name,
      config: {
        field: "stage",
        value: "Won",
        title: "Bienvenida {{name}}",
        dueDays: 0,
        owner: "Equipo",
        ownerField: "owner",
      },
    });
    const after = await updateRecord(
      platform.env.DB,
      "demo",
      object.name,
      record.id,
      { stage: "Won" },
      { version: record._version! },
    );
    await runAutomations(platform.env.DB, "demo", object.name, record, after);
    await runAutomations(platform.env.DB, "demo", object.name, record, after);
    const tasks = await json(`/tasks?record=${record.id}`);
    expect(tasks.data).toHaveLength(1);
    expect(tasks.data[0].title).toBe("Bienvenida Inicial");
    expect(tasks.data[0].owner).toBe("Ana");
    await json(`/tasks/${tasks.data[0].id}`, "PATCH", {
      ...tasks.data[0],
      status: "done",
    });
    expect(
      (
        await request(`/tasks/${tasks.data[0].id}`, "PATCH", {
          ...tasks.data[0],
          status: "pending",
        })
      ).status,
    ).toBe(409);
    expect((await json("/automation-runs")).total).toBe(1);
    record = after;
  });
  it("keeps one automation task when a saved CSV row is confirmed again", async () => {
    const name = "operations_csv_replay";
    const config = makeConfig({
      name: { type: "Textbox", label: "Nombre", config: { unique: true } },
    });
    await platform.env.DB.prepare(
      "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
    )
      .bind("demo", name, "CSV replay", JSON.stringify(config))
      .run();
    await json("/automations", "POST", {
      name: "Follow-up",
      object_name: name,
      config: {
        field: "name",
        value: "Casey",
        title: "Call {{name}}",
        dueDays: 0,
      },
    });
    const input = { csv: "name\nCasey", mapping: { name: "name" } };
    const preview = await json(`/import/${name}/preview`, "POST", input);
    const confirmation = { ...input, importId: preview.importId };
    const commit = await json(`/import/${name}/commit`, "POST", confirmation);
    expect(commit.summary.created).toBe(1);
    const replay = await json(`/import/${name}/commit`, "POST", confirmation);
    expect(replay).toEqual(commit);
    const tasks = await json(`/tasks?record=${commit.data[0].id}`);
    expect(tasks.data).toHaveLength(1);
    expect(tasks.data[0].title).toBe("Call Casey");
  });
  it("reports metadata-configured pipeline values and complete exports beyond 200 rows", async () => {
    await platform.env.DB.batch(
      Array.from({ length: 205 }, (_, i) =>
        platform.env.DB.prepare(
          "INSERT INTO studio_records(id,tenant_id,object_name,data) VALUES (?,?,?,?)",
        ).bind(
          `export-${i.toString().padStart(3, "0")}`,
          "demo",
          object.name,
          JSON.stringify({
            name: `Export ${i}`,
            amount: 10,
            stage: "Lost",
            owner: "Responsable",
          }),
        ),
      ),
    );
    const reports = (await json("/reports")).data[0];
    expect(reports.total).toBe(207);
    expect(reports.won).toBe(1);
    expect(reports.lost).toBe(205);
    expect(reports.amount).toBe(2270);
    const exported = await (await request(`/export/${object.name}`)).text();
    expect(parseCsv(exported).rows).toHaveLength(207);
  });
  it("exports visible columns with the active search filter", async () => {
    const query = new URLSearchParams({
      columns: JSON.stringify(["name", "stage"]),
      headers: JSON.stringify(["Nombre", "Etapa"]),
      filters: JSON.stringify({
        logic: "and",
        conditions: [{ field: "name", op: "eq", value: "Export 42" }],
      }),
      sort: "name",
      order: "ASC",
      q: "",
    });
    const exported = await (
      await request(`/export/${object.name}?${query}`)
    ).text();
    const parsed = parseCsv(exported);
    expect(parsed.headers).toEqual(["Nombre", "Etapa"]);
    expect(parsed.rows).toEqual([["Export 42", "Lost"]]);
  });
});

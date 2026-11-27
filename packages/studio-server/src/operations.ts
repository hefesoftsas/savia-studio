import { dialectFor } from "@savia/db/dialect";
import { databaseConflict } from "@savia/db/errors";
import {
  cleanDeletedAttachmentObjects,
  purgeExpiredTemporaryAttachments,
} from "./attachment-deletions";
import {
  authorizeAttachmentAssociation,
  requireAttachmentCreator,
  requireAttachmentCreateGrant,
  requireAttachmentRecord,
  type AttachmentIntent,
} from "./attachment-access";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "./context";
import {
  getObject,
  assertLocalCollection,
  getRecord,
  createRecord,
  findCreatedRecordReplay,
  parseRecord,
  audit,
  guard,
  transaction,
} from "./services";
import {
  type StudioObject,
  type StudioRecord,
  identifier,
  getPipeline,
  R2_ATTACHMENT_TYPE,
  r2AttachmentPolicy,
  validateRecord,
} from "@savia/studio-shared/metadata";
import {
  CSV_IMPORT_MAX_LENGTH,
  parseCsv,
  mapCsvRow,
  csvHeaders,
  csvLine,
} from "@savia/studio-shared/csv";
import { buildWhere } from "./query";
import {
  policyFor,
  accessDenied,
  accessRecord,
  requireRecordAccess,
} from "./access-authorization";
import { decideWrite } from "@savia/studio-shared/access-evaluator";
import {
  formatRecordCsvValue,
  parseCsvExportColumns,
  recordsCsvFilename,
} from "@savia/studio-shared/records-csv-export";

const fail = (
  message: string,
  status: 400 | 404 | 409 | 413 | 422 | 503 = 400,
): never => {
  throw new HTTPException(status, { message });
};

async function csvRelationAvailable(
  db: D1Database,
  tenant: string,
  collection: string,
  id: string,
): Promise<boolean> {
  if (!policyFor(db)) {
    return Boolean(
      await db
        .prepare(
          "SELECT id FROM studio_records WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL AND id=?",
        )
        .bind(tenant, collection, id)
        .first(),
    );
  }
  try {
    await getRecord(db, tenant, collection, id);
    return true;
  } catch (error) {
    if (
      error instanceof HTTPException &&
      (error.status === 403 || error.status === 404)
    )
      return false;
    throw error;
  }
}

const pageSize = 20;
const pageNumber = (value?: string) =>
  Math.max(1, Math.floor(Number(value) || 1));
const versionSchema = z.object({ version: z.number().int().positive() });
const now = () => new Date().toISOString();
const parseObject = (r: any): StudioObject => ({
  ...r,
  config: JSON.parse(r.config),
});
const automationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  object_name: identifier,
  config: z.object({
    field: identifier,
    value: z.union([z.string().max(500), z.number(), z.boolean()]),
    title: z.string().trim().min(1).max(200),
    dueDays: z.number().int().min(0).max(365),
    owner: z.string().max(100).default(""),
    ownerField: z.string().max(48).default(""),
  }),
  enabled: z.boolean().default(true),
});
const temporaryAttachmentLifetimeMs = 24 * 60 * 60 * 1000;
const recordAttachmentLimit = 50;
const temporaryExpiresAt = () =>
  new Date(Date.now() + temporaryAttachmentLifetimeMs).toISOString();
const temporaryAttachmentKey = (tenant: string, id: string) =>
  `${tenant}/temporary/${id}`;

type StoredAttachment = AttachmentIntent & {
  id: string;
  object_name: string;
  field_name: string;
  name: string;
  mime: string;
  size: number;
  storage_key: string;
  version: number;
};
type DraftAttachment = StoredAttachment & { target_record_id: string | null };
type SavedAttachmentAssociation = StoredAttachment & {
  record_id: string;
  original_storage_key: string | null;
};
const attachmentTarget = z
  .object({
    recordId: z.string().trim().min(1).max(200).optional(),
    createRequestKey: z.string().trim().min(1).max(200).optional(),
  })
  .refine(({ recordId, createRequestKey }) => !(recordId && createRequestKey));

function attachmentLimits(
  db: D1Database,
  tenant: string,
  object: string,
  recordId: string,
  field: string,
  maxFiles: number,
) {
  const counts = `SELECT count(*) AS total,
      count(CASE WHEN object_name=? AND field_name=? THEN 1 END) AS field_total
    FROM studio_files WHERE tenant_id=? AND record_id=?`;
  const args = [object, field, tenant, recordId];
  return {
    async check() {
      const current = await db
        .prepare(counts)
        .bind(...args)
        .first<{ total: number; field_total: number }>();
      if ((current?.total ?? 0) >= recordAttachmentLimit)
        fail("Máximo 50 adjuntos por registro.", 422);
      if ((current?.field_total ?? 0) >= maxFiles)
        fail("Máximo de archivos alcanzado para este campo.", 422);
    },
    writeGuard: () =>
      guard(
        db,
        `SELECT total<? AND field_total<? FROM (${counts}) AS attachment_counts`,
        [recordAttachmentLimit, maxFiles, ...args],
      ),
  };
}

function isAttachmentWriteConflict(error: unknown) {
  return (
    (error instanceof HTTPException && error.status === 409) ||
    databaseConflict(error)
  );
}

async function commitAttachment(
  db: D1Database,
  statements: D1PreparedStatement[],
) {
  // PostgreSQL rolls back these conflicts. Retry the batch without uploading the file again.
  const maxAttempts = 3;
  for (let attempt = 1; ; attempt++) {
    try {
      await transaction(db, statements);
      return;
    } catch (error) {
      if (attempt === maxAttempts || !databaseConflict(error)) throw error;
    }
  }
}

async function uploadAttachment(
  db: D1Database,
  files: R2Bucket,
  upload: {
    tenant: string;
    fileId: string;
    storageKey: string;
    file: File;
    mime: string;
  },
  statements: D1PreparedStatement[],
) {
  const { tenant, fileId, storageKey, file, mime } = upload;
  const bytes = await file.arrayBuffer();
  const cleanupAt = Date.now() + temporaryAttachmentLifetimeMs;
  await db
    .prepare(
      "INSERT INTO studio_file_deletions (storage_key,tenant_id,file_id,next_attempt_at) VALUES (?,?,?,?)",
    )
    .bind(storageKey, tenant, fileId, cleanupAt)
    .run();
  const gate = guard(
    db,
    "SELECT next_attempt_at=? FROM studio_file_deletions WHERE storage_key=?",
    [cleanupAt, storageKey],
  );
  try {
    await files.put(storageKey, bytes, { httpMetadata: { contentType: mime } });
    await commitAttachment(db, [
      gate.start,
      ...statements,
      db
        .prepare("DELETE FROM studio_file_deletions WHERE storage_key=?")
        .bind(storageKey),
      gate.end,
    ]);
  } catch (error) {
    try {
      const released = await db
        .prepare(
          "UPDATE studio_file_deletions SET next_attempt_at=0 WHERE storage_key=? AND next_attempt_at=?",
        )
        .bind(storageKey, cleanupAt)
        .run();
      if (!released.meta.changes) {
        // Losing the batch response can leave a committed draft, file, or revision.
        const identity = [tenant, fileId, storageKey];
        const saved = await db
          .prepare(
            `SELECT 1 FROM studio_file_drafts WHERE tenant_id=? AND id=? AND storage_key=?
             UNION ALL SELECT 1 FROM studio_files WHERE tenant_id=? AND id=? AND storage_key=?
             UNION ALL SELECT 1 FROM studio_file_revisions WHERE tenant_id=? AND file_id=? AND storage_key=?
             LIMIT 1`,
          )
          .bind(...identity, ...identity, ...identity)
          .first();
        if (saved) return;
        // A late upload needs another cleanup, even if a previous claim is still active.
        await db
          .prepare(
            `INSERT INTO studio_file_deletions (storage_key,tenant_id,file_id) VALUES (?,?,?)
             ON CONFLICT(storage_key) DO UPDATE SET next_attempt_at=studio_file_deletions.next_attempt_at+1`,
          )
          .bind(storageKey, tenant, fileId)
          .run();
      }
      await cleanDeletedAttachmentObjects(db, files, { tenant, fileId });
    } catch {
      console.warn("STUDIO_ATTACHMENT_UPLOAD_RECOVERY_DEFERRED");
    }
    throw error;
  }
}

export type AutomationRuleSnapshot = {
  id: string;
  version: number;
  name: string;
  config: string;
};

/** Each rule/version/record version creates at most one task, even when delivery is repeated. */
export async function runAutomations(
  db: D1Database,
  tenant: string,
  objectName: string,
  before: StudioRecord | null,
  after: StudioRecord,
  scope?: { ruleId?: string; rules?: AutomationRuleSnapshot[] },
) {
  if (policyFor(db)) return { delivered: false };
  await assertLocalCollection(db, tenant, objectName);
  const results =
    scope?.rules ??
    (
      await db
        .prepare(
          "SELECT * FROM studio_automations WHERE tenant_id=? AND object_name=? AND enabled=1",
        )
        .bind(tenant, objectName)
        .all<AutomationRuleSnapshot>()
    ).results;
  let delivered = true;
  for (const rule of results) {
    if (scope?.ruleId && rule.id !== scope.ruleId) continue;
    const config = JSON.parse(rule.config);
    if (
      JSON.stringify(before?.[config.field]) ===
        JSON.stringify(after[config.field]) ||
      String(after[config.field] ?? "") !== String(config.value)
    )
      continue;
    const eventKey = `${after.id}:${after._version}:${rule.version}`;
    const taskId = `auto:${rule.id}:${eventKey}`;
    if (
      await db
        .prepare(
          "SELECT id FROM studio_automation_runs WHERE tenant_id=? AND automation_id=? AND event_key=? AND status='success'",
        )
        .bind(tenant, rule.id, eventKey)
        .first()
    )
      continue;
    try {
      const due = new Date();
      due.setUTCDate(due.getUTCDate() + config.dueDays);
      const title = config.title
        .replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (_: string, field: string) =>
          String(after[field] ?? ""),
        )
        .slice(0, 200);
      const owner = config.ownerField
        ? String(after[config.ownerField] ?? config.owner)
        : config.owner;
      await db.batch([
        db
          .prepare(
            "INSERT INTO studio_tasks (id,tenant_id,object_name,record_id,title,owner,due_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          )
          .bind(
            taskId,
            tenant,
            objectName,
            after.id,
            title,
            owner,
            due.toISOString().slice(0, 10),
          ),
        db
          .prepare(
            "INSERT INTO studio_automation_runs (id,tenant_id,automation_id,object_name,record_id,event_key,status,detail,task_id) VALUES (?,?,?,?,?,?,'success',?,?) ON CONFLICT(tenant_id,automation_id,event_key) DO UPDATE SET status='success',detail=excluded.detail,task_id=excluded.task_id",
          )
          .bind(
            crypto.randomUUID(),
            tenant,
            rule.id,
            objectName,
            after.id,
            eventKey,
            JSON.stringify({
              name: rule.name,
              field: config.field,
              value: after[config.field],
            }),
            taskId,
          ),
      ]);
    } catch (error) {
      delivered = false;
      await db
        .prepare(
          "INSERT INTO studio_automation_runs (id,tenant_id,automation_id,object_name,record_id,event_key,status,detail) VALUES (?,?,?,?,?,?,'failed',?) ON CONFLICT(tenant_id,automation_id,event_key) DO UPDATE SET status='failed',detail=excluded.detail",
        )
        .bind(
          crypto.randomUUID(),
          tenant,
          rule.id,
          objectName,
          after.id,
          eventKey,
          JSON.stringify({
            name: rule.name,
            error: (error as Error).message,
            after,
            before,
          }),
        )
        .run();
    }
  }
  return { delivered };
}

export function registerOperations(app: Hono<Env>) {
  app.get("/api/record-detail/:object/:id", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant"),
      objectName = c.req.param("object"),
      id = c.req.param("id");
    const record = await getRecord(db, tenant, objectName, id);
    const { results: rawObjects } = await db
      .prepare("SELECT * FROM studio_objects WHERE tenant_id=? ORDER BY name")
      .bind(tenant)
      .all<any>();
    const objects = rawObjects.map(parseObject),
      page = pageNumber(c.req.query("page"));
    const relations: {
      object: string;
      label: string;
      field: string;
      fieldLabel: string;
      direction: string;
      total: number;
      records: StudioRecord[];
    }[] = [];
    for (const object of objects)
      for (const [fieldName, field] of Object.entries(object.config.fields)) {
        if (field.config?.relation === objectName) {
          const path = `$.${identifier.parse(fieldName)}`;
          const comparison = dialectFor(db).jsonCompare("data", path, "eq", id);
          const where = `tenant_id=? AND object_name=? AND deleted_at IS NULL AND (${comparison.sql} OR EXISTS(SELECT 1 FROM ${dialectFor(db).jsonEach("data", path, "related")} WHERE value=?))`;
          const args = [tenant, object.name, ...comparison.parameters, id];
          const count = await db
            .prepare(
              `SELECT COUNT(*) AS total FROM studio_records WHERE ${where}`,
            )
            .bind(...args)
            .first<{ total: number }>();
          const { results } = await db
            .prepare(
              `SELECT * FROM studio_records WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
            )
            .bind(...args, pageSize, (page - 1) * pageSize)
            .all();
          relations.push({
            object: object.name,
            label: object.label,
            field: fieldName,
            fieldLabel: field.label,
            direction: "incoming",
            total: count?.total ?? 0,
            records: results.map(parseRecord),
          });
        }
        if (
          object.name === objectName &&
          typeof field.config?.relation === "string"
        ) {
          const value = record[fieldName];
          const ids = (
            Array.isArray(value) ? value : value ? [value] : []
          ).filter((v): v is string => typeof v === "string");
          const related = objects.find(
            (o) => o.name === field.config?.relation,
          );
          const { results } = await db
            .prepare(
              `SELECT * FROM studio_records WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL AND id IN (SELECT value FROM (SELECT ? AS ids) input, ${dialectFor(db).jsonEach("input.ids", "$", "related")}) ORDER BY id LIMIT ? OFFSET ?`,
            )
            .bind(
              tenant,
              field.config.relation,
              JSON.stringify(ids),
              pageSize,
              (page - 1) * pageSize,
            )
            .all();
          relations.push({
            object: String(field.config.relation),
            label: related?.label ?? String(field.config.relation),
            field: fieldName,
            fieldLabel: field.label,
            direction: "outgoing",
            total: ids.length,
            records: results.map(parseRecord),
          });
        }
      }
    return c.json({ data: { record, relations, page, perPage: pageSize } });
  });
  app.get("/api/record-activity/:object/:id", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant"),
      object = c.req.param("object"),
      id = c.req.param("id");
    await getRecord(db, tenant, object, id);
    const page = pageNumber(c.req.query("page"));
    const union =
      "SELECT id,body,kind,version,created_at FROM studio_notes WHERE tenant_id=? AND object_name=? AND record_id=? UNION ALL SELECT id,detail AS body,action AS kind,0 AS version,created_at FROM studio_audit WHERE tenant_id=? AND object_name=? AND record_id=?";
    const args = [tenant, object, id, tenant, object, id];
    const { results } = await db
      .prepare(
        `SELECT * FROM (${union}) ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all();
    const total = await db
      .prepare(`SELECT count(*) AS total FROM (${union})`)
      .bind(...args)
      .first<{ total: number }>();
    return c.json({ data: results, total: total?.total ?? 0, page });
  });
  app.post("/api/record-notes/:object/:id", async (c) => {
    const input = z
      .object({
        body: z.string().trim().min(1).max(10000),
        kind: z.enum(["note", "call", "meeting", "email"]).default("note"),
      })
      .parse(await c.req.json());
    const db = c.env.DB,
      tenant = c.get("tenant"),
      object = c.req.param("object"),
      recordId = c.req.param("id");
    await getRecord(db, tenant, object, recordId);
    const id = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO studio_notes (id,tenant_id,object_name,record_id,body,kind) VALUES (?,?,?,?,?,?)",
      )
      .bind(id, tenant, object, recordId, input.body, input.kind)
      .run();
    return c.json({ data: { id, ...input, version: 1 } }, 201);
  });
  app.delete("/api/record-notes/:id", async (c) => {
    const { version } = versionSchema.parse(await c.req.json());
    const result = await c.env.DB.prepare(
      "DELETE FROM studio_notes WHERE tenant_id=? AND id=? AND version=?",
    )
      .bind(c.get("tenant"), c.req.param("id"), version)
      .run();
    if (!result.meta.changes)
      return fail("La nota cambió o ya no existe. Actualiza la ficha.", 409);
    return c.json({ ok: true });
  });
  app.get("/api/files/:object/:recordId", async (c) => {
    const field = c.req.query("field");
    if (field !== undefined && !identifier.safeParse(field).success)
      return fail("Campo de archivo inválido.", 422);
    await getRecord(
      c.env.DB,
      c.get("tenant"),
      c.req.param("object"),
      c.req.param("recordId"),
    );
    const { results } = await c.env.DB.prepare(
      `SELECT id,name,mime,size,field_name AS field,version,created_at
         FROM studio_files
         WHERE tenant_id=? AND object_name=? AND record_id=?${field ? " AND field_name=?" : ""}
         ORDER BY created_at DESC`,
    )
      .bind(
        c.get("tenant"),
        c.req.param("object"),
        c.req.param("recordId"),
        ...(field ? [field] : []),
      )
      .all();
    return c.json({ data: results });
  });
  app.post("/api/file-drafts/:object", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant"),
      object = c.req.param("object");
    const definition = await getObject(db, tenant, object);
    if (!c.env.FILES)
      return fail("El almacenamiento de archivos no está configurado.", 503);
    await purgeExpiredTemporaryAttachments(db, c.env.FILES, tenant);
    const form = await c.req.formData();
    const file = form.get("file");
    const fieldValue = form.get("field");
    const field = typeof fieldValue === "string" ? fieldValue : "";
    if (!file || typeof file === "string")
      return fail("Selecciona un archivo.", 422);
    if (!field || !identifier.safeParse(field).success)
      return fail("Campo de archivo inválido.", 422);
    const { recordId, createRequestKey } = attachmentTarget.parse({
      recordId: form.get("recordId") ?? undefined,
      createRequestKey: form.get("createRequestKey") ?? undefined,
    });
    const access = policyFor(db);
    const principalId = access?.principalId ?? (c.get("principalId") || null);
    if (access) {
      if (
        definition.config.studio?.business ||
        definition.config.studio?.collection
      )
        accessDenied();
      await assertLocalCollection(db, tenant, object);
      const target = { object_name: object, field_name: field };
      if (recordId)
        await requireAttachmentRecord(db, tenant, target, recordId, "update");
      else {
        if (!createRequestKey) accessDenied();
        requireAttachmentCreateGrant(access, target);
      }
    }
    const fieldDefinition = definition.config.fields[field];
    if (fieldDefinition?.type !== R2_ATTACHMENT_TYPE)
      return fail("El campo no admite archivos R2.", 422);
    const policy = r2AttachmentPolicy(
      fieldDefinition.config as Record<string, unknown>,
    );
    const mime = file.type || "application/octet-stream";
    if (!file.size || file.size > policy.maxSize)
      return fail(
        `El archivo debe pesar entre 1 byte y ${Math.ceil(policy.maxSize / (1024 * 1024))} MB.`,
        413,
      );
    const acceptsMime = policy.accept.some(
      (accepted) =>
        accepted === mime ||
        (accepted.endsWith("/*") && mime.startsWith(accepted.slice(0, -1))),
    );
    if (policy.accept.length && !acceptsMime)
      return fail("El tipo de archivo no está permitido para este campo.", 422);
    const name =
      file.name.replace(/[\x00-\x1f\x7f/\\\\]/g, "_").slice(0, 200) ||
      "adjunto";
    const id = crypto.randomUUID();
    const key = temporaryAttachmentKey(tenant, id);
    const expiresAt = temporaryExpiresAt();
    const createGuard =
      createRequestKey &&
      guard(
        db,
        "SELECT NOT EXISTS (SELECT 1 FROM studio_requests WHERE tenant_id=? AND request_key=?)",
        [tenant, createRequestKey],
      );
    await uploadAttachment(
      db,
      c.env.FILES,
      { tenant, fileId: id, storageKey: key, file, mime },
      [
        ...(createGuard ? [createGuard.start] : []),
        db
          .prepare(
            "INSERT INTO studio_file_drafts (id,tenant_id,object_name,field_name,name,mime,size,storage_key,expires_at,created_by,target_record_id,create_request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            id,
            tenant,
            object,
            field,
            name,
            mime,
            file.size,
            key,
            expiresAt,
            principalId,
            recordId ?? null,
            createRequestKey ?? null,
          ),
        audit(db, tenant, "file.temporary_uploaded", object, null, {
          field,
          name,
          size: file.size,
          expiresAt,
        }),
        ...(createGuard ? [createGuard.end] : []),
      ],
    );
    return c.json(
      {
        data: {
          id,
          name,
          mime,
          size: file.size,
          field,
          version: 1,
          expiresAt,
        },
      },
      201,
    );
  });
  app.post("/api/files/:object/:recordId", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant"),
      object = c.req.param("object"),
      recordId = c.req.param("recordId");
    const definition = await getObject(db, tenant, object);
    await getRecord(db, tenant, object, recordId);
    if (!c.env.FILES)
      return fail("El almacenamiento de archivos no está configurado.", 503);
    const form = await c.req.formData();
    const file = form.get("file");
    const fieldValue = form.get("field");
    const field = typeof fieldValue === "string" ? fieldValue : "";
    if (!file || typeof file === "string")
      return fail("Selecciona un archivo.", 422);
    if (field && !identifier.safeParse(field).success)
      return fail("Campo de archivo inválido.", 422);
    const fieldDefinition = field ? definition.config.fields[field] : undefined;
    if (field && fieldDefinition?.type !== R2_ATTACHMENT_TYPE)
      return fail("El campo no admite archivos R2.", 422);
    const policy = fieldDefinition
      ? r2AttachmentPolicy(fieldDefinition.config as Record<string, unknown>)
      : {
          maxFiles: recordAttachmentLimit,
          maxSize: 5 * 1024 * 1024,
          accept: [],
        };
    const mime = file.type || "application/octet-stream";
    if (!file.size || file.size > policy.maxSize)
      return fail(
        `El archivo debe pesar entre 1 byte y ${Math.ceil(policy.maxSize / (1024 * 1024))} MB.`,
        413,
      );
    const acceptsMime = policy.accept.some(
      (accepted) =>
        accepted === mime ||
        (accepted.endsWith("/*") && mime.startsWith(accepted.slice(0, -1))),
    );
    if (policy.accept.length && !acceptsMime)
      return fail("El tipo de archivo no está permitido para este campo.", 422);
    const limits = attachmentLimits(
      db,
      tenant,
      object,
      recordId,
      field,
      policy.maxFiles,
    );
    await limits.check();
    const name =
      file.name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 200) || "adjunto";
    const id = crypto.randomUUID(),
      key = `${tenant}/${recordId}/${id}`;
    const limitGuard = limits.writeGuard();
    try {
      await uploadAttachment(
        db,
        c.env.FILES,
        {
          tenant,
          fileId: id,
          storageKey: key,
          file,
          mime,
        },
        [
          limitGuard.start,
          db
            .prepare(
              "INSERT INTO studio_files (id,tenant_id,object_name,record_id,field_name,name,mime,size,storage_key) VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              id,
              tenant,
              object,
              recordId,
              field,
              name,
              mime,
              file.size,
              key,
            ),
          audit(db, tenant, "file.uploaded", object, recordId, {
            field,
            name,
            size: file.size,
          }),
          limitGuard.end,
        ],
      );
    } catch (error) {
      if (isAttachmentWriteConflict(error)) await limits.check();
      throw error;
    }
    return c.json(
      { data: { id, name, mime, size: file.size, field, version: 1 } },
      201,
    );
  });
  app.post("/api/file-drafts/:id/attach", async (c) => {
    const input = z
      .object({
        recordId: z.string().trim().min(1).max(200),
        version: z.number().int().positive(),
      })
      .parse(await c.req.json());
    const db = c.env.DB;
    const tenant = c.get("tenant");
    const principalId = c.get("principalId");
    const id = c.req.param("id");
    const nextVersion = input.version + 1;
    const originalKey = temporaryAttachmentKey(tenant, id);
    if (!c.env.FILES)
      return fail("El almacenamiento de archivos no está configurado.", 503);
    await purgeExpiredTemporaryAttachments(db, c.env.FILES, tenant);
    const findSavedAttachment = () =>
      db
        .prepare(
          `SELECT f.*, (SELECT r.storage_key FROM studio_file_revisions r
           WHERE r.tenant_id=f.tenant_id AND r.file_id=f.id AND r.version=?) AS original_storage_key
           FROM studio_files f WHERE f.tenant_id=? AND f.id=?`,
        )
        .bind(nextVersion, tenant, id)
        .first<SavedAttachmentAssociation>();
    const matchesAssociation = (saved: SavedAttachmentAssociation) =>
      saved.record_id === input.recordId &&
      ((saved.version === nextVersion && saved.storage_key === originalKey) ||
        (saved.version > nextVersion &&
          saved.original_storage_key === originalKey));
    const confirmation = (file: StoredAttachment, version = file.version) =>
      c.json({
        data: {
          id: file.id,
          name: file.name,
          mime: file.mime,
          size: file.size,
          field: file.field_name,
          recordId: input.recordId,
          version,
        },
      });
    const expiryClock = dialectFor(db).utcNow();
    const row = await db
      .prepare(
        `SELECT * FROM studio_file_drafts WHERE tenant_id=? AND id=? AND expires_at>${expiryClock}`,
      )
      .bind(tenant, id)
      .first<DraftAttachment>();
    if (!row) {
      const saved = await findSavedAttachment();
      if (!saved)
        return c.json(
          {
            error: "El adjunto temporal no existe o expiró.",
            code: "ATTACHMENT_DRAFT_UNAVAILABLE",
          },
          404,
        );
      if (!matchesAssociation(saved))
        return fail("El adjunto temporal no existe o expiró.", 404);
      await authorizeAttachmentAssociation(
        db,
        tenant,
        saved,
        input.recordId,
        principalId,
      );
      return confirmation(saved);
    }
    requireAttachmentCreator(db, row.created_by, principalId);
    if (row.target_record_id && row.target_record_id !== input.recordId)
      accessDenied();
    if (row.version !== input.version)
      return fail("El adjunto cambió. Actualiza la ficha.", 409);
    const definition = await getObject(db, tenant, row.object_name);
    if (policyFor(db)) {
      if (
        definition.config.studio?.business ||
        definition.config.studio?.collection
      )
        accessDenied();
      await assertLocalCollection(db, tenant, row.object_name);
    }
    const fieldDefinition = definition.config.fields[row.field_name];
    if (fieldDefinition?.type !== R2_ATTACHMENT_TYPE)
      return fail("El campo ya no admite archivos R2.", 422);
    const record = await authorizeAttachmentAssociation(
      db,
      tenant,
      row,
      input.recordId,
      principalId,
    );
    const recordGuard =
      policyFor(db) &&
      guard(
        db,
        "SELECT version=? AND deleted_at IS NULL FROM studio_records WHERE tenant_id=? AND object_name=? AND id=?",
        [record._version, tenant, row.object_name, input.recordId],
      );
    const policy = r2AttachmentPolicy(
      fieldDefinition.config as Record<string, unknown>,
    );
    const limits = attachmentLimits(
      db,
      tenant,
      row.object_name,
      input.recordId,
      row.field_name,
      policy.maxFiles,
    );
    try {
      await limits.check();
      const limitGuard = limits.writeGuard();
      // Serialize promotion with cleanup before checking the expiry in the batch.
      const lockDraft = db
        .prepare(
          "UPDATE studio_file_drafts SET expires_at=expires_at WHERE tenant_id=? AND id=?",
        )
        .bind(tenant, id);
      const draftGuard = guard(
        db,
        `SELECT version=? AND expires_at>${expiryClock} FROM studio_file_drafts WHERE tenant_id=? AND id=?`,
        [input.version, tenant, id],
      );
      await commitAttachment(db, [
        lockDraft,
        draftGuard.start,
        ...(recordGuard ? [recordGuard.start] : []),
        limitGuard.start,
        db
          .prepare(
            "INSERT INTO studio_files (id,tenant_id,object_name,record_id,field_name,name,mime,size,storage_key,version,created_by,create_request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            row.id,
            tenant,
            row.object_name,
            input.recordId,
            row.field_name,
            row.name,
            row.mime,
            row.size,
            row.storage_key,
            nextVersion,
            row.created_by,
            row.create_request_key,
          ),
        db
          .prepare(
            "DELETE FROM studio_file_drafts WHERE tenant_id=? AND id=? AND version=?",
          )
          .bind(tenant, row.id, row.version),
        audit(db, tenant, "file.attached", row.object_name, input.recordId, {
          field: row.field_name,
          name: row.name,
          temporaryId: row.id,
        }),
        limitGuard.end,
        ...(recordGuard ? [recordGuard.end] : []),
        draftGuard.end,
      ]);
    } catch (error) {
      // A concurrent attempt can commit before this attempt checks capacity or writes.
      const saved = await findSavedAttachment();
      if (saved && matchesAssociation(saved)) {
        await authorizeAttachmentAssociation(
          db,
          tenant,
          saved,
          input.recordId,
          principalId,
        );
        return confirmation(saved);
      }
      if (isAttachmentWriteConflict(error)) await limits.check();
      throw error;
    }
    return confirmation(row, nextVersion);
  });
  app.get("/api/file/:id/download", async (c) => {
    const db = c.env.DB;
    const tenant = c.get("tenant");
    const row = await db
      .prepare(
        `SELECT id,name,storage_key,object_name,field_name,record_id,NULL AS created_by,NULL AS expires_at,NULL AS target_record_id FROM studio_files WHERE tenant_id=? AND id=?
       UNION ALL SELECT id,name,storage_key,object_name,field_name,NULL,created_by,expires_at,target_record_id FROM studio_file_drafts WHERE tenant_id=? AND id=? LIMIT 1`,
      )
      .bind(
        c.get("tenant"),
        c.req.param("id"),
        c.get("tenant"),
        c.req.param("id"),
      )
      .first<{
        id: string;
        name: string;
        storage_key: string;
        object_name: string;
        field_name: string;
        record_id: string | null;
        created_by: string | null;
        expires_at: string | null;
        target_record_id: string | null;
      }>();
    if (!row) return fail("El adjunto no existe.", 404);
    const policy = policyFor(db);
    if (row.expires_at) {
      requireAttachmentCreator(db, row.created_by, c.get("principalId"));
      if (policy) {
        if (row.target_record_id)
          await requireAttachmentRecord(
            db,
            tenant,
            row,
            row.target_record_id,
            "update",
          );
        else requireAttachmentCreateGrant(policy, row);
      }
    }
    if (row.record_id && policy)
      await requireAttachmentRecord(db, tenant, row, row.record_id, "read");
    else await getObject(db, tenant, row.object_name);
    if (row.expires_at && row.expires_at <= now()) {
      await purgeExpiredTemporaryAttachments(
        c.env.DB,
        c.env.FILES,
        c.get("tenant"),
      );
      return fail("El adjunto temporal expiró.", 404);
    }
    const file = await c.env.FILES.get(row.storage_key);
    if (!file)
      return fail(
        "No se encontró el contenido del archivo. Puedes eliminar la referencia y cargarlo nuevamente.",
        404,
      );
    return new Response(file.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
        "Content-Length": String(file.size),
      },
    });
  });
  app.delete("/api/file/:id", async (c) => {
    const { version, draftOnly } = versionSchema
      .extend({ draftOnly: z.boolean().optional() })
      .parse(await c.req.json());
    const db = c.env.DB;
    const tenant = c.get("tenant");
    const row = draftOnly
      ? null
      : await db
          .prepare("SELECT * FROM studio_files WHERE tenant_id=? AND id=?")
          .bind(tenant, c.req.param("id"))
          .first<any>();
    const draft = row
      ? null
      : await db
          .prepare(
            "SELECT * FROM studio_file_drafts WHERE tenant_id=? AND id=?",
          )
          .bind(tenant, c.req.param("id"))
          .first<any>();
    const file = row ?? draft;
    if (!file) return c.json({ ok: true });
    if (row && policyFor(db)) {
      const record = await requireAttachmentRecord(
        db,
        tenant,
        row,
        row.record_id,
        "update",
      );
      requireRecordAccess(db, row.object_name, "read", record);
    }
    if (draft)
      requireAttachmentCreator(db, draft.created_by, c.get("principalId"));
    if (file.version !== version)
      return fail("El adjunto cambió. Actualiza la ficha.", 409);
    const gate = guard(
      db,
      row
        ? "SELECT version=? FROM studio_files WHERE tenant_id=? AND id=?"
        : "SELECT version=? FROM studio_file_drafts WHERE tenant_id=? AND id=?",
      [version, tenant, file.id],
    );
    await transaction(db, [
      gate.start,
      db
        .prepare(
          "INSERT INTO studio_file_deletions (storage_key,tenant_id,file_id) VALUES (?,?,?) ON CONFLICT(storage_key) DO NOTHING",
        )
        .bind(file.storage_key, tenant, file.id),
      ...(row
        ? [
            db
              .prepare(
                `INSERT INTO studio_file_deletions (storage_key,tenant_id,file_id)
             SELECT storage_key,tenant_id,file_id FROM studio_file_revisions WHERE tenant_id=? AND file_id=?
             ON CONFLICT(storage_key) DO NOTHING`,
              )
              .bind(tenant, file.id),
          ]
        : []),
      db
        .prepare(
          row
            ? "DELETE FROM studio_files WHERE tenant_id=? AND id=? AND version=?"
            : "DELETE FROM studio_file_drafts WHERE tenant_id=? AND id=? AND version=?",
        )
        .bind(tenant, file.id, version),
      audit(
        db,
        tenant,
        row ? "file.deleted" : "file.temporary_deleted",
        file.object_name,
        row ? row.record_id : null,
        {
          name: file.name,
        },
      ),
      gate.end,
    ]);
    try {
      await cleanDeletedAttachmentObjects(db, c.env.FILES, {
        tenant,
        fileId: file.id,
      });
    } catch {
      console.error("STUDIO_ATTACHMENT_CLEANUP_FAILED");
    }
    return c.json({ ok: true });
  });

  const importSchema = z.object({
    csv: z.string().max(CSV_IMPORT_MAX_LENGTH),
    mapping: z.record(z.string(), z.string()),
    duplicateField: z.string().default(""),
    duplicatePolicy: z.enum(["skip", "error"]).default("skip"),
    importId: z.string().uuid().optional(),
  });
  async function importRows(c: any, commit: boolean) {
    const input = importSchema.parse(await c.req.json()),
      db = c.env.DB as D1Database,
      tenant = c.get("tenant"),
      objectName = c.req.param("object");
    const object = await getObject(db, tenant, objectName);
    let parsed;
    try {
      parsed = parseCsv(input.csv);
    } catch (e) {
      return fail((e as Error).message, 422);
    }
    const mapped = Object.values(input.mapping).filter(Boolean);
    if (
      !mapped.length ||
      new Set(mapped).size !== mapped.length ||
      mapped.some((key) => !object.config.fields[key])
    )
      return fail(
        "Asigna columnas a campos válidos sin repetir destinos.",
        422,
      );
    if (input.duplicateField && !object.config.fields[input.duplicateField])
      return fail("Campo para duplicados inválido.", 422);
    if (commit && !input.importId)
      return fail(
        "La importación necesita un identificador. Previsualiza nuevamente.",
        422,
      );
    const duplicateFields = [
      ...new Set([
        ...(input.duplicateField ? [input.duplicateField] : []),
        ...Object.entries(object.config.fields)
          .filter(([, f]) => f.config?.unique)
          .map(([name]) => name),
      ]),
    ];
    const policy = policyFor(db);
    const importPolicy = policy && {
      ...policy,
      grants: policy.grants
        .filter((grant) => grant.action === "import")
        .map((grant) => ({ ...grant, action: "create" as const })),
    };
    const relations = Object.entries(object.config.fields).flatMap(
      ([name, { config, label }]) =>
        config?.relation
          ? [{ name, label, collection: String(config.relation) }]
          : [],
    );
    // Authorize the entire batch before any row can be written.
    const rows = parsed.rows.map((values) => {
      const row = mapCsvRow(object, parsed.headers, values, input.mapping);
      if (
        importPolicy &&
        !decideWrite(
          importPolicy,
          `collection:${objectName}`,
          "create",
          null,
          {
            id: "import-preview",
            createdBy: importPolicy.principalId,
            values: row.data,
          },
          Object.keys(row.data),
        ).allowed
      )
        accessDenied();
      return row;
    });

    const seen = new Set<string>();
    const results: {
      row: number;
      status: string;
      data?: unknown;
      error?: string;
      id?: string;
    }[] = [];
    for (const [index, { data, errors }] of rows.entries()) {
      // A relation can be missing or unreadable without affecting other rows.
      if (!Object.keys(errors).length) {
        for (const { name, label, collection } of relations) {
          const value = data[name];
          if (!value) continue;
          const ids = Array.isArray(value) ? value : [value];
          for (const id of ids) {
            if (await csvRelationAvailable(db, tenant, collection, String(id)))
              continue;
            errors[name] = policy
              ? `${label} requiere un registro relacionado disponible.`
              : `${label}: registro relacionado inexistente (${id}).`;
            break;
          }
        }
      }
      if (Object.keys(errors).length) {
        results.push({
          row: index + 2,
          status: "error",
          error: Object.values(errors).join(" "),
          data,
        });
        continue;
      }
      const checks = duplicateFields.flatMap((field) => {
        const value = data[field];
        if (value == null || value === "") return [];
        const normalized =
          typeof value === "string" ? value.trim().toLocaleLowerCase() : value;
        const sql = `SELECT id FROM studio_records WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL AND LOWER(TRIM(${dialectFor(db).jsonText("data", `$.${field}`)}))=? LIMIT 1`;
        const parameters = [
          tenant,
          objectName,
          String(
            typeof value === "boolean"
              ? Number(value)
              : typeof value === "object"
                ? JSON.stringify(value)
                : value,
          )
            .trim()
            .toLowerCase(),
        ];
        return [
          {
            field,
            sql,
            parameters,
            key: `${field}:${JSON.stringify(normalized)}`,
            error: `${object.config.fields[field].label}: valor duplicado (${String(value)}).`,
          },
        ];
      });
      const findDuplicate = async () => {
        for (const check of checks) {
          if (
            seen.has(check.key) ||
            (await db
              .prepare(check.sql)
              .bind(...check.parameters)
              .first())
          )
            return check.error;
        }
      };
      const reportDuplicate = (error: string) => {
        results.push({
          row: index + 2,
          status: input.duplicatePolicy === "skip" ? "skipped" : "error",
          error,
          data,
        });
      };
      const duplicate = await findDuplicate();
      const key = commit ? `csv:${input.importId}:${index}` : undefined;
      try {
        // A previously saved row can match its own duplicate field on a retry.
        const replay =
          duplicate && key
            ? await findCreatedRecordReplay(db, tenant, objectName, data, key)
            : undefined;
        if (duplicate && !replay) {
          reportDuplicate(duplicate);
          continue;
        }
        if (replay) await assertLocalCollection(db, tenant, objectName);
        let record = replay;
        if (commit && !record) {
          // Configured unique fields already have a transactional constraint.
          const selectedCheck = checks.find(
            ({ field }) =>
              field === input.duplicateField &&
              !object.config.fields[field].config?.unique,
          );
          const duplicateGuard =
            selectedCheck &&
            guard(
              db,
              `SELECT NOT EXISTS (${selectedCheck.sql})`,
              selectedCheck.parameters,
            );
          try {
            record = await createRecord(db, tenant, objectName, data, {
              idempotencyKey: key,
              createdBy: c.get("principalId"),
              ...(duplicateGuard
                ? {
                    checkpoint: {
                      before: [duplicateGuard.start],
                      after: () => [duplicateGuard.end],
                    },
                  }
                : {}),
            });
          } catch (error) {
            if (
              !databaseConflict(error) &&
              !(error instanceof HTTPException && error.status === 409)
            )
              throw error;
            if (key)
              record = await findCreatedRecordReplay(
                db,
                tenant,
                objectName,
                data,
                key,
              );
            if (!record) {
              const concurrentDuplicate = await findDuplicate();
              if (!concurrentDuplicate) throw error;
              reportDuplicate(concurrentDuplicate);
              continue;
            }
          }
        }
        // Preview reserves ready rows. Confirmation reserves only saved rows.
        for (const check of checks) seen.add(check.key);
        if (!record) {
          results.push({ row: index + 2, status: "ready", data });
          continue;
        }
        let warning: string | undefined;
        try {
          await runAutomations(db, tenant, objectName, null, record);
        } catch (e) {
          warning = `Registro creado; no se pudo ejecutar el seguimiento automático: ${(e as Error).message}`;
        }
        results.push({
          row: index + 2,
          status: "created",
          id: record.id,
          data,
          ...(warning ? { error: warning } : {}),
        });
      } catch (e) {
        results.push({
          row: index + 2,
          status: "error",
          error: (e as Error).message,
          data,
        });
      }
    }
    return c.json({
      data: results,
      headers: parsed.headers,
      total: results.length,
      importId: input.importId ?? crypto.randomUUID(),
      summary: {
        ready: results.filter((r) => r.status === "ready").length,
        created: results.filter((r) => r.status === "created").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        errors: results.filter((r) => r.status === "error").length,
      },
    });
  }
  app.post("/api/import/:object/preview", (c) => importRows(c, false));
  app.post("/api/import/:object/commit", (c) => importRows(c, true));
  app.get("/api/export/:object", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant"),
      objectName = c.req.param("object"),
      params = c.req.query(),
      object = await getObject(db, tenant, objectName),
      custom = parseCsvExportColumns(params, object);
    if (custom) {
      const { columns, headers: headerLabels } = custom;
      const { where, args } = buildWhere(
        object,
        tenant,
        params,
        undefined,
        dialectFor(db),
      );
      const total = await db
        .prepare(`SELECT count(*) AS total FROM studio_records WHERE ${where}`)
        .bind(...args)
        .first<{ total: number }>();
      if ((total?.total ?? 0) > 10_000)
        fail(
          "La exportación admite hasta 10.000 registros. Aplica filtros para reducir el resultado.",
        );
      const sort = params.sort ?? "updated_at";
      const order = params.order === "ASC" ? "ASC" : "DESC";
      if (
        !["created_at", "updated_at", "id"].includes(sort) &&
        !object.config.fields[sort]
      )
        fail("Campo de orden inválido.");
      const sortSql = ["created_at", "updated_at", "id"].includes(sort)
        ? sort
        : dialectFor(db).jsonSort("data", `$.${sort}`);
      const { results } = await db
        .prepare(
          `SELECT * FROM studio_records WHERE ${where} ORDER BY ${sortSql} ${order}, id ASC LIMIT 10000`,
        )
        .bind(...args)
        .all<any>();
      const csv =
        "\uFEFF" +
        csvLine(headerLabels) +
        results
          .map((row) => {
            const record = parseRecord(row);
            return csvLine(
              columns.map((key) => formatRecordCsvValue(record[key])),
            );
          })
          .join("");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${recordsCsvFilename(objectName)}"`,
        },
      });
    }
    const headers = csvHeaders(object);
    // Cursor pagination avoids both a 100-row cap and offset drift during export.
    let cursor = "",
      finished = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("\uFEFF" + csvLine(headers)));
      },
      async pull(controller) {
        if (finished) {
          controller.close();
          return;
        }
        try {
          const { results } = await db
            .prepare(
              "SELECT * FROM studio_records WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL AND id>? ORDER BY id LIMIT 200",
            )
            .bind(tenant, objectName, cursor)
            .all<any>();
          if (!results.length) {
            finished = true;
            controller.close();
            return;
          }
          controller.enqueue(
            encoder.encode(
              results
                .map((row) => {
                  const record = parseRecord(row);
                  return csvLine(headers.map((key) => record[key]));
                })
                .join(""),
            ),
          );
          cursor = results[results.length - 1].id;
          if (results.length < 200) {
            finished = true;
            controller.close();
          }
        } catch (error) {
          controller.error(error);
        }
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${recordsCsvFilename(objectName)}"`,
      },
    });
  });

  app.get("/api/automations", async (c) => {
    const { results } = await c.env.DB.prepare(
      "SELECT * FROM studio_automations WHERE tenant_id=? ORDER BY created_at DESC,id",
    )
      .bind(c.get("tenant"))
      .all<any>();
    return c.json({
      data: results.map((r) => ({
        ...r,
        enabled: Boolean(r.enabled),
        config: JSON.parse(r.config),
      })),
    });
  });
  async function saveAutomation(c: any, edit: boolean) {
    const body = await c.req.json(),
      input = automationSchema.parse(body),
      db = c.env.DB as D1Database,
      tenant = c.get("tenant");
    await assertLocalCollection(db, tenant, input.object_name);
    const object = await getObject(db, tenant, input.object_name);
    if (!object.config.fields[input.config.field])
      return fail("Selecciona un campo existente.", 422);
    if (object.config.fields[input.config.field].config?.multiple)
      return fail("El disparador necesita un campo de valor simple.", 422);
    const triggerError = validateRecord(object, {
      [input.config.field]: input.config.value,
    }).errors[input.config.field];
    if (triggerError) return fail(triggerError, 422);
    if (
      input.config.ownerField &&
      !object.config.fields[input.config.ownerField]
    )
      return fail("El campo responsable no existe.", 422);
    const id = edit ? c.req.param("id") : crypto.randomUUID();
    if (edit) {
      const { version } = versionSchema.parse(body);
      const result = await db
        .prepare(
          "UPDATE studio_automations SET name=?,object_name=?,config=?,enabled=?,version=version+1 WHERE tenant_id=? AND id=? AND version=?",
        )
        .bind(
          input.name,
          input.object_name,
          JSON.stringify(input.config),
          Number(input.enabled),
          tenant,
          id,
          version,
        )
        .run();
      if (!result.meta.changes)
        return fail("La automatización cambió. Actualiza para continuar.", 409);
    } else
      await db
        .prepare(
          "INSERT INTO studio_automations (id,tenant_id,object_name,name,config,enabled) VALUES (?,?,?,?,?,?)",
        )
        .bind(
          id,
          tenant,
          input.object_name,
          input.name,
          JSON.stringify(input.config),
          Number(input.enabled),
        )
        .run();
    await audit(
      db,
      tenant,
      edit ? "automation.updated" : "automation.created",
      input.object_name,
      null,
      { id, name: input.name },
    ).run();
    return c.json({
      data: { id, ...input, version: edit ? body.version + 1 : 1 },
    });
  }
  app.post("/api/automations", (c) => saveAutomation(c, false));
  app.patch("/api/automations/:id", (c) => saveAutomation(c, true));
  app.delete("/api/automations/:id", async (c) => {
    const { version } = versionSchema.parse(await c.req.json());
    const result = await c.env.DB.prepare(
      "DELETE FROM studio_automations WHERE tenant_id=? AND id=? AND version=?",
    )
      .bind(c.get("tenant"), c.req.param("id"), version)
      .run();
    if (!result.meta.changes)
      return fail("La automatización cambió o ya no existe.", 409);
    return c.json({ ok: true });
  });
  app.get("/api/automation-runs", async (c) => {
    const page = pageNumber(c.req.query("page")),
      db = c.env.DB,
      tenant = c.get("tenant");
    const { results } = await db
      .prepare(
        "SELECT * FROM studio_automation_runs WHERE tenant_id=? ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
      )
      .bind(tenant, pageSize, (page - 1) * pageSize)
      .all<any>();
    const total = await db
      .prepare(
        "SELECT count(*) AS total FROM studio_automation_runs WHERE tenant_id=?",
      )
      .bind(tenant)
      .first<{ total: number }>();
    return c.json({
      data: results.map((row) => ({ ...row, detail: JSON.parse(row.detail) })),
      total: total?.total ?? 0,
    });
  });
  app.post("/api/automation-runs/:id/retry", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant");
    const row = await db
      .prepare(
        "SELECT * FROM studio_automation_runs WHERE tenant_id=? AND id=?",
      )
      .bind(tenant, c.req.param("id"))
      .first<any>();
    if (!row) return fail("La ejecución no existe.", 404);
    if (row.status === "success") return c.json({ ok: true });
    const detail = JSON.parse(row.detail);
    if (!detail.after)
      return fail("Esta ejecución no contiene un evento recuperable.", 422);
    const current = await getRecord(db, tenant, row.object_name, row.record_id);
    if (current._version !== detail.after._version)
      return fail(
        "El registro cambió desde el error; revisa la regla y actualiza el registro para generar un nuevo evento.",
        409,
      );
    const rule = await db
      .prepare(
        "SELECT version,enabled FROM studio_automations WHERE tenant_id=? AND id=?",
      )
      .bind(tenant, row.automation_id)
      .first<{ version: number; enabled: number }>();
    if (
      !rule ||
      !rule.enabled ||
      String(rule.version) !== String(row.event_key).split(":").at(-1)
    )
      return fail(
        "La regla cambió o está pausada. Revisa la configuración antes de generar un nuevo evento.",
        409,
      );
    await runAutomations(
      db,
      tenant,
      row.object_name,
      detail.before,
      detail.after,
      { ruleId: row.automation_id },
    );
    return c.json({ ok: true });
  });
  app.get("/api/tasks", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant"),
      page = pageNumber(c.req.query("page"));
    let where =
      "tenant_id=? AND EXISTS(SELECT 1 FROM studio_records r WHERE r.tenant_id=studio_tasks.tenant_id AND r.id=studio_tasks.record_id AND r.deleted_at IS NULL)";
    const args: (string | number)[] = [tenant];
    if (c.req.query("object")) {
      where += " AND object_name=?";
      args.push(c.req.query("object")!);
    }
    if (c.req.query("record")) {
      where += " AND record_id=?";
      args.push(c.req.query("record")!);
    }
    if (c.req.query("status") === "overdue") {
      where += " AND status='pending' AND due_at<?";
      args.push(now().slice(0, 10));
    } else if (["pending", "done"].includes(c.req.query("status") ?? "")) {
      where += " AND status=?";
      args.push(c.req.query("status")!);
    }
    const { results } = await db
      .prepare(
        `SELECT * FROM studio_tasks WHERE ${where} ORDER BY status DESC,due_at,id LIMIT ? OFFSET ?`,
      )
      .bind(...args, pageSize, (page - 1) * pageSize)
      .all();
    const total = await db
      .prepare(`SELECT count(*) AS total FROM studio_tasks WHERE ${where}`)
      .bind(...args)
      .first<{ total: number }>();
    const overdue = await db
      .prepare(
        "SELECT count(*) AS total FROM studio_tasks WHERE tenant_id=? AND status='pending' AND due_at<? AND EXISTS(SELECT 1 FROM studio_records r WHERE r.tenant_id=studio_tasks.tenant_id AND r.id=studio_tasks.record_id AND r.deleted_at IS NULL)",
      )
      .bind(tenant, now().slice(0, 10))
      .first<{ total: number }>();
    return c.json({
      data: results,
      total: total?.total ?? 0,
      overdue: overdue?.total ?? 0,
    });
  });
  const taskSchema = z.object({
    title: z.string().trim().min(1).max(200),
    owner: z.string().max(100).default(""),
    due_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(
        (v) =>
          !Number.isNaN(Date.parse(v)) &&
          new Date(v).toISOString().slice(0, 10) === v,
        "Fecha inválida",
      ),
    status: z.enum(["pending", "done"]).default("pending"),
  });
  app.post("/api/tasks", async (c) => {
    const body = await c.req.json(),
      input = taskSchema
        .extend({ object_name: identifier, record_id: z.string().min(1) })
        .parse(body),
      db = c.env.DB,
      tenant = c.get("tenant");
    await getRecord(db, tenant, input.object_name, input.record_id);
    const id = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          "INSERT INTO studio_tasks (id,tenant_id,object_name,record_id,title,owner,due_at,status) VALUES (?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          tenant,
          input.object_name,
          input.record_id,
          input.title,
          input.owner,
          input.due_at,
          input.status,
        ),
      audit(db, tenant, "task.created", input.object_name, input.record_id, {
        title: input.title,
        due_at: input.due_at,
      }),
    ]);
    return c.json({ data: { id, ...input, version: 1 } }, 201);
  });
  app.patch("/api/tasks/:id", async (c) => {
    const body = await c.req.json(),
      input = taskSchema.parse(body),
      { version } = versionSchema.parse(body),
      db = c.env.DB,
      tenant = c.get("tenant");
    const row = await db
      .prepare("SELECT * FROM studio_tasks WHERE tenant_id=? AND id=?")
      .bind(tenant, c.req.param("id"))
      .first<any>();
    if (!row) return fail("La tarea no existe.", 404);
    await getRecord(db, tenant, row.object_name, row.record_id);
    const result = await db
      .prepare(
        "UPDATE studio_tasks SET title=?,owner=?,due_at=?,status=?,version=version+1 WHERE tenant_id=? AND id=? AND version=?",
      )
      .bind(
        input.title,
        input.owner,
        input.due_at,
        input.status,
        tenant,
        row.id,
        version,
      )
      .run();
    if (!result.meta.changes)
      return fail("La tarea cambió. Actualiza para continuar.", 409);
    await audit(
      db,
      tenant,
      input.status === "done" ? "task.completed" : "task.updated",
      row.object_name,
      row.record_id,
      input,
    ).run();
    return c.json({ data: { ...row, ...input, version: version + 1 } });
  });
  app.delete("/api/tasks/:id", async (c) => {
    const { version } = versionSchema.parse(await c.req.json());
    const result = await c.env.DB.prepare(
      "DELETE FROM studio_tasks WHERE tenant_id=? AND id=? AND version=?",
    )
      .bind(c.get("tenant"), c.req.param("id"), version)
      .run();
    if (!result.meta.changes)
      return fail("La tarea cambió o ya no existe.", 409);
    return c.json({ ok: true });
  });
  app.get("/api/reports", async (c) => {
    const db = c.env.DB,
      tenant = c.get("tenant");
    const { results } = await db
      .prepare("SELECT * FROM studio_objects WHERE tenant_id=? ORDER BY name")
      .bind(tenant)
      .all<any>();
    const reports = [];
    for (const object of results.map(parseObject)) {
      const pipeline = getPipeline(object);
      if (!pipeline?.field || !object.config.fields[pipeline.field]) continue;
      const stage = `$.${identifier.parse(pipeline.field)}`;
      const amount =
        pipeline.amountField && object.config.fields[pipeline.amountField]
          ? `$.${identifier.parse(pipeline.amountField)}`
          : "$.nonexistent_field";
      const owner =
        pipeline.ownerField && object.config.fields[pipeline.ownerField]
          ? `$.${identifier.parse(pipeline.ownerField)}`
          : "$.nonexistent_field";
      const { results: groups } = await db
        .prepare(
          `SELECT COALESCE(${dialectFor(db).jsonText("data", stage)},'Sin etapa') AS stage,COALESCE(${dialectFor(db).jsonText("data", owner)},'Sin responsable') AS owner,count(*) AS count,COALESCE(SUM(CAST(${dialectFor(db).jsonValue("data", amount)} AS DOUBLE PRECISION)),0) AS amount FROM studio_records WHERE tenant_id=? AND object_name=? AND deleted_at IS NULL GROUP BY 1,2 ORDER BY 1,2`,
        )
        .bind(tenant, object.name)
        .all<{ stage: string; owner: string; count: number; amount: number }>();
      const won = groups
          .filter((g) =>
            (pipeline.wonValues ?? []).map(String).includes(g.stage),
          )
          .reduce((n, g) => n + g.count, 0),
        lost = groups
          .filter((g) =>
            (pipeline.lostValues ?? []).map(String).includes(g.stage),
          )
          .reduce((n, g) => n + g.count, 0);
      reports.push({
        object: object.name,
        label: object.label,
        groups,
        total: groups.reduce((n, g) => n + g.count, 0),
        amount: groups.reduce((n, g) => n + g.amount, 0),
        won,
        lost,
        conversion: won + lost ? won / (won + lost) : null,
        configured: {
          field: pipeline.field,
          amountField: pipeline.amountField,
          ownerField: pipeline.ownerField,
        },
      });
    }
    return c.json({ data: reports, generatedAt: now() });
  });
}

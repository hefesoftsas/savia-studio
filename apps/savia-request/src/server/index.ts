import { databaseConflict, databaseInputFailure } from "@savia/db/errors";
import { HTTPException } from "hono/http-exception";
import { daneCityFlow, lookupDaneCity } from "./dane";
import { validateRequestCachePolicy } from "./request-cache";
import { openApi } from "./openapi";
import { Hono } from "hono";
import type { Env } from "./env";
import { guardStorageEnvironment } from "../../../../packages/backup-gate/index.mjs";
import {
  backupCapability,
  handleBackupControl,
} from "../../../../packages/backup-gate/control.mjs";
import type { Flow, Variable } from "./types";
import {
  SecretReplacementRequiredError,
  bundleStatus,
  createFolder,
  deleteFlow,
  deleteFolder,
  duplicateFlow,
  ensureExampleRequestBundleBundle,
  folderExists,
  hasCompiledBundle,
  getFlow,
  getRun,
  getVariables,
  getVersionDefinition,
  importVariables,
  listAuditEvents,
  listFolders,
  listRuns,
  listScopedFlows,
  listVersions,
  publishFlow,
  purgeTenant,
  recordAudit,
  resetFlow,
  resetVariable,
  resolveVersion,
  saveFlowAndVariables,
  saveFlow,
  saveVariables,
  seedOnce,
  syncExampleRequestBundleBundle,
} from "./store";
import { isPlatformTenant, scopeTenant, tenantFromRequest } from "./tenant";
import { execute } from "./runner";
import { demoInput } from "./mock";
const app = new Hono<{ Bindings: Env }>();
const scopeOf = tenantFromRequest;
/** Principal id forwarded by the API gateway for attribution, if any. */
function actorOf(request: Request): string {
  return (request.headers.get("x-savia-actor") ?? "").slice(0, 200);
}
app.use("*", async (c, next) => {
  if (new URL(c.req.url).hostname !== "savia-request.internal")
    return c.json({ error: "Acceso privado." }, 403);
  if (
    ["POST", "PUT", "DELETE"].includes(c.req.method) &&
    !c.req.header("content-type")?.startsWith("application/json")
  )
    return c.json({ error: "Usa application/json." }, 415);
  try {
    scopeOf(c.req.raw);
  } catch {
    return c.json({ error: "Tenant inválido." }, 400);
  }
  c.header("Cache-Control", "no-store");
  await next();
});
app.get("/api/lookups/dane", async (c) => {
  const city = c.req.query("city") ?? "";
  const department = c.req.query("department");
  if (
    city.trim().length < 2 ||
    city.length > 100 ||
    (department?.length ?? 0) > 100
  )
    return c.json({ error: "Indica una ciudad válida." }, 400);
  try {
    const definition = c.env?.DB
      ? await getFlow(c.env, daneCityFlow.id, scopeOf(c.req.raw))
      : daneCityFlow;
    return c.json(
      await lookupDaneCity(
        c.req.query("city") ?? "",
        c.req.query("department"),
        fetch,
        c.env,
        definition?.steps[0]?.cache,
        scopeOf(c.req.raw),
      ),
    );
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error ? error.message : "No se pudo consultar DANE.",
      },
      502,
    );
  }
});
app.get("/api/health", (c) => c.json({ ok: true, local: true }));
app.use("/api/bundles/example-request-bundle/*", async (c, next) => {
  if (!hasCompiledBundle()) return c.notFound();
  await next();
});
app.post("/api/bundles/example-request-bundle/ensure", async (c) => {
  const scope = scopeOf(c.req.raw);
  const installed = await ensureExampleRequestBundleBundle(c.env, scope);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "bundle.ensure",
    detail: { bundle: installed.id, version: installed.version },
  });
  return c.json(installed);
});
app.get("/api/bundles/example-request-bundle/status", async (c) =>
  c.json(await bundleStatus(c.env, scopeOf(c.req.raw))),
);
app.post("/api/bundles/example-request-bundle/sync", async (c) => {
  const scope = scopeOf(c.req.raw);
  const body = await c.req.json().catch(() => ({}));
  const flowIds = body?.flowIds;
  const force = body?.force;
  if (
    (flowIds !== undefined &&
      (!Array.isArray(flowIds) ||
        flowIds.length > 200 ||
        flowIds.some(
          (id: unknown) => typeof id !== "string" || !id || id.length > 120,
        ))) ||
    (force !== undefined && typeof force !== "boolean")
  )
    return c.json({ error: "Parámetros de sincronización inválidos." }, 400);
  const result = await syncExampleRequestBundleBundle(c.env, scope, {
    ...(flowIds === undefined ? {} : { flowIds }),
    ...(force === undefined ? {} : { force }),
  });
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "bundle.sync",
    detail: {
      version: result.version,
      updated: result.updated.length,
      installed: result.installed.length,
      skipped: result.skippedCustomized.length,
    },
  });
  return c.json(result);
});
/**
 * Tenant lifecycle: removes every overlay row (flows, variables including
 * sealed secrets, versions, runs, folders, bundle markers) so a deleted
 * tenant leaves nothing behind. The platform catalog ("") is refused.
 * Reachable by platform admins through the API proxy; a scoped caller may
 * only purge its own scope.
 */
app.delete("/api/admin/tenants/:tenant", async (c) => {
  let scope: string;
  try {
    scope = scopeTenant(c.req.param("tenant"));
  } catch {
    return c.json({ error: "Tenant inválido." }, 400);
  }
  if (!scope) return c.json({ error: "Tenant inválido." }, 400);
  const caller = scopeOf(c.req.raw);
  if (caller && caller !== scope)
    return c.json({ error: "Acceso privado." }, 403);
  try {
    const purged = await purgeTenant(c.env, scope);
    await recordAudit(c.env, {
      tenant: scope,
      actor: actorOf(c.req.raw),
      action: "tenant.purge",
      detail: { purged },
    });
    return c.json({ tenant: scope, purged });
  } catch {
    return c.json(
      { error: "El catálogo de plataforma no se puede purgar." },
      400,
    );
  }
});
app.get("/api/flows", async (c) => {
  const scope = scopeOf(c.req.raw);
  await seedOnce(c.env);
  const flows = await listScopedFlows(c.env, scope);
  return c.json(
    flows.map((flow) => ({
      id: flow.id,
      name: flow.name,
      folderPath: flow.folderPath,
      customized: flow.customized ?? false,
      steps: flow.steps.map((s) => ({
        id: s.id,
        name: s.name,
        method: s.method,
      })),
    })),
  );
});
app.get("/api/folders", async (c) => {
  return c.json(await listFolders(c.env, scopeOf(c.req.raw)));
});
app.post("/api/folders", async (c) => {
  const scope = scopeOf(c.req.raw);
  const { path } = await c.req.json();
  if (typeof path !== "string")
    return c.json({ error: "Nombre de carpeta inválido." }, 400);
  const parts = path.split("/").map((part) => part.trim());
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  )
    return c.json(
      { error: "Escribe un nombre válido para cada carpeta." },
      400,
    );
  const normalized = parts.join("/");
  if (await folderExists(c.env, normalized, scope))
    return c.json({ error: "Ya existe una carpeta en esa ubicación." }, 409);
  await createFolder(c.env, normalized, scope);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "folder.create",
    detail: { path: normalized },
  });
  return c.json({ path: normalized }, 201);
});
app.delete("/api/folders", async (c) => {
  const scope = scopeOf(c.req.raw);
  const { path } = await c.req.json();
  if (typeof path !== "string" || !path.trim())
    return c.json({ error: "Carpeta inválida." }, 400);
  for (const flow of await listScopedFlows(c.env, scope)) {
    if (flow?.folderPath === path || flow?.folderPath?.startsWith(path + "/"))
      return c.json(
        {
          error:
            "La carpeta contiene requests. Muévelos a otra carpeta antes de eliminarla.",
        },
        409,
      );
  }
  await deleteFolder(c.env, path, scope);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "folder.delete",
    detail: { path },
  });
  return c.json({ ok: true });
});
app.post("/api/flows/:id/duplicate", async (c) => {
  const scope = scopeOf(c.req.raw);
  const duplicated = await duplicateFlow(c.env, c.req.param("id"), scope);
  if (!duplicated) return c.json({ error: "Request no encontrado." }, 404);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "flow.duplicate",
    flowId: duplicated.id,
    detail: { source: c.req.param("id") },
  });
  return c.json(duplicated, 201);
});
app.delete("/api/flows/:id", async (c) => {
  const scope = scopeOf(c.req.raw);
  const id = c.req.param("id");
  if (!(await deleteFlow(c.env, id, scope)))
    return c.json({ error: "Request no encontrado." }, 404);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "flow.delete",
    flowId: id,
  });
  return c.json({ ok: true });
});
app.post("/api/flows/:id/variables/reveal", async (c) => {
  const scope = scopeOf(c.req.raw);
  const { key } = await c.req.json();
  const rows = await getVariables(c.env, c.req.param("id"), true, scope);
  const variable = rows.find((v) => v.key === key);
  if (!variable) return c.json({ error: "Variable no encontrada." }, 404);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "variable.reveal",
    flowId: c.req.param("id"),
    detail: { key },
  });
  return c.json({ value: variable.value });
});
app.get("/api/demo-input", (c) => c.json(demoInput));
app.get("/api/flows/:id", async (c) => {
  const scope = scopeOf(c.req.raw);
  const flow = await getFlow(c.env, c.req.param("id"), scope);
  if (!flow) return c.json({ error: "Flow no encontrado." }, 404);
  const inTenant = !isPlatformTenant(scope);
  const [variables, versions, platformFlow] = await Promise.all([
    getVariables(c.env, flow.id, false, scope),
    listVersions(c.env, flow.id, scope),
    inTenant && flow.customized ? getFlow(c.env, flow.id) : null,
  ]);
  return c.json({
    ...flow,
    variables,
    versions,
    hasPlatformDefault: inTenant && (!flow.customized || Boolean(platformFlow)),
  });
});
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

const malformedJsonError = { error: "Envía un cuerpo JSON válido." };

function validateFlow(
  value: unknown,
  id: string,
): { flow: Flow } | { error: string } {
  if (!isRecord(value))
    return { error: "La definición del flujo debe ser un objeto." };
  if (!/^[a-z0-9-]{1,80}$/.test(id))
    return { error: "El identificador del flujo no es válido." };
  if (typeof value.name !== "string" || !value.name.trim())
    return { error: "Indica un nombre para el flujo." };
  if (!isStringRecord(value.input))
    return {
      error: "La entrada del flujo debe ser un objeto con valores de texto.",
    };
  if (!Array.isArray(value.steps) || value.steps.length === 0)
    return { error: "Agrega al menos un paso al flujo." };

  for (const [index, step] of value.steps.entries()) {
    const position = index + 1;
    if (!isRecord(step))
      return { error: `El paso ${position} debe ser un objeto.` };
    if (
      typeof step.id !== "string" ||
      !step.id.trim() ||
      typeof step.name !== "string" ||
      !step.name.trim() ||
      typeof step.url !== "string" ||
      typeof step.method !== "string" ||
      !step.method.trim()
    )
      return {
        error: `Revisa el identificador, nombre, URL y método del paso ${position}.`,
      };
    if (
      typeof step.body !== "string" ||
      typeof step.pre !== "string" ||
      typeof step.post !== "string"
    )
      return {
        error: `El cuerpo y los scripts del paso ${position} deben ser texto.`,
      };
    if (!isStringRecord(step.headers))
      return {
        error: `Los encabezados del paso ${position} deben ser un objeto con valores de texto.`,
      };
    if (step.cache === undefined) continue;
    if (!validateRequestCachePolicy(step.cache))
      return {
        error: `Revisa la configuración de caché del paso ${position}.`,
      };
    if (step.cache.enabled && !["GET", "HEAD"].includes(step.method))
      return { error: `El paso ${position} solo admite caché con GET o HEAD.` };
    if (step.cache.enabled && step.cache.scope === "connection")
      return {
        error: `Usa caché de tenant en el paso ${position} para un flujo sin conexión asociada.`,
      };
  }

  return {
    flow: {
      ...value,
      id,
      name: value.name,
      input: value.input,
      steps: value.steps,
    } as Flow,
  };
}
async function auditFlowSave(
  env: Env,
  scope: string,
  actor: string,
  flow: Flow,
) {
  await recordAudit(env, {
    tenant: scope,
    actor,
    action: "flow.save",
    flowId: flow.id,
    detail: {
      name: flow.name,
      hosts: [
        ...new Set(
          flow.steps.map((step) => {
            try {
              return new URL(step.url).host;
            } catch {
              return "template";
            }
          }),
        ),
      ],
    },
  });
}
app.put("/api/flows/:id", async (c) => {
  const scope = scopeOf(c.req.raw);
  const payload = await c.req.json<unknown>().catch(() => undefined);
  if (payload === undefined) return c.json(malformedJsonError, 400);
  const result = validateFlow(payload, c.req.param("id"));
  if ("error" in result) return c.json(result, 400);
  const { flow } = result;
  await saveFlow(c.env, flow, scope);
  await auditFlowSave(c.env, scope, actorOf(c.req.raw), flow);
  return c.json({ ok: true });
});
app.put("/api/flows/:id/variables", async (c) => {
  const scope = scopeOf(c.req.raw);
  const payload = await c.req
    .json<Variable[] | { flow: Flow; variables: Variable[] }>()
    .catch(() => undefined);
  if (payload === undefined) return c.json(malformedJsonError, 400);
  const variablesOnly = Array.isArray(payload);
  const rows = variablesOnly ? payload : payload?.variables;
  if (
    !Array.isArray(rows) ||
    rows.length > 150 ||
    rows.some(
      (v) =>
        !v ||
        typeof v.key !== "string" ||
        !/^[\w.-]{1,120}$/.test(v.key) ||
        typeof v.value !== "string" ||
        typeof v.secret !== "boolean",
    ) ||
    new Set(rows.map((v) => v.key)).size !== rows.length
  )
    return c.json({ error: "Variables inválidas o claves duplicadas." }, 400);
  const flow = await getFlow(c.env, c.req.param("id"), scope);
  if (!flow) return c.json({ error: "Flow no encontrado." }, 404);
  const actor = actorOf(c.req.raw);
  if (variablesOnly) {
    await saveVariables(c.env, flow.id, rows, scope);
  } else {
    const result = validateFlow(payload?.flow, flow.id);
    if ("error" in result) return c.json(result, 400);
    const draft = result.flow;
    await saveFlowAndVariables(c.env, draft, rows, scope);
    await auditFlowSave(c.env, scope, actor, draft);
  }
  await recordAudit(c.env, {
    tenant: scope,
    actor,
    action: "variables.save",
    flowId: flow.id,
    detail: { keys: rows.length },
  });
  // The write is already committed if the follow-up read is unavailable.
  const variables = await getVariables(c.env, flow.id, false, scope).catch(
    () => undefined,
  );
  return c.json({ ok: true, variables });
});
/**
 * Reverts one tenant customization back to the platform catalog.
 * Flow reset removes its definition and variable overlays (tenant-only
 * flows disappear; versions and runs are kept as history). Variable reset
 * removes a single override so the platform default applies again.
 */
app.post("/api/flows/:id/reset", async (c) => {
  const scope = scopeOf(c.req.raw);
  if (isPlatformTenant(scope))
    return c.json(
      { error: "El restablecido solo aplica a scopes de tenant." },
      400,
    );
  const status = await resetFlow(
    c.env,
    c.req.param("id"),
    scope,
    c.req.query("requirePlatformDefault") === "true",
  );
  if (status === "unknown-flow")
    return c.json({ error: "Flow no encontrado." }, 404);
  if (status === "platform-default-unavailable")
    return c.json(
      {
        error:
          "El flow de plataforma ya no está disponible para restablecer. Vuelve a cargar el flow.",
      },
      409,
    );
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "flow.reset",
    flowId: c.req.param("id"),
    detail: { reverted: status === "reverted" },
  });
  return c.json({ ok: true, reverted: status === "reverted" });
});
app.delete("/api/flows/:id/variables/:key", async (c) => {
  const scope = scopeOf(c.req.raw);
  if (isPlatformTenant(scope))
    return c.json(
      { error: "El restablecido solo aplica a scopes de tenant." },
      400,
    );
  const status = await resetVariable(
    c.env,
    c.req.param("id"),
    c.req.param("key"),
    scope,
    c.req.query("requirePlatformDefault") === "true",
  );
  if (status === "unknown-flow")
    return c.json({ error: "Flow no encontrado." }, 404);
  if (status === "unknown-key")
    return c.json({ error: "Variable no encontrada." }, 404);
  if (status === "platform-default-unavailable")
    return c.json(
      {
        error:
          "El valor de plataforma ya no está disponible para restablecer. Vuelve a cargar el flow.",
      },
      409,
    );
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "variable.reset",
    flowId: c.req.param("id"),
    detail: { key: c.req.param("key"), reverted: status === "reverted" },
  });
  return c.json({ ok: true, reverted: status === "reverted" });
});
/** Single-request bulk transfer so moving secrets between environments is fast. */
app.get("/api/variables/export", async (c) => {
  const scope = scopeOf(c.req.raw);
  await seedOnce(c.env);
  const flows = [];
  for (const flow of await listScopedFlows(c.env, scope)) {
    const variables = await getVariables(c.env, flow.id, true, scope);
    if (variables.length)
      flows.push({
        flowId: flow.id,
        variables: variables
          .map((variable) => ({
            key: variable.key,
            value: variable.value,
            secret: variable.secret,
          }))
          .sort((left, right) => left.key.localeCompare(right.key)),
      });
  }
  return c.json({
    version: 1,
    exportedAt: new Date().toISOString(),
    tenant: scope,
    flows,
  });
});
app.post("/api/variables/import", async (c) => {
  const scope = scopeOf(c.req.raw);
  const body = await c.req.json();
  const incoming = Array.isArray(body) ? body : body?.flows;
  if (!Array.isArray(incoming) || !incoming.length || incoming.length > 200)
    return c.json({ error: "Archivo de secretos inválido." }, 400);
  const seen = new Set<string>();
  const parsed: { flowId: string; variables: Variable[] }[] = [];
  for (const flow of incoming) {
    if (
      !flow ||
      typeof flow.flowId !== "string" ||
      !flow.flowId ||
      seen.has(flow.flowId) ||
      !Array.isArray(flow.variables) ||
      flow.variables.length > 150
    )
      return c.json({ error: "Archivo de secretos inválido." }, 400);
    seen.add(flow.flowId);
    const variables: Variable[] = [];
    for (const variable of flow.variables) {
      if (
        !variable ||
        !/^[\w.-]{1,120}$/.test(variable.key) ||
        typeof variable.value !== "string" ||
        typeof variable.secret !== "boolean"
      )
        return c.json({ error: `Variable inválida en «${flow.flowId}».` }, 400);
      variables.push({
        key: variable.key,
        value: variable.value,
        secret: variable.secret,
      });
    }
    if (new Set(variables.map((v) => v.key)).size !== variables.length)
      return c.json({ error: `Claves duplicadas en «${flow.flowId}».` }, 400);
    parsed.push({ flowId: flow.flowId, variables });
  }
  const results = [];
  for (const flow of parsed) {
    if (!(await getFlow(c.env, flow.flowId, scope))) {
      results.push({
        flowId: flow.flowId,
        applied: 0,
        skipped: 0,
        status: "unknown",
      });
      continue;
    }
    const { applied, skipped } = await importVariables(
      c.env,
      flow.flowId,
      flow.variables,
      scope,
    );
    results.push({
      flowId: flow.flowId,
      applied,
      skipped,
      status: applied ? "updated" : "unchanged",
    });
  }
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "variables.import",
    detail: {
      flows: results.length,
      applied: results.reduce((total, result) => total + result.applied, 0),
      skipped: results.reduce((total, result) => total + result.skipped, 0),
    },
  });
  return c.json({ results });
});
app.post("/api/flows/:id/publish", async (c) => {
  const scope = scopeOf(c.req.raw);
  const published = await publishFlow(c.env, c.req.param("id"), scope);
  if (!published) return c.json({ error: "Flow no encontrado." }, 404);
  await recordAudit(c.env, {
    tenant: scope,
    actor: actorOf(c.req.raw),
    action: "flow.publish",
    flowId: c.req.param("id"),
    detail: { version: published.id },
  });
  return c.json({ id: published.id });
});
/**
 * Audit trail for the caller's scope: who changed or revealed what, newest
 * first. Keyset pagination via `cursor` (opaque, from `nextCursor`).
 */
app.get("/api/audit", async (c) => {
  const scope = scopeOf(c.req.raw);
  const limit = Number(c.req.query("limit") ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    return c.json({ error: "Límite inválido." }, 400);
  return c.json(
    await listAuditEvents(c.env, scope, {
      limit,
      cursor: c.req.query("cursor") ?? undefined,
    }),
  );
});
app.post("/api/flows/:id/runs", async (c) => {
  const scope = scopeOf(c.req.raw);
  const flow = await getFlow(c.env, c.req.param("id"), scope);
  if (!flow) return c.json({ error: "Flow no encontrado." }, 404);
  const body = await c.req.json();
  if (
    !["mock", "live"].includes(body.mode) ||
    !body.input ||
    typeof body.input !== "object" ||
    Array.isArray(body.input) ||
    Object.values(body.input).some((v) => typeof v !== "string")
  )
    return c.json({ error: "Envía mode e input con valores de texto." }, 400);
  return c.json(await execute(c.env, flow, body.input, body.mode, null, scope));
});
app.get("/api/flows/:id/runs", async (c) => {
  const scope = scopeOf(c.req.raw);
  return c.json(await listRuns(c.env, c.req.param("id"), scope));
});
// Read-only result access for the authenticated normalization layer.
app.get("/api/flows/:id/versions/:versionId", async (c) => {
  const scope = scopeOf(c.req.raw);
  const definition = await getVersionDefinition(
    c.env,
    c.req.param("id"),
    c.req.param("versionId"),
    scope,
  );
  if (!definition) return c.json({ error: "Versión no encontrada." }, 404);
  return c.json(JSON.parse(definition));
});
app.get("/api/flows/:id/runs/:runId", async (c) => {
  const scope = scopeOf(c.req.raw);
  const row = await getRun(
    c.env,
    c.req.param("id"),
    c.req.param("runId"),
    scope,
  );
  if (!row) return c.json({ error: "Ejecución no encontrada." }, 404);
  const definition = row.version_id
    ? await getVersionDefinition(
        c.env,
        c.req.param("id"),
        row.version_id,
        scope,
      )
    : (await getFlow(c.env, c.req.param("id"), scope))
      ? JSON.stringify(await getFlow(c.env, c.req.param("id"), scope))
      : null;
  if (!definition) return c.json({ error: "Definición no encontrada." }, 404);
  return c.json({
    run: JSON.parse(row.summary),
    flow: JSON.parse(definition),
  });
});
app.post("/v1/flows/:id/runs", async (c) => {
  const scope = scopeOf(c.req.raw);
  const body = await c.req.json();
  const version = await resolveVersion(
    c.env,
    c.req.param("id"),
    body.versionId,
    scope,
  );
  if (!version) return c.json({ error: "Publica una versión primero." }, 409);
  if (
    !["mock", "live"].includes(body.mode) ||
    !body.input ||
    typeof body.input !== "object" ||
    Array.isArray(body.input) ||
    Object.values(body.input).some((v) => typeof v !== "string")
  )
    return c.json({ error: "Envía mode e input con valores de texto." }, 400);
  return c.json(
    await execute(
      c.env,
      JSON.parse(version.definition),
      body.input,
      body.mode,
      version.id,
      scope,
    ),
  );
});
app.get("/api/openapi.json", async (c) =>
  c.json(await openApi(c.env, scopeOf(c.req.raw))),
);

const appFetch = app.fetch.bind(app);
app.fetch = async (request, environment, executionContext) => {
  if (!environment) return appFetch(request, environment, executionContext);
  const control = await handleBackupControl(request, environment);
  if (control) return control;
  const capability = backupCapability(request, environment);
  if (capability) return capability;
  return appFetch(
    request,
    guardStorageEnvironment(environment),
    executionContext,
  );
};

app.onError((error, c) => {
  if (error instanceof SecretReplacementRequiredError)
    return c.json({ error: error.message }, 400);
  if (databaseConflict(error))
    return c.json({ error: "The data changed. Reload and retry." }, 409);
  if (databaseInputFailure(error))
    return c.json(
      { error: "The database cannot store this Unicode value." },
      422,
    );
  if (error instanceof HTTPException) return error.getResponse();
  console.error(error);
  return c.json({ error: "Internal server error" }, 500);
});
app.notFound((c) => c.json({ error: "No encontrado." }, 404));
export default app;

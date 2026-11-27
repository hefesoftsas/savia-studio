import { dialectFor } from "@savia/db/dialect";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { CollectionGatewayContext } from "../studio/collection-gateway";
import { createCrmRepository } from "./repository";
import { hubspotObjects, hubspotObject } from "./hubspot-workspace-catalog";
import { objectSchema } from "@savia/studio-shared/metadata";
import { csvHeaders } from "@savia/studio-shared/csv";
import { hasRecordFilters } from "@savia/studio-shared/record-filter-input";
import {
  buildRecordsCsv,
  parseCsvExportColumns,
  recordsCsvFilename,
} from "@savia/studio-shared/records-csv-export";
import { canAccessSharedCrm, canManageSharedCrm } from "./hubspot-access";
import { audit, getObject } from "@savia/studio-server/services";
import type { ActiveCrmConnection } from "./contracts";
import {
  workspacePageLimit,
  workspaceRecordPagination,
} from "./workspace-pagination";

type Binding = {
  kind: "crm";
  accessScope?: "tenant";
  provider: "hubspot";
  resource: string;
  principalId: string;
  connectionId: string;
  accountId: string;
  propertyTypes?: Record<string, string>;
  capabilities: ReturnType<typeof capabilities>;
};
type HubspotCatalogObject = (typeof hubspotObjects)[number];
type HubspotCursor = string | number;
type HubspotRecordPage = {
  results?: Array<{
    id: string | number;
    properties?: Record<string, unknown>;
    createdAt?: string;
    updatedAt?: string;
  }>;
  paging?: { next?: { after?: unknown } | null } | null;
  total?: unknown;
};

type HubspotPageCheckpoint = {
  scope: string;
  page: number;
  after: HubspotCursor;
  cursors: Set<string>;
  recordIds: Set<string>;
  providerTotal: number | undefined;
};

const maxPageCheckpoints = 64;
// Charge per character and per set entry to bound retained pagination history.
const maxCheckpointWeight = 1_000_000;
const pageCheckpoints = new Map<
  string,
  {
    state: HubspotPageCheckpoint;
    expiresAt: number;
    weight: number;
  }
>();
let checkpointWeight = 0;

function takePageCheckpoint(
  token: string | undefined,
  scope: string,
  page: number,
) {
  if (!token) return;
  const entry = pageCheckpoints.get(token);
  if (!entry || entry.state.scope !== scope || entry.state.page !== page)
    return;
  pageCheckpoints.delete(token);
  checkpointWeight -= entry.weight;
  if (entry.expiresAt <= Date.now()) return;
  return {
    state: entry.state,
    restore() {
      if (
        entry.expiresAt <= Date.now() ||
        pageCheckpoints.size >= maxPageCheckpoints ||
        checkpointWeight + entry.weight > maxCheckpointWeight
      )
        return;
      pageCheckpoints.set(token, entry);
      checkpointWeight += entry.weight;
    },
  };
}

function savePageCheckpoint(state: HubspotPageCheckpoint) {
  let weight = state.scope.length;
  for (const entries of [state.cursors, state.recordIds])
    for (const value of entries) weight += value.length + 32;
  if (weight > maxCheckpointWeight) return;

  const now = Date.now();
  for (const [token, entry] of pageCheckpoints) {
    if (
      entry.expiresAt > now &&
      pageCheckpoints.size < maxPageCheckpoints &&
      checkpointWeight + weight <= maxCheckpointWeight
    )
      break;
    pageCheckpoints.delete(token);
    checkpointWeight -= entry.weight;
  }
  const token = crypto.randomUUID();
  pageCheckpoints.set(token, { state, expiresAt: now + 60_000, weight });
  checkpointWeight += weight;
  return token;
}

function fail(
  message: string,
  status: 403 | 404 | 405 | 409 | 422 | 502 | 503 = 422,
): never {
  throw new HTTPException(status, { message });
}

function isHubspotRecordId(id: unknown): id is HubspotCursor {
  return (
    (typeof id === "string" && id.length > 0) ||
    (typeof id === "number" && Number.isSafeInteger(id))
  );
}

function readRecordPage(
  result: HubspotRecordPage | null,
  cursors: Set<string>,
  recordIds?: Set<string>,
) {
  if (
    !Array.isArray(result?.results) ||
    result.results.some((record) => !isHubspotRecordId(record?.id))
  )
    fail("HubSpot devolvió una página de registros inválida.", 502);

  const { total, paging } = result;
  if (
    total !== undefined &&
    (typeof total !== "number" ||
      !Number.isSafeInteger(total) ||
      total < result.results.length)
  )
    fail("HubSpot devolvió un total de registros inválido.", 502);

  if (paging != null && (typeof paging !== "object" || Array.isArray(paging)))
    fail("HubSpot devolvió información de paginación inválida.", 502);

  let after: HubspotCursor | undefined;
  if (paging?.next != null) {
    const cursor = paging.next.after;
    if (!(
      (typeof cursor === "string" && cursor.length > 0) ||
      (typeof cursor === "number" &&
        Number.isSafeInteger(cursor) &&
        cursor >= 0)
    ))
      fail("HubSpot devolvió un cursor de paginación inválido.", 502);
    const key = String(cursor);
    if (cursors.has(key))
      fail("La paginación de HubSpot contiene un cursor repetido.", 502);
    cursors.add(key);
    after = cursor;
  }
  if (recordIds) {
    for (const record of result.results) {
      const id = String(record.id);
      if (recordIds.has(id))
        fail(
          "HubSpot devolvió registros repetidos durante la paginación.",
          502,
        );
      recordIds.add(id);
    }
  }
  return { records: result.results, after, total };
}

function verifyScannedTotal(total: number | undefined, scanned: number) {
  if (total !== undefined && total < scanned)
    fail("El total de HubSpot es menor que los registros leídos.", 502);
}

function verifySummarizedTotal(total: number | undefined, scanned: number) {
  if (total !== undefined && total !== scanned)
    fail("El total de HubSpot no coincide con los registros del resumen.", 502);
}

function assertSupportedRecordQuery(params: Record<string, string>) {
  if (params.sort) fail("Este origen no admite ordenación de registros.");
  if (
    hasRecordFilters(params.filters) ||
    params.searchField ||
    params.stage ||
    params.emptyStage === "true" ||
    params.trash === "true"
  ) {
    fail("Este origen no admite esos filtros.");
  }
}

export function capabilities(scopes: string[], resource: string) {
  const scope = ["tasks", "notes", "meetings", "calls"].includes(resource)
    ? "contacts"
    : resource;
  const write =
    scopes.includes(`crm.objects.${scope}.write`) ||
    (scope === "tickets" && scopes.includes("tickets"));
  return {
    list: true,
    read: true,
    create: write,
    update: write,
    delete: write,
    schema: false,
    customFields: false,
    search: true,
    filter: false,
    sort: false,
  };
}
export async function crmWorkspaceBinding(
  db: D1Database,
  tenant: string,
  name: string,
): Promise<Binding | undefined> {
  const row = await db
    .prepare(
      "SELECT config FROM crm_collection_bindings WHERE tenant_id=? AND object_name=?",
    )
    .bind(tenant, name)
    .first<{ config: string }>();
  const config = row ? JSON.parse(row.config) : undefined;
  return config?.kind === "crm" ? config : undefined;
}
export async function handlesHubspotWorkspace(
  context: CollectionGatewayContext,
  path: string,
) {
  if (/^\/api\/crm-workspace(?:\/install)?$/.test(path)) return true;
  const match =
    /^\/api\/(?:objects|records|record-detail|record-activity|record-notes|record-links|files|import|export|views)\/([^/]+)/.exec(
      path,
    );
  // Presentation/schema editing remains under the bound collection contract guard.
  return Boolean(
    match &&
    !["objects", "views"].includes(path.split("/")[2]) &&
    (await crmWorkspaceBinding(
      context.db,
      context.tenant,
      decodeURIComponent(match[1]),
    )),
  );
}
export function createHubspotWorkspaceApp(context: CollectionGatewayContext) {
  const { db, tenant, actor, crm } = context;
  const tenantId = Number(tenant.replace(/^(?:agency|tenant):/, ""));
  const app = new Hono();
  app.onError((e, c) => {
    if (c.req.raw.signal?.aborted) return new Response(null, { status: 499 });
    if (!(e instanceof HTTPException))
      return c.json(
        { error: "No se pudo completar la operación en HubSpot." },
        502,
      );
    if (e.res) return e.res;
    return c.json({ error: e.message }, e.status);
  });
  app.use("*", async (c, next) => {
    if (!canAccessSharedCrm(actor, tenant))
      fail("No tienes acceso a este tenant.", 403);
    if (c.req.method !== "GET" && !canManageSharedCrm(actor, tenant))
      fail("Esta operación requiere administrar el tenant.", 403);
    await next();
  });
  async function connection(binding?: Binding) {
    if (
      binding &&
      binding.accessScope !== "tenant" &&
      binding.principalId !== actor.principal.id
    )
      fail("Esta colección pertenece a otra conexión de HubSpot.", 403);
    const owner = binding?.principalId ?? actor.principal.id;
    const current = await createCrmRepository(db).findActiveConnection(
      tenantId,
      "hubspot",
      owner,
    );
    if (
      !current ||
      current.status !== "connected" ||
      !current.externalAccountId
    ) {
      const message = "La conexión de HubSpot del tenant debe reconectarse.";
      throw new HTTPException(409, {
        message,
        res: Response.json(
          { error: { code: "HUBSPOT_CONNECTION_UNAVAILABLE", message } },
          { status: 409 },
        ),
      });
    }
    if (
      binding &&
      (binding.connectionId !== current.id ||
        binding.accountId !== current.externalAccountId ||
        !hubspotObject(binding.resource))
    )
      fail(
        "La conexión de esta colección ha cambiado. Un administrador debe revisarla.",
        403,
      );
    if (!crm) fail("HubSpot no está disponible.", 503);
    return current;
  }
  async function remote(
    conn: ActiveCrmConnection,
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT" = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const response = await crm!.nango.proxy({
      connection: conn,
      path,
      method: method as any,
      ...(body === undefined ? {} : { body }),
      ...(signal ? { signal } : {}),
    });
    signal?.throwIfAborted();
    await audit(
      db,
      tenant,
      method === "GET" ||
        (method === "POST" &&
          /\/(?:search|batch\/read)$/.test(path.split("?")[0]))
        ? "hubspot.read"
        : "hubspot.write",
      "hubspot",
      null,
      {
        principalId: actor.principal.id,
        connectionId: conn.id,
        method,
        // Keep search terms, payloads, credentials, and provider records out of audit logs.
        resource: path.split("?")[0].split("/").slice(0, 5).join("/"),
        status: response.status,
      },
    ).run();
    if (response.status === 429) {
      const message =
        "HubSpot alcanzó el límite de solicitudes. Inténtalo más tarde.";
      const retryAfter = response.headers.get("Retry-After");
      throw new HTTPException(429, {
        message,
        res: Response.json(
          { error: message },
          {
            status: 429,
            headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
          },
        ),
      });
    }
    if (!response.ok)
      fail(
        response.status === 403
          ? "HubSpot no autoriza esta operación. Revisa los permisos de la conexión."
          : response.status === 404
            ? "Registro no encontrado en HubSpot."
            : "HubSpot no pudo completar la solicitud.",
        response.status === 403
          ? 403
          : response.status === 404
            ? 404
            : response.status === 400
              ? 422
              : 502,
      );
    return response.status === 204 ? {} : ((await response.json()) as any);
  }
  function fetchRecordPage(
    conn: ActiveCrmConnection,
    resource: string,
    {
      limit,
      properties,
      query,
      after,
      signal,
    }: {
      limit: number;
      properties: string[];
      query?: string;
      after?: HubspotCursor;
      signal?: AbortSignal;
    },
  ) {
    const path = `/crm/v3/objects/${resource}`;
    if (query)
      return remote(
        conn,
        `${path}/search`,
        "POST",
        { query, limit, properties, ...(after === undefined ? {} : { after }) },
        signal,
      );
    const params = new URLSearchParams({
      limit: String(limit),
      properties: properties.join(","),
    });
    if (after !== undefined) params.set("after", String(after));
    return remote(conn, `${path}?${params}`, "GET", undefined, signal);
  }
  async function searchUnfilteredTotal(
    conn: ActiveCrmConnection,
    resource: string,
    signal?: AbortSignal,
  ) {
    try {
      const result = await remote(
        conn,
        `/crm/v3/objects/${resource}/search`,
        "POST",
        { limit: 1, properties: ["hs_object_id"] },
        signal,
      );
      return readRecordPage(result, new Set()).total;
    } catch (error) {
      // Some HubSpot objects or grants support listing without search.
      if (
        !(error instanceof HTTPException) ||
        ![403, 404, 422].includes(error.status)
      )
        throw error;
      return undefined;
    }
  }
  async function installedResources(
    conn: ActiveCrmConnection,
    selected: ReadonlyArray<HubspotCatalogObject>,
  ) {
    const names = new Set(selected.map((item) => `hubspot_${item.resource}`));
    if (!names.size) return new Set<string>();
    const { results } = await db
      .prepare(
        "SELECT o.name,b.config FROM studio_objects o JOIN crm_collection_bindings b ON b.tenant_id=o.tenant_id AND b.object_name=o.name WHERE o.tenant_id=? AND b.source_id='hubspot'",
      )
      .bind(tenant)
      .all<{ name: string; config: string }>();
    return new Set(
      results
        .filter((row) => names.has(row.name))
        .filter((row) => {
          const binding = JSON.parse(row.config) as Binding;
          return (
            binding.kind === "crm" &&
            binding.provider === "hubspot" &&
            binding.resource === row.name.slice("hubspot_".length) &&
            binding.principalId === actor.principal.id &&
            binding.connectionId === conn.id &&
            binding.accountId === conn.externalAccountId
          );
        })
        .map((row) => row.name),
    );
  }
  async function ownerOptions(conn: ActiveCrmConnection) {
    try {
      const owners: any[] = [];
      const cursors = new Set<string>();
      let after: HubspotCursor | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await remote(
          conn,
          `/crm/v3/owners?${new URLSearchParams({ limit: "100", ...(after === undefined ? {} : { after: String(after) }) })}`,
        );
        const nextPage = readRecordPage(result, cursors);
        owners.push(...nextPage.records);
        after = nextPage.after;
        if (after === undefined || owners.length >= 200) break;
      }
      if (after !== undefined || owners.length > 200) return null;
      return owners.map((owner) => ({
        value: String(owner.id),
        label:
          [owner.firstName, owner.lastName].filter(Boolean).join(" ") ||
          owner.email ||
          String(owner.id),
      }));
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof HTTPException &&
          [403, 404, 502].includes(error.status))
      )
        return null;
      throw error;
    }
  }
  async function discover(
    conn: ActiveCrmConnection,
    selected: ReadonlyArray<HubspotCatalogObject> = hubspotObjects,
  ) {
    const installed = await installedResources(conn, selected);
    return Promise.all(
      selected.map(async (item) => {
        const base = {
          resource: item.resource,
          name: `hubspot_${item.resource}`,
          label: item.label,
          capabilities: capabilities(conn.scopes, item.resource),
        };
        const isInstalled = installed.has(`hubspot_${item.resource}`);
        try {
          await remote(conn, `/crm/v3/objects/${item.resource}?limit=1`);
          return { ...base, available: true, installed: isInstalled };
        } catch (e) {
          if (e instanceof HTTPException && [403, 404].includes(e.status))
            return {
              ...base,
              available: false,
              installed: isInstalled,
              reason: "La conexión no tiene acceso a este objeto.",
            };
          throw e;
        }
      }),
    );
  }
  app.get("/api/crm-workspace", async (c) => {
    const conn = await createCrmRepository(db).findActiveConnection(
      tenantId,
      "hubspot",
      actor.principal.id,
    );
    if (!conn || conn.status !== "connected")
      return c.json({
        data: { provider: "hubspot", connected: false, objects: [] },
      });
    await connection();
    return c.json({
      data: {
        provider: "hubspot",
        connected: true,
        accountLabel: conn.externalAccountLabel,
        objects: await discover(conn),
      },
    });
  });
  app.post("/api/crm-workspace/install", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail("La lista de recursos de HubSpot no es válida.");
    const keys = Object.keys(body);
    let selected: ReadonlyArray<HubspotCatalogObject>;
    const explicit = Object.hasOwn(body, "resources");
    if (!explicit && keys.length === 0) {
      selected = hubspotObjects;
    } else {
      if (
        keys.length !== 1 ||
        !explicit ||
        !Array.isArray((body as any).resources) ||
        (body as any).resources.length === 0 ||
        !(body as any).resources.every(
          (resource: unknown) => typeof resource === "string",
        )
      )
        fail("Indica una lista no vacía de recursos de HubSpot.");
      const resources = (body as any).resources as string[];
      if (new Set(resources).size !== resources.length)
        fail("La lista de recursos contiene duplicados.");
      const catalog = new Map<string, HubspotCatalogObject>(
        hubspotObjects.map((item) => [item.resource, item]),
      );
      selected = resources.map((resource) => {
        const item = catalog.get(resource);
        if (!item)
          fail(`El recurso de HubSpot no está disponible: ${resource}.`);
        return item;
      });
    }
    const conn = await connection(),
      discovered = await discover(conn, selected),
      installed = [];
    if (explicit) {
      const unavailable = discovered.find((item) => !item.available);
      if (unavailable)
        fail(
          `El recurso ${unavailable.resource} no está disponible para esta conexión de HubSpot.`,
          422,
        );
    }
    const statements: D1PreparedStatement[] = [];
    let owners: Awaited<ReturnType<typeof ownerOptions>> | undefined;
    for (const item of discovered.filter((x) => x.available)) {
      const existing = await db
        .prepare("SELECT name FROM studio_objects WHERE tenant_id=? AND name=?")
        .bind(tenant, item.name)
        .first();
      if (existing) {
        const binding = await crmWorkspaceBinding(db, tenant, item.name);
        if (!binding)
          fail("El nombre de una colección CRM ya está en uso.", 409);
        if (
          binding.principalId !== actor.principal.id ||
          binding.accountId !== conn.externalAccountId
        )
          fail("Esta colección pertenece a otra cuenta de HubSpot.", 403);
      }
      const catalog = hubspotObject(item.resource)!;
      const properties = await remote(
        conn,
        `/crm/v3/properties/${item.resource}`,
      );
      const fields: Record<string, any> = {};
      const required: Record<string, string[]> = {
        companies: ["name"],
        deals: ["dealname", "dealstage"],
        tickets: ["subject", "hs_pipeline_stage"],
        tasks: ["hs_task_subject", "hs_timestamp"],
        notes: ["hs_note_body", "hs_timestamp"],
        products: ["name"],
        line_items: ["name"],
        quotes: ["hs_title"],
      };
      for (const [key, label] of Object.entries({
        ...catalog.fields,
        hubspot_owner_id: "Responsable",
      })) {
        const property = properties.results?.find((p: any) => p.name === key);
        if (!property) continue;
        const options = (property.options ?? [])
          .filter((o: any) => !o.hidden && o.value)
          .map((o: any) => ({
            value: String(o.value),
            label: String(o.label).slice(0, 200),
          }))
          .slice(0, 200);
        fields[key] = {
          label,
          ...(property.type === "datetime"
            ? { config: { dateTime: true } }
            : {}),
          ...(required[item.resource]?.includes(key) ? { required: true } : {}),
          type: options.length
            ? "Dropdown"
            : property.type === "number"
              ? "Number"
              : property.type === "datetime"
                ? "Textbox"
                : property.type === "date"
                  ? "DateControl"
                  : key.includes("body") ||
                      key.includes("description") ||
                      key === "content"
                    ? "Textarea"
                    : "Textbox",
          readOnly: Boolean(
            property.modificationMetadata?.readOnlyValue || property.calculated,
          ),
          ...(options.length ? { options } : {}),
        };
      }
      if (
        fields.hubspot_owner_id &&
        conn.scopes.includes("crm.objects.owners.read")
      ) {
        if (owners === undefined) owners = await ownerOptions(conn);
        if (owners)
          fields.hubspot_owner_id = {
            ...fields.hubspot_owner_id,
            type: "Dropdown",
            options: owners,
          };
      }
      if (["deals", "tickets"].includes(item.resource)) {
        const pipelines = await remote(
          conn,
          `/crm/v3/pipelines/${item.resource}`,
        );
        const pipelineKey =
            item.resource === "deals" ? "pipeline" : "hs_pipeline",
          stageKey =
            item.resource === "deals" ? "dealstage" : "hs_pipeline_stage";
        if (fields[pipelineKey])
          fields[pipelineKey] = {
            ...fields[pipelineKey],
            type: "Dropdown",
            options: (pipelines.results ?? [])
              .map((p: any) => ({ value: p.id, label: p.label }))
              .slice(0, 200),
          };
        if (fields[stageKey])
          fields[stageKey] = {
            ...fields[stageKey],
            type: "Dropdown",
            options: (pipelines.results ?? [])
              .flatMap((p: any) =>
                (p.stages ?? []).map((s: any) => ({
                  value: s.id,
                  label: s.label,
                })),
              )
              .slice(0, 200),
            config: {
              optionsWhen: {
                field: pipelineKey,
                cases: Object.fromEntries(
                  (pipelines.results ?? []).map((p: any) => [
                    p.id,
                    (p.stages ?? []).map((s: any) => s.id),
                  ]),
                ),
              },
            },
          };
      }
      const binding: Binding = {
        kind: "crm",
        accessScope: "tenant",
        provider: "hubspot",
        resource: item.resource,
        principalId: actor.principal.id,
        connectionId: conn.id,
        accountId: conn.externalAccountId!,
        propertyTypes: Object.fromEntries(
          (properties.results ?? [])
            .filter((p: any) => fields[p.name])
            .map((p: any) => [p.name, p.type]),
        ),
        capabilities: item.capabilities,
      };
      const definition = objectSchema.parse({
        name: item.name,
        label: item.label,
        description: "Registros conectados a HubSpot",
        config: {
          version: 2,
          fields,
          fieldOrder: Object.keys(fields),
          studio: {
            collection: {
              kind: "crm",
              sourceId: "hubspot",
              resource: item.resource,
              capabilities: item.capabilities,
            },
            capabilities: item.capabilities,
          },
        },
      });
      if (existing) {
        const old = await getObject(db, tenant, item.name);
        for (const [key, field] of Object.entries(definition.config.fields)) {
          const previous = old.config.fields[key];
          if (previous) {
            const previousConfig = { ...previous.config };
            if (previousConfig.placeholder === "2026-09-11T14:30:00-05:00")
              delete previousConfig.placeholder;
            definition.config.fields[key] = {
              ...field,
              label: [
                (catalog.fields as Record<string, string>)[key],
                `${(catalog.fields as Record<string, string>)[key]} (fecha y hora ISO)`,
              ].includes(previous.label)
                ? field.label
                : previous.label,

              ...(previous.hidden !== undefined
                ? { hidden: previous.hidden }
                : {}),
              config: { ...previousConfig, ...field.config },
            };
          }
        }
        const next = {
          ...old,
          version: (old.version ?? 1) + 1,
          config: {
            ...old.config,
            fields: definition.config.fields,
            fieldOrder: [
              ...(
                old.config.fieldOrder ?? Object.keys(old.config.fields)
              ).filter((k) => definition.config.fields[k]),
              ...Object.keys(definition.config.fields).filter(
                (k) =>
                  !(
                    old.config.fieldOrder ?? Object.keys(old.config.fields)
                  ).includes(k),
              ),
            ],
            studio: {
              ...old.config.studio,
              collection: definition.config.studio?.collection,
              capabilities: item.capabilities,
            },
          },
        };
        statements.push(
          db
            .prepare(
              "UPDATE studio_objects SET config=?,version=? WHERE tenant_id=? AND name=? AND version=?",
            )
            .bind(
              JSON.stringify(next.config),
              next.version,
              tenant,
              item.name,
              old.version,
            ),
          db
            .prepare(
              "UPDATE crm_collection_bindings SET config=? WHERE tenant_id=? AND object_name=?",
            )
            .bind(JSON.stringify(binding), tenant, item.name),
          db
            .prepare(
              "INSERT INTO studio_schema_versions(tenant_id,object_name,version,definition) VALUES(?,?,?,?)",
            )
            .bind(tenant, item.name, next.version, JSON.stringify(next)),
        );
        installed.push({ ...item, label: old.label });
        continue;
      }
      statements.push(
        db
          .prepare(
            "INSERT INTO studio_objects(tenant_id,name,label,description,config,version) VALUES(?,?,?,?,?,1)",
          )
          .bind(
            tenant,
            item.name,
            item.label,
            definition.description,
            JSON.stringify(definition.config),
          ),
        db
          .prepare(
            "INSERT INTO crm_collection_bindings(tenant_id,object_name,source_id,resource,config) VALUES(?,?,'hubspot',?,?)",
          )
          .bind(tenant, item.name, item.resource, JSON.stringify(binding)),
        db
          .prepare(
            "INSERT INTO studio_schema_versions(tenant_id,object_name,version,definition) VALUES(?,?,1,?)",
          )
          .bind(
            tenant,
            item.name,
            JSON.stringify({ ...definition, version: 1 }),
          ),
      );
      installed.push(item);
    }
    if ((await connection()).id !== conn.id)
      fail("La conexión cambió. Reintenta la instalación.", 409);
    if (statements.length) await db.batch(statements);
    return c.json({
      data: {
        provider: "hubspot",
        connected: true,
        objects: installed,
        unavailable: discovered.filter((x) => !x.available),
      },
    });
  });
  app.get("/api/records/:name/summary", async (c) => {
    const signal = c.req.raw.signal;
    const name = decodeURIComponent(c.req.param("name"));
    const binding = await crmWorkspaceBinding(db, tenant, name);
    if (!binding) fail("Colección no encontrada.", 404);
    const conn = await connection(binding);
    const object = await getObject(db, tenant, name);
    const group = c.req.query("group");
    const amount = c.req.query("amountField");
    const query = c.req.query("q");
    if (
      binding.provider !== "hubspot" ||
      object.config.studio?.collection?.sourceId !== "hubspot"
    )
      fail("La colección no está vinculada a HubSpot.", 404);
    if (!binding.capabilities.list)
      fail("La conexión no anuncia esta operación.", 405);
    assertSupportedRecordQuery(c.req.query());
    if (group && !Object.hasOwn(object.config.fields, group))
      fail("El campo de agrupación no es válido.");
    if (amount && !Object.hasOwn(object.config.fields, amount))
      fail("El campo de importe no es válido.");
    if (amount && binding.propertyTypes?.[amount] !== "number")
      fail("El campo de importe debe ser numérico.");

    const properties = [
      ...new Set(
        [group, amount].filter((field): field is string => Boolean(field)),
      ),
    ];
    if (properties.length === 0) properties.push("hs_object_id");
    const groups = new Map<
      string,
      { value: string | number | null; count: number; amount?: number }
    >();
    const cursors = new Set<string>();
    const recordIds = new Set<string>();
    const pageSize = 100;
    const maxPages = 10;
    const maxRecords = pageSize * maxPages;
    let after: HubspotCursor | undefined;
    let total = 0;
    let reportedTotal: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const result = await fetchRecordPage(conn, binding.resource, {
        limit: pageSize,
        properties,
        query,
        after,
        signal,
      });
      const {
        records,
        after: next,
        total: providerTotal,
      } = readRecordPage(result, cursors, recordIds);
      reportedTotal = providerTotal ?? reportedTotal;
      total += records.length;
      verifyScannedTotal(reportedTotal, total);
      if (!query && next === undefined)
        verifySummarizedTotal(reportedTotal, total);
      if (
        !group &&
        !amount &&
        reportedTotal !== undefined &&
        (next === undefined || reportedTotal > total)
      )
        return c.json({ data: [], total: reportedTotal });
      if (
        total > maxRecords ||
        (reportedTotal !== undefined && reportedTotal > maxRecords) ||
        (next !== undefined && page === maxPages - 1)
      ) {
        if (!group && !amount && !query && next !== undefined) {
          const searchTotal = await searchUnfilteredTotal(
            conn,
            binding.resource,
            signal,
          );
          // Search can lag behind the listing. The next cursor proves that
          // a count at or below the already scanned rows is incomplete.
          if (searchTotal !== undefined && searchTotal > total)
            return c.json({ data: [], total: searchTotal });
        }
        fail(
          `El resumen supera el máximo de ${maxRecords} registros admitido.`,
          422,
        );
      }
      for (const record of records) {
        const rawValue = group ? record.properties?.[group] : null;
        const value =
          rawValue == null
            ? null
            : typeof rawValue === "number"
              ? rawValue
              : String(rawValue);
        const key = JSON.stringify(value);
        const entry = groups.get(key) ?? {
          value,
          count: 0,
          ...(amount ? { amount: 0 } : {}),
        };
        entry.count++;
        // Keep counting records after an invalid amount makes the sum unknown.
        if (amount && entry.amount !== undefined) {
          const rawAmount = record.properties?.[amount];
          if (
            rawAmount !== null &&
            rawAmount !== undefined &&
            rawAmount !== ""
          ) {
            const numeric =
              typeof rawAmount === "number" ||
              (typeof rawAmount === "string" && rawAmount.trim())
                ? Number(rawAmount)
                : NaN;
            const sum = entry.amount + numeric;
            entry.amount = Number.isFinite(sum) ? sum : undefined;
          }
        }
        groups.set(key, entry);
      }
      after = next;
      if (after === undefined) break;
    }
    verifySummarizedTotal(reportedTotal, total);
    const data =
      group || amount
        ? [...groups.values()].sort((a, b) =>
            String(a.value ?? "").localeCompare(String(b.value ?? "")),
          )
        : [];
    return c.json({ data, total });
  });
  app.all("/api/*", async (c) => {
    const match = /^\/api\/([^/]+)\/([^/]+)(?:\/([^/]+))?(?:\/(.*))?$/.exec(
      new URL(c.req.url).pathname,
    );
    if (!match) fail("Ruta no disponible.", 404);
    const [, surface, rawName, rawId, extra] = match,
      name = decodeURIComponent(rawName),
      id = rawId ? decodeURIComponent(rawId) : undefined;
    const binding = await crmWorkspaceBinding(db, tenant, name);
    if (!binding) fail("Colección no encontrada.", 404);
    const conn = await connection(binding),
      object = await getObject(db, tenant, name),
      resource = binding.resource;
    if (id && !/^\d+$/.test(id)) fail("Identificador CRM inválido.");
    if (extra && surface !== "record-links")
      fail("Operación no disponible.", 405);
    if (surface === "record-links") {
      if (!id) fail("Identificador requerido.");
      if (extra) {
        if (!["POST", "DELETE"].includes(c.req.method))
          fail("Operación no disponible.", 405);
        const prefix = `hubspot:${name}:`,
          relation = decodeURIComponent(extra);
        if (!relation.startsWith(prefix)) fail("Relación inválida.");
        const targetName = relation.slice(prefix.length),
          target = await crmWorkspaceBinding(db, tenant, targetName);
        if (!target) fail("Colección no encontrada.", 404);
        await connection(target);
        if (
          !capabilities(conn.scopes, resource).update ||
          !capabilities(conn.scopes, target.resource).update
        )
          fail("La conexión no permite editar esta relación.", 403);
        const body = await c.req.json().catch(() => null);
        if (typeof body?.targetId !== "string" || !/^\d+$/.test(body.targetId))
          fail("Identificador inválido.");
        const labels = await remote(
          conn,
          `/crm/v4/associations/${resource}/${target.resource}/labels`,
        );
        if (
          !labels.results?.some(
            (label: any) =>
              label.label === null && label.category === "HUBSPOT_DEFINED",
          )
        )
          fail("Esta relación no admite asociaciones predeterminadas.", 405);
        await remote(conn, `/crm/v3/objects/${resource}/${id}`);
        await remote(
          conn,
          `/crm/v3/objects/${target.resource}/${body.targetId}`,
        );
        await remote(
          conn,
          `/crm/v4/objects/${resource}/${id}/associations/${c.req.method === "POST" ? "default/" : ""}${target.resource}/${body.targetId}`,
          c.req.method === "POST" ? "PUT" : "DELETE",
          c.req.method === "POST" ? {} : undefined,
        );
        return c.json({ data: { sourceId: id, targetId: body.targetId } });
      }
      if (c.req.method !== "GET") fail("Operación no disponible.", 405);
      await remote(conn, `/crm/v3/objects/${resource}/${id}`);
      const rows = await db
        .prepare(
          "SELECT object_name,config FROM crm_collection_bindings WHERE tenant_id=? AND " +
            dialectFor(db).jsonValue("config", "$.kind") +
            "='crm'",
        )
        .bind(tenant)
        .all<{ object_name: string; config: string }>();
      const page = Number(c.req.query("page") ?? 1),
        perPage = Number(c.req.query("perPage") ?? 20);
      const includeRecords = c.req.query("includeRecords") !== "false";
      const includeRecordData = c.req.query("includeRecords") === "true";
      const relationId = c.req.query("relationId");
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(perPage) ||
        perPage < 1 ||
        perPage > 100
      )
        fail("Paginación inválida.");
      const groups: any[] = [];
      await Promise.all(
        rows.results.map(async (row) => {
          const target = JSON.parse(row.config) as Binding;
          const currentRelationId = `hubspot:${name}:${row.object_name}`;
          if (relationId && relationId !== currentRelationId) return;
          if (
            (target.accessScope !== "tenant" &&
              target.principalId !== actor.principal.id) ||
            target.connectionId !== conn.id ||
            target.accountId !== conn.externalAccountId
          )
            return;
          await connection(target);
          const associationPath = `/crm/v3/objects/${resource}/${id}/associations/${target.resource}`;
          let associations: HubspotRecordPage;
          let defaultAssociation = false;
          try {
            const labels = await remote(
              conn,
              `/crm/v4/associations/${resource}/${target.resource}/labels`,
            );
            if (!labels.results?.length) return;
            defaultAssociation = labels.results.some(
              (label: any) =>
                label.label === null && label.category === "HUBSPOT_DEFINED",
            );
            associations = await remote(conn, `${associationPath}?limit=100`);
          } catch (e) {
            if (
              e instanceof HTTPException &&
              [403, 404, 422].includes(e.status)
            )
              return;
            throw e;
          }
          const targetCatalog = hubspotObject(target.resource)!;
          const relatedIds = new Set<string>();
          const cursors = new Set<string>();
          let scanned = 0;
          while (true) {
            const { records, after } = readRecordPage(associations, cursors);
            scanned += records.length;
            if (scanned > 5000 || (after !== undefined && scanned === 5000))
              fail(
                "Esta relación supera el límite de consulta. Ábrela en HubSpot.",
                422,
              );
            for (const record of records) relatedIds.add(String(record.id));
            if (after === undefined) break;
            associations = await remote(
              conn,
              `${associationPath}?${new URLSearchParams({ limit: "100", after: String(after) })}`,
            );
          }
          const pageIds = includeRecords
            ? [...relatedIds].slice((page - 1) * perPage, page * perPage)
            : [];
          const batch = pageIds.length
            ? await remote(
                conn,
                `/crm/v3/objects/${target.resource}/batch/read`,
                "POST",
                {
                  properties: Object.keys(targetCatalog.fields),
                  inputs: pageIds.map((id: string) => ({ id })),
                },
              )
            : { results: [] };
          const selectedIds = new Set(pageIds);
          const associatedRecords = readRecordPage(batch, new Set()).records;
          const recordsById = new Map<
            string,
            (typeof associatedRecords)[number]
          >();
          for (const record of associatedRecords) {
            const recordId = String(record.id);
            if (!selectedIds.has(recordId) || recordsById.has(recordId))
              fail(
                "HubSpot devolvió un registro ajeno a la página de relaciones.",
                502,
              );
            recordsById.set(recordId, record);
          }
          const records = pageIds.map((id) => {
            const record = recordsById.get(id);
            if (!record)
              fail(
                "HubSpot devolvió una página incompleta de registros relacionados.",
                502,
              );
            return {
              id,
              label: record.properties?.[targetCatalog.title] || id,
              ...(includeRecordData
                ? {
                    data: {
                      id,
                      ...Object.fromEntries(
                        Object.keys(targetCatalog.fields).map((key) => [
                          key,
                          record.properties?.[key] ?? null,
                        ]),
                      ),
                      created_at: record.createdAt,
                      updated_at: record.updatedAt,
                    },
                  }
                : {}),
            };
          });
          const targetObject = await getObject(db, tenant, row.object_name);
          groups.push({
            definition: {
              id: `hubspot:${name}:${row.object_name}`,
              sourceObject: name,
              targetObject: row.object_name,
              sourceLabel: targetObject.label,
              targetLabel: object.label,
              cardinality: "many-to-many",
              storage: "native",
            },
            direction: "outgoing",
            targetObject: row.object_name,
            targetLabel: targetObject.label,
            label: targetObject.label,
            records,
            targetColumns: Object.entries(targetCatalog.fields).map(
              ([key, label]) => ({ key, label }),
            ),
            total: relatedIds.size,
            canEdit:
              defaultAssociation &&
              capabilities(conn.scopes, resource).update &&
              capabilities(conn.scopes, target.resource).update,
            readOnlyReason: "Asociación nativa de HubSpot.",
            hasNextPage: page * perPage < relatedIds.size,
          });
        }),
      );
      return c.json({ data: groups });
    }
    if (surface === "record-activity" && c.req.method === "GET")
      return c.json({ data: [], total: 0, page: 1 });
    if (!["records", "record-detail", "export"].includes(surface))
      fail("Operación no disponible para HubSpot.", 405);
    const method = c.req.method,
      operation =
        method === "GET"
          ? id
            ? "read"
            : "list"
          : method === "POST" && !id
            ? "create"
            : method === "PATCH" && id
              ? "update"
              : method === "DELETE" && id
                ? "delete"
                : undefined;
    if (surface === "export" && (method !== "GET" || id))
      fail("Operación no disponible para HubSpot.", 405);
    if (
      !operation ||
      !capabilities(conn.scopes, resource)[operation] ||
      !binding.capabilities[operation]
    )
      fail("La conexión no anuncia esta operación.", 405);
    const project = (r: any) => ({
      _crmLinks: [
        {
          provider: "hubspot",
          label: "Abrir en HubSpot",
          url: `https://app.hubspot.com/contacts/${binding.accountId}/record/${hubspotObject(resource)!.typeId}/${r.id}`,
        },
      ],
      id: r.id,
      ...Object.fromEntries(
        Object.keys(object.config.fields).map((k) => [
          k,
          r.properties?.[k] ?? null,
        ]),
      ),
      created_at: r.createdAt,
      updated_at: r.updatedAt,
    });
    if (surface === "export") {
      const signal = c.req.raw.signal;
      const params = c.req.query();
      assertSupportedRecordQuery(params);
      let custom: ReturnType<typeof parseCsvExportColumns>;
      try {
        custom = parseCsvExportColumns(params, object);
      } catch {
        fail("Las columnas o los encabezados del CSV no son válidos.");
      }
      if (
        custom?.columns.some((key) => !Object.hasOwn(object.config.fields, key))
      )
        fail("El CSV contiene una columna no declarada.");
      const columns = custom?.columns ?? csvHeaders(object);
      const headers = custom?.headers ?? columns;
      const properties = columns.filter((key) =>
        Object.hasOwn(object.config.fields, key),
      );
      if (properties.length === 0) properties.push("hs_object_id");
      const cursors = new Set<string>();
      const recordIds = new Set<string>();
      const rows: ReturnType<typeof project>[] = [];
      const pageSize = 100;
      const maxPages = 10;
      let after: HubspotCursor | undefined;
      let reportedTotal: number | undefined;
      for (let page = 0; page < maxPages; page++) {
        const result = await fetchRecordPage(conn, resource, {
          limit: pageSize,
          properties,
          query: params.q,
          after,
          signal,
        });
        signal.throwIfAborted();
        const next = readRecordPage(result, cursors, recordIds);
        reportedTotal = next.total ?? reportedTotal;
        rows.push(...next.records.map(project));
        verifyScannedTotal(reportedTotal, rows.length);
        after = next.after;
        if (
          rows.length > pageSize * maxPages ||
          (reportedTotal !== undefined &&
            reportedTotal > pageSize * maxPages) ||
          (after !== undefined && page === maxPages - 1)
        )
          fail(
            "El CSV admite hasta 1.000 registros de HubSpot. Reduce la búsqueda.",
          );
        if (after === undefined) break;
      }
      if (reportedTotal !== undefined && reportedTotal !== rows.length)
        fail(
          "El total de HubSpot no coincide con los registros de la exportación.",
          502,
        );
      return c.body(buildRecordsCsv(columns, headers, rows), 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${recordsCsvFilename(name)}"`,
      });
    }
    const properties = Object.keys(object.config.fields);
    if (operation === "list") {
      const signal = c.req.raw.signal;
      const page = Number(c.req.query("page") ?? 1),
        limit = Number(c.req.query("perPage") ?? 25),
        q = c.req.query("q");
      const maxPage = workspacePageLimit("hubspot", limit);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > maxPage ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        fail("Paginación inválida (máximo 100 páginas).");
      assertSupportedRecordQuery(c.req.query());
      const scope = JSON.stringify([
        tenant,
        actor.principal.id,
        conn.id,
        conn.nangoConnectionId,
        conn.nangoIntegrationId,
        binding.accountId,
        name,
        resource,
        q,
        limit,
        properties,
      ]);
      const checkpoint = takePageCheckpoint(c.req.query("cursor"), scope, page);
      const state = checkpoint?.state;
      const cursors = state?.cursors ?? new Set<string>();
      const recordIds = state?.recordIds ?? new Set<string>();
      let after = state?.after;
      let records: ReturnType<typeof readRecordPage>["records"] = [];
      let providerTotal = state?.providerTotal;
      for (let current = state ? page : 1; current <= page; current++) {
        let result: HubspotRecordPage | null;
        try {
          result = await fetchRecordPage(conn, resource, {
            limit,
            properties,
            query: q,
            after,
            signal,
          });
          signal?.throwIfAborted();
        } catch (error) {
          // The checkpoint is still intact until readRecordPage updates its sets.
          if (
            signal?.aborted ||
            !(error instanceof HTTPException) ||
            error.status === 429 ||
            error.status >= 500
          )
            checkpoint?.restore();
          throw error;
        }
        const nextPage = readRecordPage(result, cursors, recordIds);
        records = nextPage.records;
        providerTotal = nextPage.total ?? providerTotal;
        verifyScannedTotal(providerTotal, recordIds.size);
        after = nextPage.after;
        if (current < page && after === undefined) {
          records = [];
          break;
        }
      }
      const visited = recordIds.size;
      let total = providerTotal;
      if (after === undefined) {
        total ??= visited;
        if (!q && total !== visited) total = undefined;
      } else if (total === visited) {
        total = undefined;
      }
      const pagination = workspaceRecordPagination(
        page,
        maxPage,
        after !== undefined,
      );
      const nextCursor =
        pagination.pageInfo.hasNextPage && after !== undefined
          ? savePageCheckpoint({
              scope,
              page: page + 1,
              after,
              cursors,
              recordIds,
              providerTotal,
            })
          : undefined;
      return c.json({
        data: records.map(project),
        page,
        perPage: limit,
        ...(total !== undefined ? { total } : {}),
        ...pagination,
        meta: { ...pagination.meta, recordOffset: visited - records.length },
        ...(nextCursor ? { nextCursor } : {}),
      });
    }
    if (operation === "read") {
      const result = await remote(
        conn,
        `/crm/v3/objects/${resource}/${id}?${new URLSearchParams({ properties: properties.join(",") })}`,
      );
      if (!isHubspotRecordId(result?.id) || String(result.id) !== id)
        fail("HubSpot devolvió un registro distinto o inválido.", 502);
      const record = project(result);
      return c.json({
        data:
          surface === "record-detail"
            ? { record, relations: [], page: 1, perPage: 25 }
            : record,
      });
    }
    let values: Record<string, string> = {};
    if (operation !== "delete") {
      const input = await c.req.json().catch(() => null);
      if (!input || typeof input !== "object" || Array.isArray(input))
        fail("Registro inválido.");
      for (const [key, value] of Object.entries(input)) {
        if (
          ["_version", "id", "created_at", "updated_at", "_crmLinks"].includes(
            key,
          )
        )
          continue;
        const field = object.config.fields[key];
        if (!field || field.readOnly)
          fail("El registro contiene un campo no editable.");
        if (
          value !== null &&
          !["string", "number", "boolean"].includes(typeof value)
        )
          fail("Valor de campo inválido.");
        if (
          field.options?.length &&
          value !== null &&
          value !== "" &&
          !field.options.some((o) => o.value === String(value))
        )
          fail(`Valor inválido para ${field.label}.`);
        values[key] = value === null ? "" : String(value);
        if (values[key] && binding.propertyTypes?.[key] === "datetime") {
          if (
            !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
              values[key],
            ) ||
            !Number.isFinite(Date.parse(values[key]))
          )
            fail(`${field.label}: usa fecha, hora y zona horaria ISO.`);
          values[key] = new Date(values[key]).toISOString();
        }
        if (values[key] && binding.propertyTypes?.[key] === "date") {
          const day = values[key].slice(0, 10);
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
            !Number.isFinite(Date.parse(day)) ||
            new Date(day).toISOString().slice(0, 10) !== day
          )
            fail(`${field.label}: fecha inválida.`);
          values[key] = String(Date.parse(`${day}T00:00:00.000Z`));
        }
      }
      if (operation === "create")
        for (const [key, field] of Object.entries(object.config.fields))
          if (field.required && !field.readOnly && !values[key]?.trim())
            fail(`${field.label}: obligatorio.`);
      if (!Object.keys(values).length) fail("No hay campos para guardar.");
    }
    const result = await remote(
      conn,
      `/crm/v3/objects/${resource}${id ? `/${id}` : ""}`,
      method as any,
      operation === "delete" ? undefined : { properties: values },
    );
    return c.json(
      {
        data: operation === "delete" ? { id, deleted: true } : project(result),
      },
      operation === "create" ? 201 : 200,
    );
  });
  return app;
}

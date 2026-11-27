import {
  acquireTenantDeletionLease,
  prepareTenantDeletionLease,
  TenantDeletionLeaseLostError,
  tenantPurgePlan,
  deleteTenantFiles,
  tenantCompanionKeys,
} from "./tenant-purge";
import { resolveTenantSlug, tenantSlugExists } from "../tenant-slugs";
import {
  TenantSlugConflictError,
  tenantSlugCandidate,
  tenantSlugChangeStatements,
} from "../tenant-slug-assignment";
import { guard, transaction } from "@savia/studio-server/services";
import { dialectFor } from "@savia/db/dialect";
import { tableNames, foreignKeys } from "../lib/database-schema";
import {
  deactivateTenantForDeletion,
  deleteTenantBrandingAssets,
} from "../tenant-branding/service";
import {
  createRoute,
  type OpenAPIHono,
  type RouteHandler,
  z,
} from "@hono/zod-openapi";
import {
  normalizeTenantSlug,
  parseTenantSlugFromHostname,
} from "@savia/tenant-host/tenant-host";
import {
  actorFromContext,
  requirePlatformAdministrator,
} from "../auth/middleware";
import { tenantSlugFromApiRequest } from "../auth/tenant-host-guard";
import type { IdentityUserAdministrator } from "../auth/better-auth";
import {
  hasIdentityAccessChangeInTenant,
  withIdentityAccessChange,
} from "../auth/identity-access-change";
import {
  deletePrincipal,
  findPrincipal,
  grantMembership,
  listGlobalRoles,
  upsertPrincipal,
} from "../auth/identity-repository";
import {
  assertPrincipalCanLoseActiveMembership,
  assignOrTransferMembership,
  TenantMembershipInvariantError,
} from "../auth/tenant-membership-invariants";
import {
  isForeignKeyConstraint,
  isUniqueConstraint,
} from "../lib/database-errors";
import type { Context } from "hono";
import type { RealtimeHubClient } from "../realtime/hub-client";
import { publishRealtime } from "../realtime/hub-client";
import { PLATFORM_ROOM } from "../realtime/protocol";
import type { SaviaRequestService } from "./savia-request";

/** Discover restrictive references from the schema before any external cleanup. */
async function hasRestrictingTenantReference(db: D1Database, tenantId: number) {
  type ForeignKey = {
    id: number;
    table: string;
    from: string;
    to: string | null;
    on_delete: string;
  };
  const identifier = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
  const tables =
    dialectFor(db).name === "postgres"
      ? await tableNames(db)
      : (
          await db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%tenants%'",
            )
            .all<{ name: string }>()
        ).results.map((row) => row.name);
  const names = tables.filter((name) => identifier.test(name));
  if (!names.length) return false;
  const keys = await Promise.all(
    names.map(async (name) => ({ results: await foreignKeys(db, name) })),
  );
  const probes: string[] = [];
  keys.forEach((result, index) => {
    const groups = new Map<number, ForeignKey[]>();
    for (const key of result.results) {
      if (
        key.table !== "tenants" ||
        !["NO ACTION", "RESTRICT"].includes(key.on_delete)
      )
        continue;
      const group = groups.get(key.id) ?? [];
      group.push(key);
      groups.set(key.id, group);
    }
    for (const group of groups.values()) {
      if (
        group.some(
          (key) =>
            !identifier.test(key.from) || !identifier.test(key.to ?? "id"),
        )
      )
        throw new Error("Unsupported tenant foreign key identifier");
      probes.push(
        `SELECT 1 FROM "${names[index]}" child JOIN tenants parent ON ${group.map((key) => `child."${key.from}"=parent."${key.to ?? "id"}"`).join(" AND ")} WHERE parent.id=?`,
      );
    }
  });
  return (
    probes.length > 0 &&
    Boolean(
      await db
        .prepare(probes.join(" UNION ALL ") + " LIMIT 1")
        .bind(...probes.map(() => tenantId))
        .first(),
    )
  );
}

const tenantSchema = z.object({
  id: z.number(),
  idSlug: z.string(),
  name: z.string(),
  kind: z.enum(["commercial", "platform"]),
  isActive: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  agencyId: z.number().nullable(),
});
const tenantRole = z.enum([
  "tenant_admin",
  "agency_admin",
  "operator",
  "viewer",
]);
const newTenantUserSchema = z
  .object({
    email: z.string().email(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
    role: tenantRole,
    temporaryPassword: z.string().min(12).max(128).optional(),
    emailVerified: z.boolean().optional(),
  })
  .strict();
const existingTenantMemberSchema = z
  .object({
    principalId: z.string().min(1).max(100),
    role: tenantRole,
  })
  .strict();
const tenantInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    idSlug: z
      .string()
      .trim()
      .refine((val) => normalizeTenantSlug(val) !== null, {
        message:
          "Tenant slug must be 1-63 lowercase alphanumeric characters/hyphens and not a reserved name",
      })
      .transform((val) => normalizeTenantSlug(val)!)
      .optional(),
    isActive: z.boolean().optional(),
    initialUser: newTenantUserSchema.optional(),
    existingMember: existingTenantMemberSchema.optional(),
  })
  .strict();
const inputSchema = tenantInputSchema.refine(
  (val) =>
    Number(Boolean(val.initialUser)) + Number(Boolean(val.existingMember)) ===
    1,
  {
    message:
      "Provide either initialUser for a new account or existingMember to transfer a user, not both.",
  },
);
const params = z.object({ tenantId: z.coerce.number().int().nonnegative() });
const response = {
  description: "Tenant",
  content: { "application/json": { schema: z.object({ data: tenantSchema }) } },
};
const errorSchema = z.object({ code: z.string(), message: z.string() });
const transferConflictReason = z.enum(["PLATFORM_ADMIN", "LAST_ACTIVE_MEMBER"]);
const errorResponse = {
  description: "Rejected",
  content: {
    "application/json": {
      schema: z.object({
        error: errorSchema,
      }),
    },
  },
};
const errors = {
  400: errorResponse,
  403: errorResponse,
  404: errorResponse,
  409: errorResponse,
};
const tags = ["Tenants"];
const listRoute = createRoute({
  method: "get",
  path: "/v1/tenants",
  tags,
  summary: "List accessible tenants",
  responses: {
    200: {
      description: "Tenants",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(tenantSchema),
            meta: z.object({ total: z.number() }),
          }),
        },
      },
    },
    ...errors,
  },
});
const currentTenantRoute = createRoute({
  method: "get",
  path: "/v1/tenants/current",
  tags,
  summary: "Get current tenant context from host",
  responses: {
    200: {
      description: "Current workspace tenant info",
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({
              isDedicated: z.boolean(),
              slug: z.string().nullable(),
              name: z.string(),
              kind: z.enum(["commercial", "platform"]),
              id: z.number().nullable(),
            }),
          }),
        },
      },
    },
    ...errors,
  },
});
const getRoute = createRoute({
  method: "get",
  path: "/v1/tenants/{tenantId}",
  tags,
  request: { params },
  responses: { 200: response, ...errors },
});
const createDefinition = createRoute({
  method: "post",
  path: "/v1/tenants",
  tags,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: inputSchema } },
    },
  },
  responses: {
    201: response,
    ...errors,
    409: {
      ...errorResponse,
      content: {
        "application/json": {
          schema: z.object({
            error: errorSchema.extend({
              reason: transferConflictReason.optional(),
            }),
          }),
        },
      },
    },
    503: errorResponse,
  },
});
const updateDefinition = createRoute({
  method: "patch",
  path: "/v1/tenants/{tenantId}",
  tags,
  request: {
    params,
    body: {
      required: true,
      content: { "application/json": { schema: tenantInputSchema.partial() } },
    },
  },
  responses: { 200: response, ...errors },
});
const deleteDefinition = createRoute({
  method: "delete",
  path: "/v1/tenants/{tenantId}",
  tags,
  request: {
    params,
    query: z.object({
      cascade: z.enum(["true", "false"]).optional(),
      confirmation: z.string().optional(),
    }),
  },
  responses: { 204: { description: "Deleted" }, ...errors, 503: errorResponse },
});
type TenantRow = Omit<z.infer<typeof tenantSchema>, "isActive"> & {
  isActive: number;
};
const tenantColumns =
  't.id,t.id_slug AS "idSlug",t.name,t.kind,t.is_active AS "isActive",t.created_at AS "createdAt",t.updated_at AS "updatedAt",NULL AS "agencyId"';
const select = `SELECT ${tenantColumns} FROM tenants t`;
const document = (row: TenantRow) => ({
  ...row,
  isActive: Boolean(row.isActive),
});
const missing = {
  error: { code: "TENANT_NOT_FOUND", message: "El tenant no existe." },
};
const conflict = {
  error: {
    code: "TENANT_CONFLICT",
    message: "El identificador ya existe o el tenant tiene datos asociados.",
  },
};
const purgeInProgress = {
  error: {
    code: "TENANT_PURGE_IN_PROGRESS",
    message:
      "El borrado de datos ya empezó. El tenant queda inactivo. Reintenta la eliminación con el nombre confirmado.",
  },
};
const requestPurgeCount = z.number().int().nonnegative();
const requestPurgeReceipt = z.object({
  tenant: z.string(),
  purged: z.object({
    variables: requestPurgeCount,
    versions: requestPurgeCount,
    runs: requestPurgeCount,
    folders: requestPurgeCount,
    bundles: requestPurgeCount,
    flows: requestPurgeCount,
  }),
});

async function purgeSaviaRequestTenant(
  service: SaviaRequestService,
  scope: string,
): Promise<void> {
  const response = await service.fetch(
    new Request(`https://savia-request.internal/api/admin/tenants/${scope}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json().catch(() => null);
  const receipt = requestPurgeReceipt.safeParse(body);
  if (!receipt.success || receipt.data.tenant !== scope)
    throw new Error("Savia Request did not confirm deletion for this tenant.");
}

const deletionInProgress = {
  error: {
    code: purgeInProgress.error.code,
    message:
      "Ya hay un cambio en curso para este tenant. Espera a que termine antes de reintentar.",
  },
};
const userMissing = {
  error: { code: "USER_NOT_FOUND", message: "El usuario no existe." },
};
function memberConflict(
  reason: z.infer<typeof transferConflictReason>,
  message: string,
) {
  return { error: { code: "TENANT_CONFLICT", reason, message } };
}

const leaseActive =
  "EXISTS(SELECT 1 FROM tenant_deletion_leases WHERE tenant_id=? AND lease_token=? AND lease_until>?)";

/** Create a tenant under a lease that covers setup of its first administrator. */
async function insertTenant(
  db: D1Database,
  input: { name: string; idSlug?: string; isActive?: boolean },
  now: string,
) {
  const allocation = await db
    .prepare(
      `INSERT INTO server_id_sequences(resource,next_id) SELECT 'tenants',COALESCE(MAX(id),0)+2 FROM tenants WHERE true ON CONFLICT(resource) DO UPDATE SET next_id=${dialectFor(db).name === "postgres" ? "GREATEST" : "MAX"}(${dialectFor(db).name === "postgres" ? "server_id_sequences.next_id" : "next_id"}+1,(SELECT COALESCE(MAX(id),0)+2 FROM tenants)) RETURNING next_id-1 AS id`,
    )
    .first<{ id: number }>();
  if (!allocation) throw new Error("Unable to allocate tenant ID");
  for (let attempt = 0; attempt < 1000; attempt++) {
    const slug = input.idSlug ?? tenantSlugCandidate(input.name, attempt);
    if (await tenantSlugExists(db, slug)) {
      if (input.idSlug)
        throw new TenantSlugConflictError("Tenant URL is already reserved");
      continue;
    }
    try {
      const { claim, lease } = prepareTenantDeletionLease(
        db,
        allocation.id,
        now,
      );
      await db.batch([
        db
          .prepare(
            "INSERT INTO tenants(id,id_slug,name,is_active,created_at,updated_at,kind) VALUES(?,?,?,?,?,?, 'commercial')",
          )
          .bind(
            allocation.id,
            slug,
            input.name,
            input.isActive === false ? 0 : 1,
            now,
            now,
          ),
        db
          .prepare(
            "INSERT INTO tenant_slug_aliases(slug,tenant_id) VALUES(?,?)",
          )
          .bind(slug, allocation.id),
        claim,
      ]);
      return { id: allocation.id, lease };
    } catch (error) {
      // The unique registry claim also handles simultaneous creations of the same name.
      if (input.idSlug || !isUniqueConstraint(error)) throw error;
    }
  }
  throw new TenantSlugConflictError("No available tenant URL");
}

type TenantProvisioning = Awaited<ReturnType<typeof insertTenant>>;

async function rollbackTenantCreation(
  db: D1Database,
  { id, lease }: TenantProvisioning,
) {
  await db
    .prepare(`DELETE FROM tenants WHERE id=? AND ${leaseActive}`)
    .bind(id, id, lease.token, Date.now())
    .run();
}

/**
 * Create a commercial tenant around an existing user. Membership is unique
 * per principal, so this transfers the user out of their current tenant
 * instead of sharing them. Platform administrators cannot be transferred:
 * revoke their global role first through user management.
 */
async function createTenantWithExistingMember(
  c: Context,
  db: D1Database,
  input: {
    name: string;
    idSlug?: string;
    isActive?: boolean;
    existingMember: { principalId: string; role: z.infer<typeof tenantRole> };
  },
  realtime?: RealtimeHubClient,
  userAdministrator?: IdentityUserAdministrator,
) {
  const principal = await findPrincipal(db, input.existingMember.principalId);
  if (!principal || !principal.isActive) return c.json(userMissing, 404);
  return withIdentityAccessChange(db, principal.id, async (accessChange) => {
    if ((await listGlobalRoles(db, principal.id)).includes("platform_admin"))
      return c.json(
        memberConflict(
          "PLATFORM_ADMIN",
          "El usuario es administrador de plataforma. Revoca ese rol antes de transferirlo a un tenant.",
        ),
        409,
      );
    await accessChange.assertSourceAvailable();
    const now = new Date().toISOString();
    let provisioning: TenantProvisioning | undefined;
    const previousMembership = await db
      .prepare(
        "SELECT tenant_id FROM identity_tenant_membership WHERE principal_id=? AND is_active=1",
      )
      .bind(principal.id)
      .first<{ tenant_id: number }>();
    let emailScopeChanged = false;
    try {
      if (previousMembership)
        await assertPrincipalCanLoseActiveMembership(db, principal.id);
      provisioning = await insertTenant(db, input, now);
      const { id: tenantId, lease } = provisioning;
      if (userAdministrator && principal.issuer === userAdministrator.issuer) {
        await lease.renew();
        await accessChange.renew();
        await userAdministrator.updateUser(
          principal.subject,
          { tenantId },
          c.req.raw,
        );
        emailScopeChanged = true;
      }
      await lease.renew();
      await accessChange.renew();
      await assignOrTransferMembership(
        db,
        principal.id,
        tenantId,
        input.existingMember.role,
        { allowInactiveTenant: input.isActive === false },
      );
    } catch (error) {
      try {
        if (emailScopeChanged) {
          await accessChange.renew();
          await userAdministrator!.updateUser(
            principal.subject,
            { tenantId: previousMembership?.tenant_id ?? null },
            c.req.raw,
          );
        }
      } finally {
        if (provisioning) await rollbackTenantCreation(db, provisioning);
      }
      if (
        error instanceof TenantMembershipInvariantError &&
        error.code === "LAST_ACTIVE_MEMBER"
      )
        return c.json(
          memberConflict(
            "LAST_ACTIVE_MEMBER",
            "El usuario es el último miembro activo de su organización. Agrega otro miembro allí antes de transferirlo.",
          ),
          409,
        );
      if (isUniqueConstraint(error) || error instanceof TenantSlugConflictError)
        return c.json(conflict, 409);
      if (error instanceof TenantDeletionLeaseLostError)
        return c.json(deletionInProgress, 409);
      throw error;
    } finally {
      await provisioning?.lease.release();
    }
    const tenantId = provisioning!.id;
    const row = await db
      .prepare(`${select} WHERE t.id=?`)
      .bind(tenantId)
      .first<TenantRow>();
    notifyTenantRoom(realtime, c, "tenants", "created", tenantId);
    notifyTenantRoom(realtime, c, "users", "updated", principal.id);
    return c.json({ data: document(row!) }, 201);
  });
}

/**
 * Best-effort realtime hint after tenant mutations. The socket carries no
 * record data; subscribers refetch through the API.
 */
function notifyTenantRoom(
  realtime: RealtimeHubClient | undefined,
  context: Context,
  topic: "users" | "tenants",
  type: "created" | "updated" | "deleted",
  id: string | number,
): void {
  publishRealtime(realtime, PLATFORM_ROOM, {
    topic,
    type,
    id,
    actor: actorFromContext(context).principal.id,
  });
}

export function registerTenantRoutes(
  app: OpenAPIHono,
  db: D1Database,
  userAdministrator?: IdentityUserAdministrator,
  realtime?: RealtimeHubClient,
  documents?: R2Bucket,
  saviaRequestService?: SaviaRequestService,
  deleteTenantSettings?: (
    tenantId: number,
    renewLease: () => Promise<void>,
  ) => Promise<void>,
  setTenantSSOActivity?: (tenantId: number, active: boolean) => Promise<void>,
) {
  app.openapi(listRoute, async (c) => {
    const actor = actorFromContext(c);
    const platform = actor.globalRoles.includes("platform_admin");
    const ids = actor.memberships
      .filter((m) => m.isActive)
      .map((m) => m.tenantId ?? m.agencyId);
    const rows = await db
      .prepare(
        `${select}${platform ? "" : ` WHERE t.kind='commercial' AND t.is_active=1 AND t.id IN (${ids.map(() => "?").join(",") || "NULL"})`} ORDER BY CASE t.kind WHEN 'platform' THEN 0 ELSE 1 END,t.name,t.id`,
      )
      .bind(...(platform ? [] : ids))
      .all<TenantRow>();
    c.header("cache-control", "no-store");
    return c.json(
      {
        data: rows.results.map(document),
        meta: { total: rows.results.length },
      },
      200,
    );
  });
  app.openapi(currentTenantRoute, async (c) => {
    const slug = tenantSlugFromApiRequest(c.req.raw);
    if (!slug) {
      return c.json(
        {
          data: {
            isDedicated: false,
            slug: null,
            name: "Savia",
            kind: "platform" as const,
            id: null,
          },
        },
        200,
      );
    }
    const row = await resolveTenantSlug(db, slug);
    if (!row) return c.json(missing, 404);
    return c.json(
      {
        data: {
          isDedicated: true,
          slug: row.idSlug,
          name: row.name,
          kind: row.kind as "commercial",
          id: row.id,
        },
      },
      200,
    );
  });
  app.openapi(getRoute, async (c) => {
    const id = c.req.valid("param").tenantId,
      actor = actorFromContext(c);
    const platform = actor.globalRoles.includes("platform_admin");
    if (
      !platform &&
      !actor.memberships.some(
        (m) => m.isActive && (m.tenantId ?? m.agencyId) === id,
      )
    )
      return c.json(
        {
          error: {
            code: "AUTHORIZATION_FORBIDDEN",
            message: "No tienes acceso a este tenant.",
          },
        },
        403,
      );
    const row = await db
      .prepare(
        `${select} WHERE t.id=?${platform ? "" : " AND t.kind='commercial' AND t.is_active=1"}`,
      )
      .bind(id)
      .first<TenantRow>();
    if (!row) return c.json(missing, 404);
    return c.json({ data: document(row) }, 200);
  });
  const createTenant: RouteHandler<typeof createDefinition> = async (c) => {
    requirePlatformAdministrator(actorFromContext(c));
    const input = c.req.valid("json");
    if (input.existingMember) {
      return createTenantWithExistingMember(
        c,
        db,
        input as {
          name: string;
          idSlug?: string;
          isActive?: boolean;
          existingMember: {
            principalId: string;
            role: z.infer<typeof tenantRole>;
          };
        },
        realtime,
        userAdministrator,
      );
    }
    if (!userAdministrator) {
      return c.json(
        {
          error: {
            code: "AUTHENTICATION_UNAVAILABLE",
            message: "User administration is not configured",
          },
        },
        503,
      );
    }
    const now = new Date().toISOString();
    let authenticatedUser: { subject: string } | undefined;
    let principalId: string | undefined;
    let provisioning: TenantProvisioning | undefined;
    try {
      provisioning = await insertTenant(db, input, now);
      const { id: tenantId, lease } = provisioning;
      await lease.renew();
      authenticatedUser = await userAdministrator.createUser(
        { ...input.initialUser!, platformAdmin: false, tenantId },
        c.req.raw,
      );
      const principal = await upsertPrincipal(db, {
        issuer: userAdministrator.issuer,
        subject: authenticatedUser.subject,
        email: input.initialUser!.email,
        displayName: `${input.initialUser!.firstName} ${input.initialUser!.lastName}`,
      });
      principalId = principal.id;
      await lease.renew();
      await grantMembership(
        db,
        principal.id,
        tenantId,
        input.initialUser!.role,
        { allowInactiveTenant: input.isActive === false },
      );
      if (!input.initialUser!.temporaryPassword) {
        await lease.renew();
        await userAdministrator.sendPasswordReset(
          authenticatedUser.subject,
          c.req.raw,
        );
      }
    } catch (error) {
      try {
        if (principalId) await deletePrincipal(db, principalId);
        if (provisioning) await rollbackTenantCreation(db, provisioning);
      } finally {
        if (authenticatedUser) {
          await userAdministrator.deleteUser(
            authenticatedUser.subject,
            c.req.raw,
          );
        }
      }
      if (isUniqueConstraint(error) || error instanceof TenantSlugConflictError)
        return c.json(conflict, 409);
      if (error instanceof TenantDeletionLeaseLostError)
        return c.json(deletionInProgress, 409);
      throw error;
    } finally {
      await provisioning?.lease.release();
    }
    const tenantId = provisioning!.id;
    const row = await db
      .prepare(`${select} WHERE t.id=?`)
      .bind(tenantId)
      .first<TenantRow>();
    notifyTenantRoom(realtime, c, "tenants", "created", tenantId);
    if (principalId)
      notifyTenantRoom(realtime, c, "users", "created", principalId);
    return c.json({ data: document(row!) }, 201);
  };
  app.openapi(createDefinition, createTenant, (result, c) => {
    if (result.success) return;
    const passwordInvalid = result.error.issues.some(
      ({ path }) => path.join(".") === "initialUser.temporaryPassword",
    );
    return c.json(
      {
        error: passwordInvalid
          ? {
              code: "TENANT_TEMPORARY_PASSWORD_INVALID",
              message:
                "The temporary password must contain 12 to 128 characters.",
            }
          : { code: "VALIDATION_ERROR", message: "Invalid request" },
      },
      400,
    );
  });
  app.openapi(updateDefinition, async (c) => {
    requirePlatformAdministrator(actorFromContext(c));
    const id = c.req.valid("param").tenantId,
      input = c.req.valid("json");
    // Changing activity and deleting both update tenant settings in Auth.
    const setsActivity = input.isActive !== undefined;
    const lease = setsActivity
      ? await acquireTenantDeletionLease(db, id)
      : null;
    try {
      const current = await db
        .prepare(
          `SELECT ${tenantColumns},t.purge_token AS "purgeToken" FROM tenants t WHERE t.id=? AND t.kind='commercial'`,
        )
        .bind(id)
        .first<TenantRow & { purgeToken: string | null }>();
      if (!current) return c.json(missing, 404);
      if (current.purgeToken) return c.json(purgeInProgress, 409);
      if (setsActivity && !lease) return c.json(deletionInProgress, 409);
      const activityChanged =
        setsActivity && Boolean(current.isActive) !== input.isActive;
      const slugStatements = await tenantSlugChangeStatements(
        db,
        id,
        current.idSlug,
        input.idSlug ?? current.idSlug,
      );
      if (activityChanged && input.isActive === false && setTenantSSOActivity) {
        await lease?.renew();
        await setTenantSSOActivity(id, false);
      }
      await lease?.renew();
      await db.batch([
        ...slugStatements,
        db
          .prepare(
            "UPDATE tenants SET name=COALESCE(?,name),id_slug=COALESCE(?,id_slug),is_active=COALESCE(?,is_active),updated_at=? WHERE id=? AND kind='commercial'",
          )
          .bind(
            input.name ?? null,
            input.idSlug ?? null,
            input.isActive === undefined ? null : Number(input.isActive),
            new Date().toISOString(),
            id,
          ),
      ]);
      if (activityChanged && input.isActive === true && setTenantSSOActivity) {
        await lease?.renew();
        try {
          await setTenantSSOActivity(id, true);
        } catch (error) {
          // Keep the tenant inactive so a subsequent PATCH can retry the bridge.
          await lease?.renew();
          await db
            .prepare(
              "UPDATE tenants SET is_active=0,updated_at=? WHERE id=? AND kind='commercial'",
            )
            .bind(new Date().toISOString(), id)
            .run();
          throw error;
        }
        await lease?.renew();
      }
      const row = await db
        .prepare(`${select} WHERE t.id=? AND t.kind='commercial'`)
        .bind(id)
        .first<TenantRow>();
      notifyTenantRoom(realtime, c, "tenants", "updated", id);
      return c.json({ data: document(row!) }, 200);
    } catch (error) {
      if (error instanceof TenantDeletionLeaseLostError)
        return c.json(deletionInProgress, 409);
      if (String(error).includes(purgeInProgress.error.code))
        return c.json(purgeInProgress, 409);
      if (isUniqueConstraint(error) || error instanceof TenantSlugConflictError)
        return c.json(conflict, 409);
      throw error;
    } finally {
      await lease?.release();
    }
  });
  app.openapi(deleteDefinition, async (c) => {
    requirePlatformAdministrator(actorFromContext(c));
    const id = c.req.valid("param").tenantId;
    // Memberships and tenant records must not be orphaned by tenant removal.
    const commercial = await db
      .prepare(
        "SELECT name,purge_token,created_at FROM tenants WHERE id=? AND kind='commercial'",
      )
      .bind(id)
      .first<{
        name: string;
        purge_token: string | null;
        created_at: string;
      }>();
    if (!commercial) return c.json(missing, 404);
    const query = c.req.valid("query");
    const cascade = query.cascade === "true";
    if (!cascade && commercial.purge_token) return c.json(purgeInProgress, 409);
    if (cascade && query.confirmation !== commercial.name)
      return c.json(
        {
          error: {
            code: "TENANT_CONFIRMATION_REQUIRED",
            message:
              "Escribe el nombre exacto del tenant para eliminarlo con todos sus datos.",
          },
        },
        400,
      );
    const lease = await acquireTenantDeletionLease(
      db,
      id,
      commercial.created_at,
    );
    if (!lease) return c.json(deletionInProgress, 409);
    const leaseArgs = () => [id, lease.token, Date.now()];
    try {
      if (cascade) {
        if (!documents || !saviaRequestService)
          return c.json(
            {
              error: {
                code: "TENANT_CLEANUP_UNAVAILABLE",
                message:
                  "El almacenamiento o Savia Request no está disponible para eliminar toda la data del tenant.",
              },
            },
            503,
          );
        if (await hasIdentityAccessChangeInTenant(db, id))
          return c.json(deletionInProgress, 409);
        const confirmationChanged = {
          error: {
            code: "TENANT_CONFIRMATION_REQUIRED",
            message:
              "El tenant cambió durante la eliminación. Recarga y confirma con su nombre actual.",
          },
        };
        // Disable access before inventory so new tenant requests cannot add data.
        if (
          !(await deactivateTenantForDeletion(db, id, {
            confirmedName: commercial.name,
          }))
        )
          return c.json(confirmationChanged, 409);
        // Keep branding in the inventory so a failed preflight cannot erase it.
        const companionKeys = await tenantCompanionKeys(documents, id);
        const plan = await tenantPurgePlan(db, id, companionKeys);
        const confirmedTenantQuery =
          "SELECT 1 FROM tenants WHERE id=? AND kind='commercial' AND name=? AND is_active=0";
        const confirmedTenantArgs = [id, commercial.name];
        // The first external cleanup can remove data even if its reply is lost.
        await lease.renew();
        const purgeToken = await db
          .prepare(
            `UPDATE tenants SET purge_token=COALESCE(purge_token,?)
           WHERE id=? AND kind='commercial' AND name=? AND is_active=0 AND ${leaseActive}
           RETURNING purge_token`,
          )
          .bind(crypto.randomUUID(), ...confirmedTenantArgs, ...leaseArgs())
          .first<string>("purge_token");
        if (!purgeToken) return c.json(confirmationChanged, 409);
        await lease.renew();
        try {
          await purgeSaviaRequestTenant(saviaRequestService, `tenant:${id}`);
        } catch {
          return c.json(
            {
              error: {
                code: "TENANT_REQUEST_CLEANUP_UNAVAILABLE",
                message:
                  "No se pudo eliminar la data de Savia Request. El tenant queda inactivo; reintenta la eliminación.",
              },
            },
            503,
          );
        }
        if (deleteTenantSettings) {
          try {
            await deleteTenantSettings(id, lease.renew);
          } catch (error) {
            if (error instanceof TenantDeletionLeaseLostError) throw error;
            return c.json(
              {
                error: {
                  code: "TENANT_AUTH_CLEANUP_UNAVAILABLE",
                  message:
                    "No se pudo eliminar la configuración de autenticación. El tenant queda inactivo; reintenta la eliminación.",
                },
              },
              503,
            );
          }
        }
        await deleteTenantFiles(documents, plan.keys, lease.renew);
        await lease.renew();
        const unchanged = guard(
          db,
          `SELECT EXISTS(${confirmedTenantQuery} AND purge_token=? AND ${leaseActive})`,
          [...confirmedTenantArgs, purgeToken, ...leaseArgs()],
        );
        try {
          await transaction(db, [
            unchanged.start,
            ...plan.statements,
            unchanged.end,
          ]);
        } catch (error) {
          // The final batch may have committed even if its reply did not arrive.
          const remaining = await db
            .prepare("SELECT purge_token FROM tenants WHERE id=?")
            .bind(id)
            .first<{ purge_token: string | null }>()
            .catch(() => undefined);
          if (remaining && remaining.purge_token !== purgeToken)
            return c.json(confirmationChanged, 409);
          if (remaining !== null) throw error;
        }
        notifyTenantRoom(realtime, c, "tenants", "deleted", id);
        return c.body(null, 204);
      }
      if (await hasRestrictingTenantReference(db, id))
        return c.json(conflict, 409);
      const linkedQuery =
        "SELECT 1 FROM identity_tenant_membership WHERE tenant_id=? UNION ALL SELECT 1 FROM studio_objects WHERE tenant_id=? LIMIT 1";
      const linkedArgs = [id, `tenant:${id}`];
      const linked = db.prepare(linkedQuery).bind(...linkedArgs);
      if (await linked.first()) return c.json(conflict, 409);
      const tables =
        dialectFor(db).name === "postgres"
          ? await tableNames(db, "tenant_id")
          : (
              await db
                .prepare(
                  "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'crm_%' OR name LIKE 'studio_%') AND sql LIKE '%tenant_id%'",
                )
                .all<{ name: string }>()
            ).results.map((row) => row.name);
      const names = tables.filter((name) =>
        /^(crm|studio)_[a-z_]+$/.test(name),
      );
      if (names.length) {
        const remaining = await db.batch(
          names.map((name) =>
            db
              .prepare(
                `SELECT 1 FROM "${name}" WHERE tenant_id=? OR tenant_id LIKE ? LIMIT 1`,
              )
              .bind(`tenant:${id}`, `tenant:${id}:%`),
          ),
        );
        if (remaining.some((result) => result.results.length > 0))
          return c.json(conflict, 409);
      }
      // Stop new tenant activity and reject blocked deletions before removing credentials.
      await lease.renew();
      const wasActive = await db
        .prepare("SELECT is_active FROM tenants WHERE id=?")
        .bind(id)
        .first<number>("is_active");
      await deactivateTenantForDeletion(db, id, {
        assetStorageAvailable: Boolean(documents),
      });
      // An in-flight assignment may have committed before deactivation.
      if (await linked.first()) {
        if (wasActive) {
          await db
            .prepare(
              `UPDATE tenants SET is_active=1 WHERE id=? AND purge_token IS NULL AND ${leaseActive}`,
            )
            .bind(id, ...leaseArgs())
            .run();
        }
        return c.json(conflict, 409);
      }
      await deleteTenantSettings?.(id, lease.renew);
      await lease.renew();
      if (documents) await deleteTenantBrandingAssets(db, documents, id);
      await lease.renew();
      try {
        const deleted = await db
          .prepare(
            `DELETE FROM tenants WHERE id=? AND purge_token IS NULL AND ${leaseActive}
              AND NOT EXISTS(${linkedQuery}) RETURNING id`,
          )
          .bind(id, ...leaseArgs(), ...linkedArgs)
          .first();
        if (!deleted) {
          const remaining = await db
            .prepare("SELECT purge_token FROM tenants WHERE id=?")
            .bind(id)
            .first<{ purge_token: string | null }>();
          if (!remaining) return c.json(missing, 404);
          if (remaining.purge_token) return c.json(purgeInProgress, 409);
          if (await linked.first()) return c.json(conflict, 409);
          return c.json(deletionInProgress, 409);
        }
      } catch (error) {
        if (isForeignKeyConstraint(error)) return c.json(conflict, 409);
        throw error;
      }
      // Best-effort: drop the tenant's Savia Request overlays (flows,
      // variables, versions, runs, folders, bundles) so sealed secrets never
      // linger in the request store. The core record is already gone, so a
      // purge failure is logged loudly instead of failing the deletion.
      if (saviaRequestService) {
        const scope = `tenant:${id}`;
        try {
          await purgeSaviaRequestTenant(saviaRequestService, scope);
        } catch (error) {
          console.error(
            `Savia Request purge failed for ${scope}:`,
            error instanceof Error ? error.message : error,
          );
        }
      }
      notifyTenantRoom(realtime, c, "tenants", "deleted", id);
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof TenantDeletionLeaseLostError)
        return c.json(deletionInProgress, 409);
      throw error;
    } finally {
      await lease.release();
    }
  });
}

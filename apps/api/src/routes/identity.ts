import {
  createRoute,
  type OpenAPIHono,
  type RouteHandler,
  z,
} from "@hono/zod-openapi";
import {
  actorFromContext,
  requirePlatformAdministrator,
} from "../auth/middleware";
import {
  activePlatformAdministratorCount,
  deletePrincipal,
  ensureBootstrapAdministrator,
  findPrincipal,
  findPrincipalBySubject,
  grantMembership,
  loadActor,
  readIdentityDirectoryRevision,
  removeMembership,
  setPlatformAdministrator,
  setPrincipalActive,
  updatePrincipal,
  upsertPrincipal,
  assertIdentityEmailAvailable,
} from "../auth/identity-repository";
import {
  PLATFORM_TENANT_ID,
  TenantMembershipInvariantError,
  assertPrincipalCanLoseActiveMembership,
  assertPrincipalNotDeleting,
  beginPrincipalDeletion,
  ensureActiveCommercialTenant,
} from "../auth/tenant-membership-invariants";
import type {
  IdentityUserAdministrator,
  ManagedIdentityUser,
  OAuthClientAdministrator,
} from "../auth/better-auth";
import type { Context } from "hono";
import { AuthenticationError, type AgencyRole } from "../auth/types";
import type { AppActor } from "../auth/types";
import type { RealtimeHubClient } from "../realtime/hub-client";
import { publishRealtime } from "../realtime/hub-client";
import { PLATFORM_ROOM, tenantRoom } from "../realtime/protocol";
import {
  areCustomRolesAssignable,
  replaceAccessAssignments,
} from "../auth/access-repository";
import type { AccessScope } from "@savia/studio-shared/access-control";
import { MAX_CUSTOM_ROLES_PER_USER } from "@savia/studio-shared/user-access-limits";
import { AccessControlError } from "../auth/access-registry";
import { assertTenantUserCapacity } from "../auth/tenant-user-capacity";
import {
  withIdentityAccessChange,
  type IdentityAccessChange,
} from "../auth/identity-access-change";

const membershipSchema = z.object({
  id: z.string(),
  role: z.enum(["tenant_admin", "agency_admin", "operator", "viewer"]),
  attributes: z.object({ isActive: z.boolean() }),
  relationships: z.object({
    tenant: z.object({ id: z.string() }),
    agency: z.object({ id: z.string() }),
  }),
});

const actorSchema = z.object({
  id: z.string(),
  kind: z.literal("identity-principal"),
  attributes: z.object({
    email: z.string().email(),
    displayName: z.string(),
    isActive: z.boolean(),
    globalRoles: z.array(z.literal("platform_admin")),
  }),
  relationships: z.object({ memberships: z.array(membershipSchema) }),
});

const managedActorSchema = actorSchema.extend({
  attributes: actorSchema.shape.attributes.extend({
    deletionPending: z.literal(true).optional(),
    account: z
      .object({
        role: z.enum(["admin", "user"]),
        isBanned: z.boolean(),
        twoFactorEnabled: z.boolean(),
        emailVerified: z.boolean().optional(),
      })
      .nullable(),
  }),
});

const currentIdentityRoute = createRoute({
  method: "get",
  path: "/v1/identity/me",
  tags: ["Identity & access"],
  summary: "Get current identity",
  description:
    "Returns the Better Auth identity and Savia authorization memberships.",
  security: [{ oauth2: ["savia.api.read"] }],
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: actorSchema }) },
      },
      description: "Authenticated principal",
    },
    401: { description: "Bearer token is missing or invalid" },
  },
});

const companionSessionRoute = createRoute({
  method: "get",
  path: "/v1/companion/session",
  tags: ["Companion"],
  summary: "Get the current mobile Companion session and workspaces",
  security: [{ oauth2: ["recordings:read"] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            subject: z.string(),
            displayName: z.string(),
            workspaces: z.array(
              z.object({
                id: z.number().int().positive(),
                name: z.string(),
                slug: z.string(),
              }),
            ),
            grantedRecordingScopes: z.array(
              z.enum([
                "recordings:read",
                "recordings:upload",
                "recordings:process",
                "recordings:delete",
              ]),
            ),
          }),
        },
      },
      description: "Safe identity and eligible workspace selection data",
    },
    403: { description: "A recording-scoped OAuth session is required" },
  },
});

const identityUsersRoute = createRoute({
  method: "get",
  path: "/v1/identity/users",
  tags: ["Identity & access"],
  summary: "List Savia users",
  description:
    "Platform administrators see all users; tenant administrators see members of their active tenant.",
  security: [{ oauth2: ["savia.api.read"] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(managedActorSchema) }),
        },
      },
      description: "Provisioned users",
    },
    403: { description: "Platform or tenant administrator role is required" },
    503: { description: "The identity directory is temporarily unavailable" },
  },
});

const membershipInputSchema = z
  .object({
    tenantId: z.number().int().positive().optional(),
    agencyId: z.number().int().positive().optional(),
    role: z.enum(["tenant_admin", "agency_admin", "operator", "viewer"]),
  })
  .refine(
    (input) => input.tenantId !== undefined || input.agencyId !== undefined,
    {
      message: "A tenantId is required",
    },
  )
  .refine(
    (input) =>
      input.tenantId === undefined ||
      input.agencyId === undefined ||
      input.tenantId === input.agencyId,
    {
      message: "tenantId and agencyId must identify the same tenant",
    },
  );

const identityName = z.string().trim().min(1);

const userProvisionSchema = z
  .object({
    email: z.string().trim().email(),
    firstName: identityName,
    lastName: identityName,
    platformAdmin: z.boolean().default(false),
    emailVerified: z.boolean().default(false),
    temporaryPassword: z.string().min(12).max(128).optional(),
    membership: membershipInputSchema.optional(),
    accessRoleIds: z
      .array(z.string().min(1).max(200))
      .max(MAX_CUSTOM_ROLES_PER_USER)
      .optional(),
  })
  .superRefine((input, context) => {
    if (!input.platformAdmin && !input.membership) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["membership"],
        message: "A commercial tenant membership is required",
      });
    }
  });

const provisionIdentityRoute = createRoute({
  method: "post",
  path: "/v1/identity/users",
  tags: ["Identity & access"],
  summary: "Provision a Better Auth user",
  description:
    "Creates a Better Auth user and Savia principal. Tenant administrators can create users only in their active tenant; platform administrators can also create platform administrators.",
  security: [{ oauth2: ["savia.api.write"] }],
  request: {
    body: {
      content: { "application/json": { schema: userProvisionSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: z.object({ data: managedActorSchema }) },
      },
      description: "Provisioned user without password data",
    },
    400: { description: "Invalid user details or temporary password length" },
    403: { description: "Platform or tenant administrator role is required" },
    404: { description: "Tenant was not found" },
    409: {
      description:
        "Email conflict, tenant membership invariant, or active-user capacity prevented provisioning",
    },
    422: {
      description:
        "One or more custom access roles are unavailable in the destination tenant",
    },
    503: { description: "Better Auth provisioning is unavailable" },
  },
});

const membershipParamsSchema = z.object({ principalId: z.string().uuid() });
const grantMembershipRoute = createRoute({
  method: "post",
  path: "/v1/identity/users/{principalId}/memberships",
  tags: ["Identity & access"],
  summary: "Assign tenant access",
  description:
    "Assigns the user to one tenant or updates the existing tenant role.",
  security: [{ oauth2: ["savia.api.write"] }],
  request: {
    params: membershipParamsSchema,
    body: {
      content: { "application/json": { schema: membershipInputSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": { schema: z.object({ data: managedActorSchema }) },
      },
      description: "User with updated tenant assignment",
    },
    403: { description: "Platform or tenant administrator role is required" },
    404: { description: "Identity principal or tenant was not found" },
    409: {
      description:
        "Tenant membership invariant or active-user capacity prevented assignment",
    },
  },
});

const identityUserParamsSchema = z.object({ principalId: z.string().uuid() });
const updateIdentityUserSchema = z
  .object({
    firstName: identityName.optional(),
    lastName: identityName.optional(),
    platformAdmin: z.boolean().optional(),
    emailVerified: z.boolean().optional(),
    membership: membershipInputSchema.optional(),
  })
  .refine(
    (input) =>
      input.firstName !== undefined ||
      input.lastName !== undefined ||
      input.platformAdmin !== undefined ||
      input.emailVerified !== undefined ||
      input.membership !== undefined,
    { message: "At least one change is required" },
  );

const identityUserRoute = createRoute({
  method: "get",
  path: "/v1/identity/users/{principalId}",
  tags: ["Identity & access"],
  summary: "Get a Savia user",
  security: [{ oauth2: ["savia.api.read"] }],
  request: { params: identityUserParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: managedActorSchema }) },
      },
      description: "User with account and access state",
    },
    403: { description: "Platform or tenant administrator role is required" },
    404: { description: "Identity principal was not found" },
  },
});

const updateIdentityUserRoute = createRoute({
  method: "patch",
  path: "/v1/identity/users/{principalId}",
  tags: ["Identity & access"],
  summary: "Update a Savia user and platform role",
  security: [{ oauth2: ["savia.api.write"] }],
  request: {
    params: identityUserParamsSchema,
    body: {
      content: { "application/json": { schema: updateIdentityUserSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": { schema: z.object({ data: managedActorSchema }) },
      },
      description: "Updated user",
    },
    400: {
      description:
        "The update is invalid or would remove the final administrator",
    },
    403: { description: "Platform or tenant administrator role is required" },
    404: { description: "Identity principal was not found" },
    409: {
      description:
        "Tenant membership invariant or active-user capacity prevented the update",
    },
  },
});

const deleteMembershipRoute = createRoute({
  method: "delete",
  path: "/v1/identity/users/{principalId}/memberships/{agencyId}",
  tags: ["Identity & access"],
  summary: "Remove tenant access",
  security: [{ oauth2: ["savia.api.write"] }],
  request: {
    params: identityUserParamsSchema.extend({
      agencyId: z.coerce.number().int().positive(),
    }),
  },
  responses: { 204: { description: "Tenant assignment removed" } },
});

const accountActionParamsSchema = identityUserParamsSchema;

function accountActionRoute(
  method: "post" | "delete",
  suffix: string,
  summary: string,
  description: string,
) {
  return createRoute({
    method,
    path: `/v1/identity/users/{principalId}/${suffix}`,
    tags: ["Identity & access"],
    summary,
    security: [{ oauth2: ["savia.api.write"] }],
    request: { params: accountActionParamsSchema },
    responses: {
      204: { description },
      403: { description: "Platform or tenant administrator role is required" },
      404: { description: "Identity principal was not found" },
      409: {
        description:
          "Identity or tenant capacity constraints prevented the operation",
      },
    },
  });
}

const suspendIdentityUserRoute = accountActionRoute(
  "post",
  "suspension",
  "Suspend a Savia user",
  "Account blocked and sessions revoked",
);
const reactivateIdentityUserRoute = accountActionRoute(
  "delete",
  "suspension",
  "Reactivate a Savia user",
  "Account reactivated",
);
const revokeIdentityUserSessionsRoute = accountActionRoute(
  "post",
  "sessions/revoke",
  "Revoke user sessions",
  "All user sessions revoked",
);
const passwordResetIdentityUserRoute = accountActionRoute(
  "post",
  "password-reset",
  "Send a password reset link",
  "Password reset link accepted for delivery",
);

const deleteIdentityRoute = createRoute({
  method: "delete",
  path: "/v1/identity/users/{principalId}",
  tags: ["Identity & access"],
  summary: "Delete a Savia user",
  description:
    "Disables the user in Savia before removing the Better Auth account and local memberships. Retry this request if Auth is unavailable.",
  security: [{ oauth2: ["savia.api.write"] }],
  request: { params: membershipParamsSchema },
  responses: {
    204: { description: "User removed from Better Auth and Savia" },
    403: { description: "Platform or tenant administrator role is required" },
    404: { description: "Identity principal was not found" },
    409: {
      description:
        "Deleting the user would remove the last active tenant member or platform administrator",
    },
    503: { description: "Auth deletion could not be completed" },
  },
});

const oauthClientAuthenticationSchema = z.enum([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);
const oauthClientSummarySchema = z.object({
  applicationType: z.enum(["native", "web"]),
  clientAuthentication: oauthClientAuthenticationSchema,
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  grantTypes: z.array(z.enum(["authorization_code", "refresh_token"])).min(1),
  redirectUris: z.array(z.string().min(1)).min(1),
  scopes: z.array(z.string().min(1)),
  trusted: z.boolean(),
});
const oauthClientCreatedSchema = oauthClientSummarySchema.extend({
  clientSecret: z.string().min(1).optional(),
});
const oauthClientCreateSchema = z.object({
  applicationType: z.enum(["native", "web"]).optional(),
  clientAuthentication: oauthClientAuthenticationSchema,
  clientName: z.string().min(1).max(120),
  grantTypes: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .min(1)
    .optional(),
  redirectUris: z.array(z.string().min(1)).min(1),
  scopes: z.array(z.string().min(1)).min(1),
  trusted: z.boolean().default(false),
});
const oauthClientUpdateSchema = oauthClientCreateSchema
  .omit({ clientAuthentication: true })
  .partial()
  .refine((input) => Object.keys(input).length > 0);
const oauthClientParamsSchema = z.object({ clientId: z.string().min(1) });

const listOAuthClientsRoute = createRoute({
  method: "get",
  path: "/v1/identity/oauth-clients",
  tags: ["Identity & access"],
  summary: "List OAuth clients",
  security: [{ oauth2: ["savia.api.read"] }],
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: z.array(oauthClientSummarySchema) }),
        },
      },
      description: "OAuth clients without secrets",
    },
    403: { description: "Platform administrator role is required" },
  },
});

const createOAuthClientRoute = createRoute({
  method: "post",
  path: "/v1/identity/oauth-clients",
  tags: ["Identity & access"],
  summary: "Create an OAuth client",
  security: [{ oauth2: ["savia.api.write"] }],
  request: {
    body: {
      content: { "application/json": { schema: oauthClientCreateSchema } },
      required: true,
    },
  },
  responses: {
    201: {
      content: {
        "application/json": {
          schema: z.object({ data: oauthClientCreatedSchema }),
        },
      },
      description: "Client; a confidential client secret is returned only once",
    },
    403: { description: "Platform administrator role is required" },
  },
});

const updateOAuthClientRoute = createRoute({
  method: "patch",
  path: "/v1/identity/oauth-clients/{clientId}",
  tags: ["Identity & access"],
  summary: "Update an OAuth client",
  security: [{ oauth2: ["savia.api.write"] }],
  request: {
    params: oauthClientParamsSchema,
    body: {
      content: { "application/json": { schema: oauthClientUpdateSchema } },
      required: true,
    },
  },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({ data: oauthClientSummarySchema }),
        },
      },
      description: "Client without a secret",
    },
  },
});

const deleteOAuthClientRoute = createRoute({
  method: "delete",
  path: "/v1/identity/oauth-clients/{clientId}",
  tags: ["Identity & access"],
  summary: "Disable an OAuth client",
  security: [{ oauth2: ["savia.api.write"] }],
  request: { params: oauthClientParamsSchema },
  responses: { 204: { description: "Client disabled" } },
});

const rotateOAuthClientSecretRoute = createRoute({
  method: "post",
  path: "/v1/identity/oauth-clients/{clientId}/rotate-secret",
  tags: ["Identity & access"],
  summary: "Rotate a confidential OAuth client secret",
  security: [{ oauth2: ["savia.api.write"] }],
  request: { params: oauthClientParamsSchema },
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            data: z.object({ clientId: z.string(), clientSecret: z.string() }),
          }),
        },
      },
      description: "New secret, returned only once",
    },
  },
});

function actorDocument(actor: AppActor) {
  return {
    id: actor.principal.id,
    kind: "identity-principal" as const,
    attributes: {
      email: actor.principal.email,
      displayName: actor.principal.displayName,
      isActive: actor.principal.isActive,
      globalRoles: actor.globalRoles,
    },
    relationships: {
      memberships: actor.memberships.map((entry) => ({
        id: entry.id,
        role: entry.role,
        attributes: { isActive: entry.isActive },
        relationships: {
          tenant: { id: String(entry.tenantId ?? entry.agencyId) },
          agency: { id: String(entry.agencyId) },
        },
      })),
    },
  };
}

function managedActorDocument(
  actor: AppActor,
  account: ManagedIdentityUser | null,
) {
  const document = actorDocument(actor);
  return {
    ...document,
    attributes: {
      ...document.attributes,
      ...(account === null ? { deletionPending: true as const } : {}),
      account: account && {
        role: account.role,
        isBanned: account.isBanned,
        twoFactorEnabled: account.twoFactorEnabled,
        ...(typeof account.emailVerified === "boolean"
          ? { emailVerified: account.emailVerified }
          : {}),
      },
    },
  };
}

async function managedActor(
  d1: D1Database,
  actor: AppActor,
  administrator: IdentityUserAdministrator,
  request: Request,
  tenantId: number | undefined,
) {
  if (actor.principal.deletionStartedAt)
    return managedActorDocument(actor, null);
  try {
    return managedActorDocument(
      actor,
      await administrator.getUser(actor.principal.subject, request),
    );
  } catch (error) {
    const current = await findPrincipal(d1, actor.principal.id);
    if (!current) return undefined;
    if (current.deletionStartedAt) {
      const pending = await loadActor(d1, current);
      return targetBelongsToScope(pending, tenantId)
        ? managedActorDocument(pending, null)
        : undefined;
    }
    throw error;
  }
}

function unavailableUserAdministration(): never {
  throw new AuthenticationError(
    "AUTHENTICATION_UNAVAILABLE",
    "User administration is not configured",
  );
}

function preventSelfAdministration(actor: AppActor, principalId: string): void {
  if (actor.principal.id === principalId) {
    throw new AuthenticationError(
      "AUTHORIZATION_FORBIDDEN",
      "Platform administrators cannot perform this action on themselves",
    );
  }
}

async function preventRemovingFinalAdministrator(
  d1: D1Database,
  target: AppActor,
): Promise<Response | undefined> {
  if (
    target.globalRoles.includes("platform_admin") &&
    (await activePlatformAdministratorCount(d1)) <= 1
  ) {
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message:
            "Savia must retain at least one active platform administrator",
        },
      },
      { status: 400 },
    );
  }
  return undefined;
}

function membershipInvariantResponse(
  context: { json: (body: unknown, status: 404 | 409) => Response },
  error: TenantMembershipInvariantError,
): Response {
  return context.json(
    { error: { code: error.code, message: error.message } },
    error.code === "TENANT_NOT_FOUND" ? 404 : 409,
  );
}

function authEmailTenantId(actor: AppActor): number | null {
  const membership = actor.memberships[0];
  const tenantId = membership?.tenantId ?? membership?.agencyId;
  return tenantId === PLATFORM_TENANT_ID ? null : (tenantId ?? null);
}

/**
 * Best-effort realtime hint after identity mutations. The socket carries no
 * record data; subscribers refetch the users list through the API.
 */
function notifyUsers(
  realtime: RealtimeHubClient | undefined,
  context: Context,
  type: "created" | "updated" | "deleted",
  id: string,
): void {
  publishRealtime(realtime, PLATFORM_ROOM, {
    topic: "users",
    type,
    id,
    actor: actorFromContext(context).principal.id,
  });
}

function notifyMembershipUpdates(
  realtime: RealtimeHubClient | undefined,
  actorId: string,
  principalId: string,
  tenantIds: number[],
): void {
  for (const tenantId of new Set(tenantIds)) {
    publishRealtime(realtime, tenantRoom(tenantId), {
      topic: "access-control",
      type: "updated",
      collection: "memberships",
      id: principalId,
      actor: actorId,
    });
  }
}

function notifyUserActivity(
  realtime: RealtimeHubClient | undefined,
  context: Context,
  target: AppActor,
  type: "updated" | "deleted",
): void {
  notifyUsers(realtime, context, type, target.principal.id);
  notifyMembershipUpdates(
    realtime,
    actorFromContext(context).principal.id,
    target.principal.id,
    target.memberships.map(
      (membership) => membership.tenantId ?? membership.agencyId,
    ),
  );
}

function tenantIdentityAdminScope(actor: AppActor): number | undefined {
  if (actor.globalRoles.includes("platform_admin")) return undefined;
  const memberships = actor.memberships.filter(
    (membership) =>
      membership.isActive &&
      (membership.role === "tenant_admin" ||
        membership.role === "agency_admin"),
  );
  if (memberships.length !== 1) {
    throw new AuthenticationError(
      "AUTHORIZATION_FORBIDDEN",
      "A tenant administrator role is required",
    );
  }
  const tenantId = memberships[0].tenantId ?? memberships[0].agencyId;
  if (tenantId <= 0) {
    throw new AuthenticationError(
      "AUTHORIZATION_FORBIDDEN",
      "A tenant administrator role is required",
    );
  }
  return tenantId;
}

function requireIdentityAdministrator(actor: AppActor): number | undefined {
  return tenantIdentityAdminScope(actor);
}

function targetBelongsToScope(
  target: AppActor,
  tenantId: number | undefined,
): boolean {
  if (tenantId === undefined) return true;
  if (target.globalRoles.includes("platform_admin")) return false;
  return target.memberships.some(
    (membership) => (membership.tenantId ?? membership.agencyId) === tenantId,
  );
}

function notFound(context: { json: (body: unknown, status: 404) => Response }) {
  return context.json(
    { error: { code: "NOT_FOUND", message: "Identity principal not found" } },
    404,
  );
}

export function registerIdentityRoutes(
  app: OpenAPIHono,
  d1: D1Database,
  userAdministrator?: IdentityUserAdministrator,
  oauthClientAdministrator?: OAuthClientAdministrator,
  realtime?: RealtimeHubClient,
): void {
  app.openapi(currentIdentityRoute, (context) =>
    context.json({ data: actorDocument(actorFromContext(context)) }, 200),
  );
  app.openapi(companionSessionRoute, (context) => {
    const actor = actorFromContext(context);
    if (actor.credential?.kind !== "oauth") {
      return context.json(
        {
          error: {
            code: "AUTHORIZATION_FORBIDDEN",
            message: "A mobile OAuth session is required.",
          },
        },
        403,
      );
    }
    if (!actor.credential.scopes.includes("recordings:read")) {
      return context.json(
        {
          error: {
            code: "INSUFFICIENT_SCOPE",
            message: "The access token does not grant recordings:read.",
          },
        },
        403,
      );
    }
    return context.json(
      {
        subject: actor.principal.subject,
        displayName: actor.principal.displayName,
        workspaces: actor.memberships
          .filter(
            (membership) =>
              membership.isActive &&
              (membership.tenantId ?? membership.agencyId) > 0 &&
              membership.tenantName &&
              membership.tenantSlug,
          )
          .map((membership) => ({
            id: membership.tenantId ?? membership.agencyId,
            name: membership.tenantName!,
            slug: membership.tenantSlug!,
          })),
        grantedRecordingScopes: actor.credential.scopes.filter(
          (
            scope,
          ): scope is
            | "recordings:read"
            | "recordings:upload"
            | "recordings:process"
            | "recordings:delete" =>
            scope === "recordings:read" ||
            scope === "recordings:upload" ||
            scope === "recordings:process" ||
            scope === "recordings:delete",
        ),
      },
      200,
    );
  });
  app.openapi(identityUsersRoute, async (context) => {
    const tenantId = requireIdentityAdministrator(actorFromContext(context));
    if (!userAdministrator) unavailableUserAdministration();
    const tenantScope =
      tenantId === undefined
        ? ""
        : `
      AND EXISTS (SELECT 1 FROM identity_tenant_membership m WHERE m.principal_id=p.id AND m.tenant_id=?)
      AND NOT EXISTS (SELECT 1 FROM identity_global_role g WHERE g.principal_id=p.id)`;
    const scopeParameters =
      tenantId === undefined
        ? [userAdministrator.issuer]
        : [userAdministrator.issuer, tenantId];
    const loadDirectory = async (revision: number) => {
      const accounts =
        tenantId === undefined
          ? await userAdministrator.listUsers(context.req.raw)
          : await Promise.all(
              (
                await d1
                  .prepare(
                    `SELECT p.id,p.subject FROM identity_principal p
                   WHERE p.issuer=? AND p.deletion_started_at IS NULL ${tenantScope}
                   ORDER BY p.display_name,p.id`,
                  )
                  .bind(...scopeParameters)
                  .all<{ id: string; subject: string }>()
              ).results.map(async (principal) => {
                try {
                  return await userAdministrator.getUser(
                    principal.subject,
                    context.req.raw,
                  );
                } catch (error) {
                  // A deletion may have started after the list query.
                  const current = await findPrincipal(d1, principal.id);
                  if (!current || current.deletionStartedAt) return undefined;
                  throw error;
                }
              }),
            );
      if ((await readIdentityDirectoryRevision(d1)) !== revision)
        return undefined;
      const documents = await Promise.all(
        accounts.map(async (account) => {
          if (!account) return undefined;
          let principal = await findPrincipalBySubject(
            d1,
            userAdministrator.issuer,
            account.subject,
          );
          // Use the local record for pending users, even if Auth still lists them.
          if (principal?.deletionStartedAt) return undefined;
          // The tenant catalog queried an existing membership before calling Auth.
          if (!principal && tenantId !== undefined) return undefined;
          if (
            !principal ||
            principal.email !== account.email ||
            principal.displayName !== account.displayName
          ) {
            principal = await upsertPrincipal(
              d1,
              {
                issuer: userAdministrator.issuer,
                subject: account.subject,
                email: account.email,
                displayName: account.displayName,
              },
              revision,
            );
          }
          if (!principal) return undefined;
          let actor = await loadActor(d1, principal);
          if (
            !principal.platformAdminRevoked &&
            account.role === "admin" &&
            !actor.globalRoles.includes("platform_admin")
          ) {
            if (tenantId !== undefined) return undefined;
            await ensureBootstrapAdministrator(d1, principal.id);
            actor = await loadActor(d1, principal);
          }
          if (!targetBelongsToScope(actor, tenantId)) return undefined;
          return managedActorDocument(actor, account);
        }),
      );
      const pendingRows = await d1
        .prepare(
          `SELECT p.id FROM identity_principal p
         WHERE p.issuer=? AND p.deletion_started_at IS NOT NULL ${tenantScope}
         ORDER BY p.display_name,p.id`,
        )
        .bind(...scopeParameters)
        .all<{ id: string }>();
      const pending = await Promise.all(
        pendingRows.results.map(async ({ id }) => {
          const principal = await findPrincipal(d1, id);
          if (!principal?.deletionStartedAt) return undefined;
          const actor = await loadActor(d1, principal);
          if (!targetBelongsToScope(actor, tenantId)) return undefined;
          return managedActorDocument(actor, null);
        }),
      );
      const pendingIds = new Set(pendingRows.results.map(({ id }) => id));
      return [
        ...documents.filter(
          (document) => document && !pendingIds.has(document.id),
        ),
        ...pending.filter((document) => document !== undefined),
      ];
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const revision = await readIdentityDirectoryRevision(d1);
      try {
        const data = await loadDirectory(revision);
        if (data && (await readIdentityDirectoryRevision(d1)) === revision)
          return context.json({ data }, 200);
      } catch (error) {
        if ((await readIdentityDirectoryRevision(d1)) === revision) throw error;
      }
    }
    throw new AuthenticationError(
      "AUTHENTICATION_UNAVAILABLE",
      "The identity directory changed while loading. Try again.",
    );
  });
  const provisionIdentity: RouteHandler<typeof provisionIdentityRoute> = async (
    context,
  ) => {
    const actor = actorFromContext(context);
    const tenantId = requireIdentityAdministrator(actor);
    if (!userAdministrator) unavailableUserAdministration();
    const input = context.req.valid("json");
    if (tenantId !== undefined) {
      const requestedTenant =
        input.membership?.tenantId ?? input.membership?.agencyId;
      if (
        input.platformAdmin ||
        (requestedTenant !== undefined && requestedTenant !== tenantId)
      ) {
        return notFound(context);
      }
      if (!input.membership) {
        return context.json(
          {
            error: {
              code: "VALIDATION_ERROR",
              message: "A tenant membership is required",
            },
          },
          400,
        );
      }
      input.membership.tenantId = tenantId;
      input.membership.agencyId = tenantId;
    }
    const destinationTenantId = input.platformAdmin
      ? undefined
      : (input.membership?.tenantId ?? input.membership?.agencyId);
    const accessRoleIds = [...new Set(input.accessRoleIds ?? [])];
    const accessScope =
      `tenant:${input.platformAdmin ? 0 : destinationTenantId}` as AccessScope;
    if (!(await areCustomRolesAssignable(d1, accessScope, accessRoleIds))) {
      return context.json(
        {
          error: {
            code: "INVALID_ACCESS_ROLE",
            message:
              "Only enabled custom roles in the destination tenant can be assigned.",
          },
        },
        422,
      );
    }
    await assertIdentityEmailAvailable(d1, input.email);
    if (destinationTenantId !== undefined) {
      try {
        await ensureActiveCommercialTenant(d1, destinationTenantId);
      } catch (error) {
        if (error instanceof TenantMembershipInvariantError)
          return membershipInvariantResponse(context, error);
        throw error;
      }
      await assertTenantUserCapacity(d1, destinationTenantId);
    }
    const authenticatedUser = await userAdministrator.createUser(
      {
        email: input.email.trim().toLowerCase(),
        firstName: input.firstName,
        lastName: input.lastName,
        platformAdmin: input.platformAdmin,
        temporaryPassword: input.temporaryPassword,
        tenantId: destinationTenantId,
        emailVerified: input.emailVerified,
      },
      context.req.raw,
    );
    let createdPrincipalId: string | undefined;
    try {
      const principal = await upsertPrincipal(d1, {
        issuer: userAdministrator.issuer,
        subject: authenticatedUser.subject,
        email: authenticatedUser.email,
        displayName: authenticatedUser.displayName,
      });
      createdPrincipalId = principal.id;
      if (input.platformAdmin) {
        await setPlatformAdministrator(d1, principal.id, true);
      } else if (input.membership && destinationTenantId !== undefined) {
        await grantMembership(
          d1,
          principal.id,
          destinationTenantId,
          input.membership.role as AgencyRole,
        );
      }
      if (accessRoleIds.length) {
        const currentRevision = await d1
          .prepare("SELECT revision FROM access_revisions WHERE scope=?")
          .bind(accessScope)
          .first<{ revision: number }>();
        await replaceAccessAssignments(d1, actorFromContext(context), {
          scope: accessScope,
          principalId: principal.id,
          roleIds: accessRoleIds,
          expectedRevision: currentRevision?.revision ?? 0,
        });
      }
      if (!input.temporaryPassword) {
        await userAdministrator.sendPasswordReset(
          authenticatedUser.subject,
          context.req.raw,
        );
      }
      notifyUsers(realtime, context, "created", principal.id);
      const membershipTenantId = input.platformAdmin ? 0 : destinationTenantId;
      if (membershipTenantId !== undefined)
        publishRealtime(realtime, tenantRoom(membershipTenantId), {
          topic: "access-control",
          type: "updated",
          collection: "memberships",
          id: principal.id,
          actor: actorFromContext(context).principal.id,
        });
      return context.json(
        {
          data: managedActorDocument(
            await loadActor(d1, principal),
            await userAdministrator.getUser(
              authenticatedUser.subject,
              context.req.raw,
            ),
          ),
        },
        201,
      );
    } catch (exception) {
      if (createdPrincipalId) await deletePrincipal(d1, createdPrincipalId);
      await userAdministrator.deleteUser(
        authenticatedUser.subject,
        context.req.raw,
      );
      if (exception instanceof TenantMembershipInvariantError) {
        return membershipInvariantResponse(context, exception);
      }
      throw exception;
    }
  };
  app.openapi(provisionIdentityRoute, provisionIdentity, (result, context) => {
    if (result.success) return;
    const passwordInvalid = result.error.issues.some(
      ({ path }) => path.length === 1 && path[0] === "temporaryPassword",
    );
    return context.json(
      {
        error: passwordInvalid
          ? {
              code: "USER_TEMPORARY_PASSWORD_INVALID",
              message:
                "The temporary password must contain 12 to 128 characters.",
            }
          : { code: "VALIDATION_ERROR", message: "Invalid request" },
      },
      400,
    );
  });
  app.openapi(grantMembershipRoute, async (context) => {
    const tenantId = requireIdentityAdministrator(actorFromContext(context));
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    const principal = await findPrincipal(d1, principalId);
    if (!principal) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    const input = context.req.valid("json");
    const requestedTenant = input.tenantId ?? input.agencyId!;
    if (
      tenantId !== undefined &&
      (requestedTenant !== tenantId ||
        !targetBelongsToScope(await loadActor(d1, principal), tenantId))
    )
      return notFound(context);
    return withIdentityAccessChange(d1, principal.id, async (accessChange) => {
      const targetActor = await loadActor(d1, principal);
      if (!targetBelongsToScope(targetActor, tenantId))
        return notFound(context);
      await accessChange.assertSourceAvailable();
      try {
        await assertPrincipalNotDeleting(d1, principal.id);
        await ensureActiveCommercialTenant(d1, requestedTenant);
      } catch (error) {
        if (error instanceof TenantMembershipInvariantError)
          return membershipInvariantResponse(context, error);
        throw error;
      }
      const previousEmailTenantId = authEmailTenantId(targetActor);
      await accessChange.renew();
      await userAdministrator.updateUser(
        principal.subject,
        { tenantId: requestedTenant },
        context.req.raw,
      );
      try {
        await accessChange.renew();
        await grantMembership(d1, principal.id, requestedTenant, input.role);
      } catch (error) {
        await accessChange.renew();
        await userAdministrator.updateUser(
          principal.subject,
          { tenantId: previousEmailTenantId },
          context.req.raw,
        );
        if (error instanceof TenantMembershipInvariantError) {
          return membershipInvariantResponse(context, error);
        }
        throw error;
      }
      notifyUsers(realtime, context, "updated", principal.id);
      notifyMembershipUpdates(
        realtime,
        actorFromContext(context).principal.id,
        principal.id,
        [
          ...targetActor.memberships.map(
            (membership) => membership.tenantId ?? membership.agencyId,
          ),
          requestedTenant,
        ],
      );
      return context.json(
        {
          data: managedActorDocument(
            await loadActor(d1, principal),
            await userAdministrator.getUser(principal.subject, context.req.raw),
          ),
        },
        201,
      );
    });
  });
  app.openapi(identityUserRoute, async (context) => {
    const tenantId = requireIdentityAdministrator(actorFromContext(context));
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    const target = await findPrincipal(d1, principalId);
    if (!target) return notFound(context);
    const actor = await loadActor(d1, target);
    if (!targetBelongsToScope(actor, tenantId)) return notFound(context);
    const document = await managedActor(
      d1,
      actor,
      userAdministrator,
      context.req.raw,
      tenantId,
    );
    if (!document) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    return context.json({ data: document }, 200);
  });
  app.openapi(updateIdentityUserRoute, async (context) => {
    const actor = actorFromContext(context);
    const tenantId = requireIdentityAdministrator(actor);
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    const target = await findPrincipal(d1, principalId);
    if (!target) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    const input = context.req.valid("json");
    const changingAccess =
      input.platformAdmin !== undefined || input.membership !== undefined;
    if (
      changingAccess &&
      tenantId !== undefined &&
      (input.platformAdmin !== undefined ||
        (input.membership?.tenantId ?? input.membership?.agencyId) !==
          tenantId ||
        !targetBelongsToScope(await loadActor(d1, target), tenantId))
    )
      return notFound(context);
    const update = async (accessChange?: IdentityAccessChange) => {
      const targetActor = await loadActor(d1, target);
      if (!targetBelongsToScope(targetActor, tenantId))
        return notFound(context);
      await accessChange?.assertSourceAvailable();
      const demotionTenantId =
        input.platformAdmin === false &&
        targetActor.globalRoles.includes("platform_admin")
          ? (input.membership?.tenantId ?? input.membership?.agencyId)
          : undefined;
      if (demotionTenantId !== undefined)
        await assertTenantUserCapacity(d1, demotionTenantId, target.id);
      try {
        await assertPrincipalNotDeleting(d1, target.id);
        if (input.platformAdmin === true) {
          await assertPrincipalCanLoseActiveMembership(d1, target.id);
        } else if (input.membership) {
          await ensureActiveCommercialTenant(
            d1,
            input.membership.tenantId ?? input.membership.agencyId!,
          );
        }
      } catch (error) {
        if (error instanceof TenantMembershipInvariantError) {
          return membershipInvariantResponse(context, error);
        }
        throw error;
      }
      if (input.platformAdmin === false) {
        preventSelfAdministration(actor, target.id);
        const blocked = await preventRemovingFinalAdministrator(
          d1,
          targetActor,
        );
        if (blocked) return blocked;
        if (
          targetActor.globalRoles.includes("platform_admin") &&
          !input.membership
        ) {
          return context.json(
            {
              error: {
                code: "COMMERCIAL_MEMBERSHIP_REQUIRED",
                message:
                  "A commercial tenant membership is required when revoking platform administration",
              },
            },
            400,
          );
        }
      }
      const [savedFirstName = "", ...savedLastName] = target.displayName
        .trim()
        .split(/\s+/);
      const displayName =
        input.firstName === undefined && input.lastName === undefined
          ? undefined
          : [
              input.firstName ?? savedFirstName,
              input.lastName ?? savedLastName.join(" "),
            ]
              .filter(Boolean)
              .join(" ");
      const previousEmailTenantId = authEmailTenantId(targetActor);
      const nextEmailTenantId =
        input.platformAdmin === true
          ? null
          : input.membership
            ? (input.membership.tenantId ?? input.membership.agencyId!)
            : undefined;
      const previousAccount =
        changingAccess &&
        (displayName !== undefined || input.emailVerified !== undefined)
          ? await userAdministrator.getUser(target.subject, context.req.raw)
          : undefined;
      await accessChange?.renew();
      const account = await userAdministrator.updateUser(
        target.subject,
        {
          displayName,
          platformAdmin: input.platformAdmin,
          emailVerified: input.emailVerified,
          ...(nextEmailTenantId === undefined
            ? {}
            : { tenantId: nextEmailTenantId }),
        },
        context.req.raw,
      );
      try {
        await accessChange?.renew();
        if (input.platformAdmin !== undefined) {
          await setPlatformAdministrator(
            d1,
            target.id,
            input.platformAdmin,
            input.membership?.tenantId ?? input.membership?.agencyId,
            input.membership?.role,
          );
        } else if (input.membership) {
          await grantMembership(
            d1,
            target.id,
            input.membership.tenantId ?? input.membership.agencyId!,
            input.membership.role,
          );
        }
      } catch (error) {
        await accessChange?.renew();
        await userAdministrator.updateUser(
          target.subject,
          {
            ...(input.platformAdmin === undefined
              ? {}
              : {
                  platformAdmin:
                    targetActor.globalRoles.includes("platform_admin"),
                }),
            ...(nextEmailTenantId === undefined
              ? {}
              : { tenantId: previousEmailTenantId }),
            ...(displayName !== undefined && previousAccount
              ? { displayName: previousAccount.displayName }
              : {}),
            ...(input.emailVerified !== undefined && previousAccount
              ? { emailVerified: Boolean(previousAccount.emailVerified) }
              : {}),
          },
          context.req.raw,
        );
        if (error instanceof TenantMembershipInvariantError) {
          return membershipInvariantResponse(context, error);
        }
        throw error;
      }
      const savedPrincipal = displayName
        ? await updatePrincipal(d1, target.id, { displayName })
        : target;
      const updatedActor = await loadActor(d1, savedPrincipal);
      notifyMembershipUpdates(realtime, actor.principal.id, target.id, [
        ...targetActor.memberships.map(
          (membership) => membership.tenantId ?? membership.agencyId,
        ),
        ...updatedActor.memberships.map(
          (membership) => membership.tenantId ?? membership.agencyId,
        ),
        ...(targetActor.globalRoles.includes("platform_admin") ||
        updatedActor.globalRoles.includes("platform_admin")
          ? [0]
          : []),
      ]);
      notifyUsers(realtime, context, "updated", target.id);
      return context.json(
        {
          data: managedActorDocument(updatedActor, account),
        },
        200,
      );
    };
    return changingAccess
      ? withIdentityAccessChange(d1, target.id, update)
      : update();
  });
  app.openapi(deleteMembershipRoute, async (context) => {
    const tenantId = requireIdentityAdministrator(actorFromContext(context));
    const { principalId, agencyId } = context.req.valid("param");
    const target = await findPrincipal(d1, principalId);
    if (!target) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    const targetActor = await loadActor(d1, target);
    if (
      !targetBelongsToScope(targetActor, tenantId) ||
      (tenantId !== undefined && Number(agencyId) !== tenantId)
    )
      return notFound(context);
    // A current membership can only change through a transfer. Deleting
    // another membership is idempotent and leaves the Auth account untouched.
    try {
      await removeMembership(d1, principalId, agencyId);
    } catch (error) {
      if (error instanceof TenantMembershipInvariantError) {
        return membershipInvariantResponse(context, error);
      }
      throw error;
    }
    notifyUsers(realtime, context, "updated", principalId);
    publishRealtime(realtime, tenantRoom(Number(agencyId)), {
      topic: "access-control",
      type: "updated",
      collection: "memberships",
      id: principalId,
      actor: actorFromContext(context).principal.id,
    });
    return context.body(null, 204);
  });
  app.openapi(suspendIdentityUserRoute, async (context) => {
    const actor = actorFromContext(context);
    const tenantId = requireIdentityAdministrator(actor);
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    preventSelfAdministration(actor, principalId);
    const target = await findPrincipal(d1, principalId);
    if (!target) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    const targetActor = await loadActor(d1, target);
    if (!targetBelongsToScope(targetActor, tenantId)) return notFound(context);
    const blocked = await preventRemovingFinalAdministrator(d1, targetActor);
    if (blocked) return blocked;
    try {
      await assertPrincipalNotDeleting(d1, target.id);
      await assertPrincipalCanLoseActiveMembership(d1, target.id);
      await userAdministrator.setAccountActive(
        target.subject,
        false,
        context.req.raw,
      );
      try {
        await setPrincipalActive(d1, target.id, false);
      } catch (error) {
        await userAdministrator.setAccountActive(
          target.subject,
          true,
          context.req.raw,
        );
        throw error;
      }
    } catch (error) {
      if (error instanceof TenantMembershipInvariantError) {
        return membershipInvariantResponse(context, error);
      }
      throw error;
    }
    notifyUserActivity(realtime, context, targetActor, "updated");
    return context.body(null, 204);
  });
  app.openapi(reactivateIdentityUserRoute, async (context) => {
    const tenantId = requireIdentityAdministrator(actorFromContext(context));
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    const target = await findPrincipal(d1, principalId);
    if (!target) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    const targetActor = await loadActor(d1, target);
    if (!targetBelongsToScope(targetActor, tenantId)) return notFound(context);
    try {
      await assertPrincipalNotDeleting(d1, target.id);
    } catch (error) {
      if (error instanceof TenantMembershipInvariantError) {
        return membershipInvariantResponse(context, error);
      }
      throw error;
    }
    const reactivationTenantId =
      tenantId ??
      targetActor.memberships
        .map((membership) => membership.tenantId ?? membership.agencyId)
        .find((id) => id > 0);
    if (reactivationTenantId !== undefined)
      await assertTenantUserCapacity(d1, reactivationTenantId, target.id);
    if (!target.isActive)
      await assertIdentityEmailAvailable(d1, target.email, target.id);
    await userAdministrator.setAccountActive(
      target.subject,
      true,
      context.req.raw,
    );
    try {
      await setPrincipalActive(d1, target.id, true);
    } catch (error) {
      if (!target.isActive) {
        await userAdministrator.setAccountActive(
          target.subject,
          false,
          context.req.raw,
        );
      }
      if (error instanceof TenantMembershipInvariantError)
        return membershipInvariantResponse(context, error);
      throw error;
    }
    notifyUserActivity(realtime, context, targetActor, "updated");
    return context.body(null, 204);
  });
  app.openapi(revokeIdentityUserSessionsRoute, async (context) => {
    const actor = actorFromContext(context);
    const tenantId = requireIdentityAdministrator(actor);
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    preventSelfAdministration(actor, principalId);
    const target = await findPrincipal(d1, principalId);
    if (!target) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    if (!targetBelongsToScope(await loadActor(d1, target), tenantId))
      return notFound(context);
    await userAdministrator.revokeSessions(target.subject, context.req.raw);
    return context.body(null, 204);
  });
  app.openapi(passwordResetIdentityUserRoute, async (context) => {
    const tenantId = requireIdentityAdministrator(actorFromContext(context));
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    const target = await findPrincipal(d1, principalId);
    if (!target) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    if (!targetBelongsToScope(await loadActor(d1, target), tenantId))
      return notFound(context);
    await userAdministrator.sendPasswordReset(target.subject, context.req.raw);
    return context.body(null, 204);
  });
  app.openapi(deleteIdentityRoute, async (context) => {
    const actor = actorFromContext(context);
    const tenantId = requireIdentityAdministrator(actor);
    if (!userAdministrator) unavailableUserAdministration();
    const { principalId } = context.req.valid("param");
    const principal = await findPrincipal(d1, principalId);
    if (!principal) {
      return context.json(
        {
          error: { code: "NOT_FOUND", message: "Identity principal not found" },
        },
        404,
      );
    }
    preventSelfAdministration(actor, principal.id);
    const targetActor = await loadActor(d1, principal);
    if (!targetBelongsToScope(targetActor, tenantId)) return notFound(context);
    const blocked = principal.isActive
      ? await preventRemovingFinalAdministrator(d1, targetActor)
      : undefined;
    if (blocked) return blocked;
    try {
      if (!(await beginPrincipalDeletion(d1, principal.id)))
        return context.body(null, 204);
    } catch (error) {
      if (error instanceof TenantMembershipInvariantError) {
        return membershipInvariantResponse(context, error);
      }
      throw error;
    }
    try {
      await userAdministrator.deleteUser(principal.subject, context.req.raw);
      await deletePrincipal(d1, principal.id);
    } catch (error) {
      notifyUserActivity(realtime, context, targetActor, "updated");
      console.warn(
        "IDENTITY_DELETION_PENDING",
        error instanceof AuthenticationError ? error.code : "DELETION_FAILED",
      );
      return context.json(
        {
          error: {
            code: "IDENTITY_DELETION_PENDING",
            message: "The user remains disabled. Retry deletion to finish.",
          },
        },
        503,
      );
    }
    notifyUserActivity(realtime, context, targetActor, "deleted");
    return context.body(null, 204);
  });
  app.openapi(listOAuthClientsRoute, async (context) => {
    requirePlatformAdministrator(actorFromContext(context));
    if (!oauthClientAdministrator) {
      throw new AuthenticationError(
        "AUTHENTICATION_UNAVAILABLE",
        "OAuth client management is not configured",
      );
    }
    return context.json(
      { data: await oauthClientAdministrator.list(context.req.raw) },
      200,
    );
  });
  app.openapi(createOAuthClientRoute, async (context) => {
    requirePlatformAdministrator(actorFromContext(context));
    if (!oauthClientAdministrator) {
      throw new AuthenticationError(
        "AUTHENTICATION_UNAVAILABLE",
        "OAuth client management is not configured",
      );
    }
    return context.json(
      {
        data: await oauthClientAdministrator.create(
          context.req.valid("json"),
          context.req.raw,
        ),
      },
      201,
    );
  });
  app.openapi(updateOAuthClientRoute, async (context) => {
    requirePlatformAdministrator(actorFromContext(context));
    if (!oauthClientAdministrator) {
      throw new AuthenticationError(
        "AUTHENTICATION_UNAVAILABLE",
        "OAuth client management is not configured",
      );
    }
    const { clientId } = context.req.valid("param");
    return context.json(
      {
        data: await oauthClientAdministrator.update(
          clientId,
          context.req.valid("json"),
          context.req.raw,
        ),
      },
      200,
    );
  });
  app.openapi(deleteOAuthClientRoute, async (context) => {
    requirePlatformAdministrator(actorFromContext(context));
    if (!oauthClientAdministrator) {
      throw new AuthenticationError(
        "AUTHENTICATION_UNAVAILABLE",
        "OAuth client management is not configured",
      );
    }
    const { clientId } = context.req.valid("param");
    await oauthClientAdministrator.disable(clientId, context.req.raw);
    return context.body(null, 204);
  });
  app.openapi(rotateOAuthClientSecretRoute, async (context) => {
    requirePlatformAdministrator(actorFromContext(context));
    if (!oauthClientAdministrator) {
      throw new AuthenticationError(
        "AUTHENTICATION_UNAVAILABLE",
        "OAuth client management is not configured",
      );
    }
    const { clientId } = context.req.valid("param");
    return context.json(
      {
        data: await oauthClientAdministrator.rotateSecret(
          clientId,
          context.req.raw,
        ),
      },
      200,
    );
  });
}

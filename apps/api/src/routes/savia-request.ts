import { streamingRequest } from "../lib/streaming-request";
import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  actorFromContext,
  requirePlatformAdministrator,
} from "../auth/middleware";
import type { AppActor } from "../auth/types";

export type SaviaRequestService = {
  fetch(request: Request): Promise<Response> | Response;
};

const TENANT_PATTERN = /^tenant:(?:0|[1-9][0-9]*)$/;
const PROXY_PATH = "/v1/savia-request";
const EDITOR_ROLES = new Set([
  "agency_admin",
  "tenant_admin",
  "admin",
  "owner",
]);

function parseTenant(source: URL): string {
  const tenant = source.searchParams.get("tenant")?.trim() ?? "";
  if (!tenant) return "";
  if (
    !TENANT_PATTERN.test(tenant) ||
    !Number.isSafeInteger(Number(tenant.slice(7)))
  )
    throw Response.json(
      { error: { code: "INVALID_TENANT", message: "Tenant inválido." } },
      { status: 400 },
    );
  return tenant;
}

function tenantMatchesMembership(actor: AppActor, tenant: string): boolean {
  const numeric = Number(
    tenant.includes(":") ? tenant.split(":").pop() : tenant,
  );
  return actor.memberships.some(
    (membership) =>
      membership.isActive &&
      (membership.agencyId === numeric || membership.tenantId === numeric),
  );
}

function tenantCanEdit(actor: AppActor, tenant: string): boolean {
  if (actor.globalRoles.includes("platform_admin")) return true;
  const numeric = Number(
    tenant.includes(":") ? tenant.split(":").pop() : tenant,
  );
  return actor.memberships.some(
    (membership) =>
      membership.isActive &&
      (membership.agencyId === numeric || membership.tenantId === numeric) &&
      EDITOR_ROLES.has(membership.role),
  );
}

function isExecutionRequest(method: string, path: string): boolean {
  if (method === "GET") return true;
  return (
    method === "POST" &&
    (/^\/api\/flows\/[^/]+\/runs$/.test(path) ||
      /^\/v1\/flows\/[^/]+\/runs$/.test(path))
  );
}

export function registerSaviaRequestRoutes(
  app: OpenAPIHono,
  db: D1Database,
  service?: SaviaRequestService,
) {
  app.all(`${PROXY_PATH}/*`, async (c) => {
    const actor = actorFromContext(c);
    const source = new URL(c.req.url);
    const path = source.pathname.slice(PROXY_PATH.length);
    let tenant = "";
    try {
      tenant = parseTenant(source);
    } catch (response) {
      return response as Response;
    }
    // Hono routes on the decoded path, including the worker's admin routes.
    if (!tenant || c.req.path.startsWith(`${PROXY_PATH}/api/admin/`)) {
      requirePlatformAdministrator(actor);
    } else if (isExecutionRequest(c.req.method, path)) {
      if (
        !actor.globalRoles.includes("platform_admin") &&
        !tenantMatchesMembership(actor, tenant)
      ) {
        return c.json(
          {
            error: {
              code: "AUTHORIZATION_FORBIDDEN",
              message: "A platform administrator role is required",
            },
          },
          403,
        );
      }
    } else if (!tenantCanEdit(actor, tenant)) {
      return c.json(
        {
          error: {
            code: "AUTHORIZATION_FORBIDDEN",
            message: "A platform administrator role is required",
          },
        },
        403,
      );
    }
    if (!service)
      return c.json(
        {
          error: {
            code: "SAVIA_REQUEST_UNAVAILABLE",
            message: "Savia request no está disponible.",
          },
        },
        503,
      );
    if (!/^\/(api|v1)\//.test(path))
      return c.json(
        { error: { code: "NOT_FOUND", message: "Ruta no encontrada." } },
        404,
      );
    const method = c.req.method;
    if (
      !["GET", "HEAD"].includes(method) &&
      !c.req.header("content-type")?.startsWith("application/json")
    ) {
      return c.json(
        {
          error: {
            code: "UNSUPPORTED_MEDIA_TYPE",
            message: "Usa application/json.",
          },
        },
        415,
      );
    }
    // Forward only the request payload; auth cookies and OAuth tokens stay in Savia.
    // Tenant scope travels as an opaque header the private worker enforces.
    // The principal id travels along for audit attribution (not auth).
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-savia-actor": actor.principal.id,
    };
    if (tenant) {
      // Start the clock before checking activity so a purge during the handoff
      // can be detected even if the private worker receives the request later.
      const startedAt = Date.now();
      const active = await db
        .prepare(
          "SELECT id FROM tenants WHERE id=? AND is_active=1 AND purge_token IS NULL",
        )
        .bind(Number(tenant.slice(7)))
        .first();
      if (!active)
        return c.json(
          {
            error: {
              code: "TENANT_NOT_FOUND",
              message: "El tenant no existe o está inactivo.",
            },
          },
          404,
        );
      headers["x-savia-tenant"] = tenant;
      headers["x-savia-request-started-at"] = String(startedAt);
    }
    const response = await service.fetch(
      streamingRequest(
        "https://savia-request.internal" + path + source.search,
        {
          method,
          headers,
          body: ["GET", "HEAD"].includes(method) ? undefined : c.req.raw.body,
          redirect: "manual",
        },
      ),
    );
    if (!response.ok) {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string")
        return new Response(
          JSON.stringify({
            error: { code: "SAVIA_REQUEST_ERROR", message: body.error },
          }),
          {
            status: response.status,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          },
        );
      return new Response(JSON.stringify(body), {
        status: response.status,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
      });
    }
    const headersOut = new Headers({
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    return new Response(response.body, {
      status: response.status,
      headers: headersOut,
    });
  });
}

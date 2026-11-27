import type { OpenAPIHono } from "@hono/zod-openapi";
import {
  DEFAULT_CANONICAL_HOST,
  isCanonicalOrigin,
  parseTenantSlugFromHostname,
} from "@savia/tenant-host/tenant-host";
import { resolveTenantSlug } from "../tenant-slugs";

/**
 * Internal tenant-home lookup used by the auth worker to redirect an email
 * to its dedicated tenant subdomain (`<slug>.<canonical>`).
 *
 * Only active commercial tenants are routable through public tenant hosts.
 *
 * `GET /_internal/tenants/:id/home?host=<current-hostname>` resolves both
 * the target tenant slug and the tenant (if any) serving the current
 * hostname, using the deployment's canonical host. The login page uses this
 * server-resolved context instead of guessing tenant hosts client-side, so
 * self-hosted canonical domains work without hard-coded host lists.
 * Local development and branch Worker URLs have no tenant subdomains.
 */
export function registerTenantHomeRoutes(
  app: OpenAPIHono,
  db: D1Database,
  bridgeKey?: string,
  canonicalHost: string = DEFAULT_CANONICAL_HOST,
): void {
  app.get("/_internal/tenants/:id/home", async (c) => {
    if (
      !bridgeKey?.trim() ||
      c.req.header("x-savia-bridge-key") !== bridgeKey
    ) {
      return c.json({ error: "Forbidden" }, 401);
    }
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id < 1) {
      return c.json({ error: "Invalid tenant" }, 400);
    }
    const host = c.req.query("host")?.trim().toLowerCase().replace(/\.$/, "");
    const currentSlug = parseTenantSlugFromHostname(host, canonicalHost);
    if (
      host &&
      (host === "workers.dev" ||
        host.endsWith(".workers.dev") ||
        (!currentSlug && !isCanonicalOrigin(`https://${host}`, canonicalHost)))
    ) {
      return c.json(
        { error: "Tenant subdomains are unavailable on this host" },
        404,
      );
    }
    const row = await db
      .prepare(
        "SELECT id_slug AS slug FROM tenants WHERE id=? AND kind='commercial' AND is_active=1 LIMIT 1",
      )
      .bind(id)
      .first<{ slug: string }>();
    if (!row?.slug) {
      return c.json({ error: "Tenant not found" }, 404);
    }
    const current = currentSlug
      ? await resolveTenantSlug(db, currentSlug)
      : null;
    const currentTenantId = current?.id ?? null;
    c.header("cache-control", "no-store");
    return c.json({ id, slug: row.slug, currentSlug, currentTenantId }, 200);
  });
}

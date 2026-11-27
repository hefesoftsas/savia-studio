import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app";
import {
  agencyAdministratorAuthenticator,
  agencyMemberAuthenticator,
  platformAdministratorAuthenticator,
} from "./auth-fixtures";
import type { SaviaRequestService } from "../src/routes/savia-request";
import { seedTenantAgency } from "./tenant-fixtures";

const migrations = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, sql]) => sql);

beforeAll(async () => {
  for (const sql of migrations)
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .replace(/^--.*$/gm, "")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .filter(Boolean))
      await env.DB.exec(statement);
  await seedTenantAgency(env.DB, 101);
  await seedTenantAgency(env.DB, 999);
});

function appFor(
  auth: Parameters<typeof createTestApp>[0]["auth"],
  service?: SaviaRequestService,
) {
  return createTestApp({ auth, saviaRequestService: service });
}

describe("Savia request tenant scope", () => {
  it("lets a tenant admin read its own scope and forwards the tenant header", async () => {
    const before = Date.now();
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-savia-tenant")).toBe("tenant:101");
      expect(request.headers.get("x-savia-actor")).toBe(
        "test-agency-administrator",
      );
      expect(request.url).toBe(
        "https://savia-request.internal/api/flows?tenant=tenant%3A101",
      );
      const startedAt = request.headers.get("x-savia-request-started-at");
      expect(Number(startedAt)).toBeGreaterThanOrEqual(before);
      expect(Number(startedAt)).toBeLessThanOrEqual(Date.now());
      return Response.json([]);
    });
    const response = await appFor(agencyAdministratorAuthenticator(), {
      fetch: fetcher,
    }).request("/v1/savia-request/api/flows?tenant=tenant%3A101", {
      headers: { "x-savia-request-started-at": "9999999999999" },
    });
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("denies cross-tenant access and keeps the legacy platform boundary", async () => {
    const fetcher = vi.fn(() => Response.json([]));
    const app = appFor(agencyAdministratorAuthenticator(), { fetch: fetcher });
    expect(
      (await app.request("/v1/savia-request/api/flows?tenant=tenant%3A999"))
        .status,
    ).toBe(403);
    expect((await app.request("/v1/savia-request/api/flows")).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows members to execute runs but restricts editor mutations to admins", async () => {
    const fetcher = vi.fn(() => Response.json({ ok: true }));
    const memberApp = appFor(agencyMemberAuthenticator(), { fetch: fetcher });
    expect(
      (
        await memberApp.request(
          "/v1/savia-request/api/flows/demo/runs?tenant=tenant%3A101",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: "mock", input: {} }),
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await memberApp.request(
          "/v1/savia-request/api/flows/demo/variables?tenant=tenant%3A101",
          {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify([]),
          },
        )
      ).status,
    ).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("lets platform admins operate in another active tenant scope", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      expect(request.headers.get("x-savia-tenant")).toBe("tenant:999");
      return Response.json({ ok: true });
    });
    const response = await appFor(platformAdministratorAuthenticator(), {
      fetch: fetcher,
    }).request(
      "/v1/savia-request/api/flows/demo/variables?tenant=tenant%3A999",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([]),
      },
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["admin", "%61dmin"])(
    "requires a platform admin for tenant cleanup via the %s route",
    async (segment) => {
      const fetcher = vi.fn(() => Response.json({ tenant: "tenant:101" }));
      const path = `/v1/savia-request/api/${segment}/tenants/tenant:101?tenant=tenant%3A101`;
      const request = {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: "{}",
      };

      const denied = await appFor(agencyAdministratorAuthenticator(), {
        fetch: fetcher,
      }).request(path, request);
      expect(denied.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();

      const allowed = await appFor(platformAdministratorAuthenticator(), {
        fetch: fetcher,
      }).request(path, request);
      expect(allowed.status).toBe(200);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("blocks access even for platform admins when a workspace is inactive or gone", async () => {
    const id = 998;
    await seedTenantAgency(env.DB, id);
    await env.DB.prepare("UPDATE tenants SET is_active=0 WHERE id=?")
      .bind(id)
      .run();
    const fetcher = vi.fn(() => Response.json([]));
    const app = appFor(platformAdministratorAuthenticator(), {
      fetch: fetcher,
    });
    const path = `/v1/savia-request/api/folders?tenant=tenant%3A${id}`;

    expect((await app.request(path)).status).toBe(404);
    await env.DB.prepare("DELETE FROM tenants WHERE id=?").bind(id).run();
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "Late" }),
    });
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid tenant ids", async () => {
    const fetcher = vi.fn(() => Response.json([]));
    const response = await appFor(platformAdministratorAuthenticator(), {
      fetch: fetcher,
    }).request("/v1/savia-request/api/flows?tenant=tenant%2F..%2Fx");
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

import { env } from "cloudflare:workers";
import { beforeAll, expect, it, vi } from "vitest";
import {
  grantMembership,
  loadActor,
  upsertPrincipal,
} from "../src/auth/identity-repository";
import { PagesService } from "../src/pages/service";
import { createApiRuntime } from "../src/runtime";

const migrations = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
).sort(([a], [b]) => a.localeCompare(b));
beforeAll(async () => {
  for (const [, sql] of migrations)
    for (const part of sql.split("--> statement-breakpoint")) {
      const statement = part
        .replace(/^--.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
      if (statement) await env.DB.exec(statement);
    }
});

it("keeps keyword search available and ignores legacy inference bindings", async () => {
  const tenantId = 986501;
  await env.DB.prepare(
    "INSERT INTO tenants(id,id_slug,name,kind,is_active,created_at,updated_at) VALUES(?,'search-fixture','Search fixture','commercial',1,'2026-10-02','2026-10-02')",
  )
    .bind(tenantId)
    .run();
  const principal = await upsertPrincipal(env.DB, {
    issuer: "savia:better-auth",
    subject: "pages-search-owner",
    email: "pages-search-owner@example.test",
    displayName: "Pages Search Owner",
  });
  await grantMembership(env.DB, principal.id, tenantId, "viewer");
  const actor = await loadActor(env.DB, principal);
  const page = await new PagesService(env.DB, actor).create({
    title: "Shared knowledge",
  });

  const bindings = {
    AI: { run: vi.fn() },
    PAGES_VECTORIZE: { query: vi.fn(), upsert: vi.fn(), deleteByIds: vi.fn() },
  };
  const origin = "http://localhost:8787";
  const environment = {
    DB: env.DB,
    DOCUMENTS: env.DOCUMENTS,
    AUTH: {
      async fetch(request: Request) {
        expect(new URL(request.url).pathname).toBe("/_internal/session");
        return Response.json({
          user: {
            id: principal.subject,
            email: principal.email,
            name: principal.displayName,
            role: null,
            twoFactorEnabled: false,
          },
        });
      },
    },
    ...bindings,
  };
  const api = createApiRuntime(environment);
  const request = (path: string, init: RequestInit = {}) =>
    api.fetch(
      new Request(`${origin}${path}`, {
        ...init,
        headers: {
          cookie: "test-session=1",
          origin,
          "content-type": "application/json",
        },
      }),
    );

  const status = await request("/v1/pages/search/status");
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({
    data: { enabled: false, available: false },
  });
  expect((await request("/v1/pages/search?q=knowledge")).status).toBe(403);
  expect((await request("/v1/pages/search?q=")).status).toBe(400);

  await env.DB.prepare(
    "INSERT INTO tenant_pages_search_settings(tenant_id,allowed,enabled,updated_at) VALUES(?,1,1,?)",
  )
    .bind(tenantId, new Date().toISOString())
    .run();
  const enabled = await request("/v1/pages/search/status");
  expect(await enabled.json()).toEqual({
    data: { enabled: true, available: false, total: 0, indexed: 0, needed: [] },
  });
  for (const unavailable of [
    await request("/v1/pages/search?q=knowledge"),
    await request(`/v1/pages/search/index/${page.id}`, { method: "POST" }),
  ]) {
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
    expect(await unavailable.json()).toMatchObject({
      error: { code: "SEARCH_UNAVAILABLE" },
    });
  }

  const saved = await request(`/v1/pages/${page.id}`, {
    method: "PUT",
    body: JSON.stringify({
      title: page.title,
      content: [{ type: "p", children: [{ text: "Searchable notes" }] }],
      version: page.version,
    }),
  });
  expect(saved.status).toBe(200);
  const lexical = await request("/v1/pages?q=Searchable%20notes");
  expect(await lexical.json()).toMatchObject({ data: [{ id: page.id }] });
  expect(bindings.AI.run).not.toHaveBeenCalled();
  expect(bindings.PAGES_VECTORIZE.query).not.toHaveBeenCalled();
  expect(bindings.PAGES_VECTORIZE.upsert).not.toHaveBeenCalled();
});

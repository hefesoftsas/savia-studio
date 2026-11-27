import type { Context } from "hono";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { actorFromContext } from "../auth/middleware";
import { readPagesSearchSettings } from "../pages/search-settings";
import { activeTenant, PagesError } from "../pages/service";
const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
const responses = <T extends z.ZodType>(schema: T) => ({
  200: {
    description: "Semantic Pages search",
    content: { "application/json": { schema: z.object({ data: schema }) } },
  },
  403: {
    description: "Search disabled",
    content: { "application/json": { schema: errorSchema } },
  },
  404: {
    description: "Active workspace unavailable",
    content: { "application/json": { schema: errorSchema } },
  },
  503: {
    description: "Search unavailable",
    content: { "application/json": { schema: errorSchema } },
  },
});
const status = createRoute({
  method: "get",
  path: "/v1/pages/search/status",
  tags: ["Pages"],
  summary: "Get authorized Pages indexing status",
  security: [{ oauth2: ["savia.api.read"] }],
  responses: responses(
    z.object({
      enabled: z.boolean(),
      available: z.boolean(),
      total: z.number(),
      indexed: z.number(),
      needed: z.array(z.string()),
    }),
  ),
});
const index = createRoute({
  method: "post",
  path: "/v1/pages/search/index/{id}",
  tags: ["Pages"],
  summary: "Request semantic indexing for an accessible page",
  security: [{ oauth2: ["savia.api.write"] }],
  request: { params: z.object({ id: z.string().min(1).max(128) }) },
  responses: responses(
    z.object({ id: z.string(), version: z.number(), reused: z.boolean() }),
  ),
});
const summary = z.object({
  id: z.string(),
  kind: z.enum(["page", "folder"]),
  parentId: z.string().nullable(),
  rootId: z.string(),
  title: z.string(),
  version: z.number(),
  updatedAt: z.string(),
  ownerId: z.string(),
  role: z.enum(["owner", "editor", "reader"]),
  isShared: z.boolean(),
  binding: z
    .object({
      domain: z.string(),
      collection: z.string(),
      recordId: z.string(),
    })
    .nullable(),
  score: z.number(),
  excerpt: z.string().max(360).optional(),
});
const search = createRoute({
  method: "get",
  path: "/v1/pages/search",
  tags: ["Pages"],
  summary: "Search accessible Pages semantically",
  security: [{ oauth2: ["savia.api.read"] }],
  request: { query: z.object({ q: z.string().trim().min(1).max(200) }) },
  responses: responses(z.array(summary)),
});
export function registerPagesSearchRoutes(app: OpenAPIHono, db: D1Database) {
  const isEnabled = async (c: Context) => {
    const tenantId = await activeTenant(db, actorFromContext(c));
    return (await readPagesSearchSettings(db, tenantId)).effectiveEnabled;
  };
  const run = async (operation: () => Promise<unknown>) => {
    try {
      return Response.json(
        { data: await operation() },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (error) {
      if (error instanceof PagesError)
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status, headers: { "cache-control": "no-store" } },
        );
      throw error;
    }
  };
  const unavailable = (c: Context) =>
    run(async () => {
      if (!(await isEnabled(c)))
        throw new PagesError(
          403,
          "SEARCH_DISABLED",
          "Semantic search is disabled for this tenant",
        );
      throw new PagesError(
        503,
        "SEARCH_UNAVAILABLE",
        "Semantic search is unavailable",
      );
    });
  app.openapi(status, ((c: Context) =>
    run(async () => ({
      enabled: await isEnabled(c),
      available: false,
      total: 0,
      indexed: 0,
      needed: [],
    }))) as never);
  app.openapi(index, unavailable as never);
  app.openapi(search, unavailable as never);
}

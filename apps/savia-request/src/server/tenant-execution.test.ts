import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { getPlatformProxy } from "wrangler";
import { execute } from "./runner";
import { getFlow, getVariables, seal } from "./store";
import type { Env, HookResult } from "./env";
import type { Flow, Step } from "./types";

let platform: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;

const TENANT_A = "tenant:101";

async function applyMigrations() {
  for (const migration of readdirSync("migrations")
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync("migrations/" + migration, "utf8")
      .split(";")
      .map((statement) =>
        statement.replace(/^.*--> statement-breakpoint.*$/gm, ""),
      )
      .filter((statement) => statement.trim());
    for (const statement of statements)
      await platform.env.DB.prepare(statement).run();
  }
}

beforeAll(async () => {
  platform = await getPlatformProxy({
    configPath: "wrangler.jsonc",
    persist: false,
  });
  await applyMigrations();
  (platform.env as unknown as Record<string, unknown>).ENCRYPTION_KEY =
    Buffer.alloc(32, 7).toString("base64");
});

beforeEach(async () => {
  await platform.env.DB.exec(
    "DELETE FROM flow_variables; DELETE FROM flows; DELETE FROM flow_versions; DELETE FROM flow_runs; DELETE FROM folders; DELETE FROM installed_bundles; DELETE FROM tenant_flows; DELETE FROM tenant_flow_variables; DELETE FROM tenant_flow_versions; DELETE FROM tenant_flow_runs; DELETE FROM tenant_folders; DELETE FROM tenant_bundles; DELETE FROM bundle_flow_state; DELETE FROM savia_request_audit;",
  );
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await platform?.dispose();
});

async function seedSecretFlow() {
  await platform.env.DB.prepare("INSERT INTO flows(id,definition) VALUES(?,?)")
    .bind(
      "secret-flow",
      JSON.stringify({
        id: "secret-flow",
        name: "Secret flow",
        description: "",
        steps: [
          {
            id: "s1",
            name: "paso",
            url: "https://provider.test/q",
            method: "GET",
            headers: { "x-api-key": "{{api_key}}" },
            body: "",
            pre: "",
            post: "",
          },
        ],
        input: {},
        variables: [],
        folderPath: "Base",
      }),
    )
    .run();
  await platform.env.DB.prepare(
    "INSERT INTO flow_variables(flow_id,key,value,secret) VALUES(?,?,?,?)",
  )
    .bind("secret-flow", "api_key", await seal(platform.env, "topsecret"), 1)
    .run();
}

async function seedCacheFlow(
  id: string,
  options: {
    method?: string;
    cache?: unknown;
    header?: string;
    kind?: string;
  } = {},
) {
  const method = options.method ?? "GET";
  await platform.env.DB.prepare("INSERT INTO flows(id,definition) VALUES(?,?)")
    .bind(
      id,
      JSON.stringify({
        id,
        name: "Cache flow",
        description: "",
        ...(options.kind ? { kind: options.kind } : {}),
        steps: [
          {
            id: "read",
            name: "read",
            url: "https://provider.test/cacheable",
            method,
            headers: options.header ? { "x-variant": options.header } : {},
            body: method === "GET" || method === "HEAD" ? "" : "{}",
            bodyType: "json",
            pre: "",
            post: "",
            ...(options.cache === undefined ? {} : { cache: options.cache }),
          },
        ],
        input: {},
        variables: [],
        folderPath: "Base",
      }),
    )
    .run();
}

describe("tenant execution secrets", () => {
  it("uses platform secrets live in tenant scope and redacts them", async () => {
    await seedSecretFlow();
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (request: unknown, init?: { headers?: unknown }) => {
        const requestHeaders: Record<string, string> = {};
        if (request instanceof Request)
          request.headers.forEach((value, key) => {
            requestHeaders[key] = value;
          });
        else Object.assign(requestHeaders, init?.headers);
        seen.push({
          url: request instanceof Request ? request.url : String(request),
          headers: { ...requestHeaders },
        });
        return Response.json({ echo: "topsecret", ok: true });
      }),
    );
    const flow = (await getFlow(platform.env, "secret-flow", TENANT_A))!;
    const run = await execute(platform.env, flow, {}, "live", null, TENANT_A);

    expect(run.status).toBe("success");
    // The platform secret reached the provider in tenant scope.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.headers["x-api-key"]).toBe("topsecret");
    // ...but never leaks into persisted traces or results.
    expect(JSON.stringify(run.steps)).not.toContain("topsecret");
    expect(JSON.stringify(run.result)).not.toContain("topsecret");
  }, 30_000);

  it("keeps masking base secrets on reads while execution decrypts", async () => {
    await seedSecretFlow();
    const masked = await getVariables(
      platform.env,
      "secret-flow",
      true,
      TENANT_A,
    );
    expect(masked).toContainEqual({
      key: "api_key",
      secret: true,
      configured: true,
      overridden: false,
      value: "",
    });
    const executed = await getVariables(
      platform.env,
      "secret-flow",
      true,
      TENANT_A,
      true,
    );
    expect(executed).toContainEqual({
      key: "api_key",
      secret: true,
      configured: true,
      overridden: false,
      value: "topsecret",
    });
  }, 30_000);
});

describe("request destinations computed from hook variables", () => {
  const step: Step = {
    id: "session",
    name: "Start a quote session",
    method: "POST",
    url: "https://provider.test/sessions",
    headers: { "content-type": "application/json" },
    body: "{}",
    bodyType: "json",
    pre: "",
    post: "",
  };
  const quoteFlow: Flow = {
    id: "quote-session",
    name: "Test quote",
    description: "",
    kind: "quote",
    resultPrefix: "sample",
    steps: [],
    variables: [],
    input: {},
  };

  it("quotes using a URL value from the previous response and the current pre-request hook", async () => {
    const fetcher = vi
      .fn<(request: Request) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ reference: "session/7" }))
      .mockResolvedValueOnce(
        Response.json({ reference: "TEST-8", premium: 125000 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const env: Env = {
      ...platform.env,
      HOOK_EXECUTOR: {
        async execute(code, { body, response }): Promise<HookResult> {
          const data = response ? JSON.parse(response) : {};
          if (code.includes('"session_reference"'))
            return { body, variables: { session_reference: data.reference } };
          if (code.includes('"currency"'))
            return { body, variables: { currency: "COP" } };
          return {
            body,
            variables: {
              sample_quote_number: data.reference,
              sample_premium_total: String(data.premium),
            },
          };
        },
      },
    };
    const flow = {
      ...quoteFlow,
      steps: [
        {
          ...step,
          post: 'bru.setVar("session_reference", JSON.parse(res.getBody()).reference);',
        },
        {
          ...step,
          id: "quote",
          name: "Get the quote",
          url: "https://provider.test/sessions/{{session_reference}}/quote?currency={{currency}}",
          pre: 'bru.setVar("currency", "COP");',
          post: 'const data = JSON.parse(res.getBody()); bru.setVar("sample_quote_number", data.reference); bru.setVar("sample_premium_total", data.premium);',
        },
      ],
    };
    const run = await execute(env, flow, {}, "live", null, TENANT_A);
    expect(run).toMatchObject({
      status: "success",
      result: {
        quoteNumber: "TEST-8",
        premiumTotal: "125000",
        currency: "COP",
      },
    });
    expect(fetcher.mock.calls.map(([request]) => request.url)).toEqual([
      "https://provider.test/sessions",
      "https://provider.test/sessions/session%2F7/quote?currency=COP",
    ]);
  });

  it("does not let a hook override the configured origin", async () => {
    const fetcher = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    const env: Env = {
      ...platform.env,
      HOOK_EXECUTOR: {
        async execute(_code, { body }) {
          return { body, variables: { endpoint: "https://other.test/quotes" } };
        },
      },
    };
    const flow = {
      ...quoteFlow,
      input: { endpoint: "https://provider.test/quotes" },
      steps: [
        {
          ...step,
          url: "{{endpoint}}",
          pre: 'bru.setVar("endpoint", "https://other.test/quotes");',
        },
      ],
    };
    const run = await execute(env, flow, flow.input, "live", null, TENANT_A);
    expect(run).toMatchObject({
      status: "failed",
      error: "El hook no puede cambiar el origen del request.",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("flow step request cache", () => {
  it("caches opted-in live GETs and exposes cache metadata in the trace", async () => {
    const id = `cache-flow-${crypto.randomUUID()}`;
    const policy = {
      enabled: true,
      ttlSeconds: 60,
      scope: "tenant",
    } as const;
    await seedCacheFlow(id, { cache: policy });
    const fetcher = vi.fn(async () => Response.json({ cached: true }));
    vi.stubGlobal("fetch", fetcher);
    const flow = (await getFlow(platform.env, id, TENANT_A))!;

    const first = await execute(platform.env, flow, {}, "live", null, TENANT_A);
    const second = await execute(
      platform.env,
      flow,
      {},
      "live",
      null,
      TENANT_A,
    );

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(first.steps[0]).toMatchObject({ cacheStatus: "miss" });
    expect(second.steps[0]).toMatchObject({ cacheStatus: "hit" });
    expect(second.steps[0]?.cacheAgeMs).toEqual(expect.any(Number));
  }, 30_000);

  it("invalidates a cached response when step configuration changes", async () => {
    const id = `cache-revision-${crypto.randomUUID()}`;
    const policy = { enabled: true, ttlSeconds: 60, scope: "tenant" } as const;
    await seedCacheFlow(id, { cache: policy, header: "one" });
    const fetcher = vi.fn(async () => Response.json({ cached: true }));
    vi.stubGlobal("fetch", fetcher);
    const firstFlow = (await getFlow(platform.env, id, TENANT_A))!;
    const changedFlow = {
      ...firstFlow,
      steps: firstFlow.steps.map((step) => ({
        ...step,
        headers: { "x-variant": "two" },
      })),
    };

    const first = await execute(
      platform.env,
      firstFlow,
      {},
      "live",
      null,
      TENANT_A,
    );
    const changed = await execute(
      platform.env,
      changedFlow,
      {},
      "live",
      null,
      TENANT_A,
    );

    expect(first.status).toBe("success");
    expect(changed.status).toBe("success");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.steps[0]).toMatchObject({ cacheStatus: "miss" });
    expect(changed.steps[0]).toMatchObject({ cacheStatus: "miss" });
  }, 30_000);

  it("does not cache writes even if a definition carries a cache policy", async () => {
    const id = `cache-post-${crypto.randomUUID()}`;
    await seedCacheFlow(id, {
      method: "POST",
      cache: { enabled: true, ttlSeconds: 60, scope: "tenant" },
    });
    const fetcher = vi.fn(async () => Response.json({ accepted: true }));
    vi.stubGlobal("fetch", fetcher);
    const flow = (await getFlow(platform.env, id, TENANT_A))!;

    const first = await execute(platform.env, flow, {}, "live", null, TENANT_A);
    const second = await execute(
      platform.env,
      flow,
      {},
      "live",
      null,
      TENANT_A,
    );

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.steps[0]?.cacheStatus).toBeUndefined();
    expect(second.steps[0]?.cacheStatus).toBeUndefined();
  }, 30_000);

  it("never caches authentication flows, even when a GET step opts in", async () => {
    const id = `cache-auth-${crypto.randomUUID()}`;
    await seedCacheFlow(id, {
      kind: "auth",
      cache: { enabled: true, ttlSeconds: 60, scope: "tenant" },
    });
    const fetcher = vi.fn(async () => Response.json({ token: "fresh" }));
    vi.stubGlobal("fetch", fetcher);
    const flow = (await getFlow(platform.env, id, TENANT_A))!;

    const first = await execute(platform.env, flow, {}, "live", null, TENANT_A);
    const second = await execute(
      platform.env,
      flow,
      {},
      "live",
      null,
      TENANT_A,
    );

    expect(first.status).toBe("success");
    expect(second.status).toBe("success");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(first.steps[0]).toMatchObject({ cacheStatus: "bypass" });
    expect(second.steps[0]).toMatchObject({ cacheStatus: "bypass" });
  }, 30_000);

  it("keeps mock executions outside the cache and network", async () => {
    const id = `cache-mock-${crypto.randomUUID()}`;
    await seedCacheFlow(id, {
      cache: { enabled: true, ttlSeconds: 60, scope: "tenant" },
    });
    const fetcher = vi.fn(async () => Response.json({ unexpected: true }));
    vi.stubGlobal("fetch", fetcher);
    const flow = (await getFlow(platform.env, id, TENANT_A))!;

    const run = await execute(platform.env, flow, {}, "mock", null, TENANT_A);

    expect(run.status).toBe("success");
    expect(fetcher).not.toHaveBeenCalled();
    expect(run.steps[0]?.cacheStatus).toBeUndefined();
  }, 30_000);
});

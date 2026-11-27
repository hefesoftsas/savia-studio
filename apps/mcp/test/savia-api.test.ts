import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaviaApiClient } from "../src/savia-api";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

async function testServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => void | Promise<void>,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function requestText(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += String(chunk);
  return body;
}

describe("SaviaApiClient", () => {
  it("forwards a document command through the public Domain API", async () => {
    const received: { url?: string; method?: string; body?: string } = {};
    const baseUrl = await testServer(async (request, response) => {
      received.url = request.url;
      received.method = request.method;
      received.body = await requestText(request);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "900004",
          kind: "agency-profile",
          attributes: { status: "created" },
          relationships: {},
        }),
      );
    });

    const client = new SaviaApiClient(baseUrl);
    const document = await client.executeCommand(
      "agency-network",
      "create-agency",
      { name: "Savia" },
    );

    expect(received).toEqual({
      method: "POST",
      url: "/v1/agency-network/commands/create-agency",
      body: JSON.stringify({ name: "Savia" }),
    });
    expect(document).toEqual(
      expect.objectContaining({ id: "900004", kind: "agency-profile" }),
    );
  });

  it("forwards the configured Better Auth bearer token to the Domain API", async () => {
    let authorization: string | undefined;
    const baseUrl = await testServer((request, response) => {
      authorization = request.headers.authorization;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
    });

    const domains = await new SaviaApiClient(
      baseUrl,
      "better-auth-session-token",
    ).listDomains();

    expect(domains).toEqual([]);
    expect(authorization).toBe("Bearer better-auth-session-token");
  });

  it("returns the Domain API status and safe error when a command is rejected", async () => {
    const baseUrl = await testServer((_request, response) => {
      response.statusCode = 409;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          error: { code: "CONFLICT", message: "Attachment upload expired" },
        }),
      );
    });

    await expect(
      new SaviaApiClient(baseUrl).executeCommand(
        "document-storage",
        "complete-attachment-upload",
        { attachmentId: "00000000-0000-4000-8000-000000000000" },
      ),
    ).rejects.toThrow("409 CONFLICT: Attachment upload expired");
  });

  it("uses fixed caller-owned personal integration operations", async () => {
    const received: Array<{ url?: string; method?: string; body?: string }> =
      [];
    const baseUrl = await testServer(async (request, response) => {
      received.push({
        url: request.url,
        method: request.method,
        body: await requestText(request),
      });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [] }));
    });
    const client = new SaviaApiClient(baseUrl);

    await client.searchPersonalFiles("google_drive", "renewal");
    await client.searchPersonalMessages("gmail", "renewal");
    await client.listPersonalEvents("google_calendar");
    await client.executePersonalAction("approved-personal-action");

    expect(received).toEqual([
      {
        method: "GET",
        url: "/v1/personal-integrations/files?provider=google_drive&query=renewal",
        body: "",
      },
      {
        method: "GET",
        url: "/v1/personal-integrations/messages?provider=gmail&query=renewal",
        body: "",
      },
      {
        method: "GET",
        url: "/v1/personal-integrations/events?provider=google_calendar",
        body: "",
      },
      {
        method: "POST",
        url: "/v1/personal-integrations/actions/approved-personal-action/execute",
        body: "",
      },
    ]);
  });
});

describe("installed CRM collections", () => {
  it("discovers only CRM objects and gates all record operations with metadata", async () => {
    const calls: Array<{
      path: string;
      method: string;
      body: string;
      auth: string | null;
    }> = [];
    const crm = {
      name: "provider_contacts",
      config: { studio: { collection: { kind: "crm" } } },
      fields: [{ name: "email" }],
    };
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (url, init) => {
        const path =
          new URL(String(url)).pathname + new URL(String(url)).search;
        calls.push({
          path,
          method: init?.method ?? "GET",
          body: String(init?.body ?? ""),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({
          data: path.endsWith("/objects") ? [crm, { name: "local" }] : [],
        });
      },
    );
    expect(await client.listStudioCollections()).toEqual({ data: [crm] });
    await client.listStudioRecords("provider_contacts", 2, 10, "a+b");
    await client.getStudioRecord("provider_contacts", "a/b");
    await client.createStudioRecord("provider_contacts", {
      email: "a@test.co",
    });
    await client.updateStudioRecord("provider_contacts", "42", {
      email: "b@test.co",
      _version: 2,
    });
    await client.getStudioRecordLinks("provider_contacts", "42");
    await client.deleteStudioRecord("provider_contacts", "42", 2);
    const operations = calls.filter(
      (c) => c.path.startsWith("/v1/studio/") && !c.path.endsWith("/objects"),
    );
    expect(operations.map((c) => [c.path, c.method, c.body])).toEqual([
      [
        "/v1/studio/0/api/records/provider_contacts?page=2&perPage=10&q=a%2Bb",
        "GET",
        "",
      ],
      ["/v1/studio/0/api/records/provider_contacts/a%2Fb", "GET", ""],
      [
        "/v1/studio/0/api/records/provider_contacts",
        "POST",
        '{"email":"a@test.co"}',
      ],
      [
        "/v1/studio/0/api/records/provider_contacts/42",
        "PATCH",
        '{"email":"b@test.co","_version":2}',
      ],
      ["/v1/studio/0/api/record-links/provider_contacts/42", "GET", ""],
      ["/v1/studio/0/api/records/provider_contacts/42?version=2", "DELETE", ""],
    ]);
    expect(calls.every((c) => c.auth === "Bearer caller")).toBe(true);
    const before = operations.length;
    for (const object of ["local", "missing", "../objects"]) {
      await expect(client.createStudioRecord(object, {})).rejects.toThrow();
      await expect(client.getStudioRecord(object, "42")).rejects.toThrow();
    }
    expect(
      calls.filter(
        (c) => c.path.startsWith("/v1/studio/") && !c.path.endsWith("/objects"),
      ),
    ).toHaveLength(before);
  });
});

it("discovers and queries authorized collections hidden only from navigation", async () => {
  const paths: string[] = [];
  const client = new SaviaApiClient(
    "https://api.test",
    "caller",
    async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith("/objects")
          ? {
              data: [
                {
                  name: "cotizaciones",
                  label: "Cotizaciones",
                  count: 1,
                  config: {
                    studio: { screen: { hidden: true } },
                    fields: { name: { type: "Textbox" } },
                  },
                },
              ],
            }
          : { data: [{ id: "quote-1", name: "COT-1" }], total: 1 },
      );
    },
  );
  expect((await client.listStudioCollections({ all: true })).data).toEqual([
    expect.objectContaining({ name: "cotizaciones", recordCount: 1 }),
  ]);
  expect(await client.listStudioRecords("cotizaciones", { page: 1 })).toEqual({
    data: [{ id: "quote-1", name: "COT-1" }],
    total: 1,
  });
  expect(paths).toContain("/v1/studio/0/api/records/cotizaciones");
});

it("uses live HubSpot records and totals instead of the catalog's local count", async () => {
  const calls: string[] = [];
  let summaryTotal: unknown = 6;
  let summaryFailure: (() => Response) | undefined;
  let listTotal: number | undefined;
  let records = [{ id: "1" }];
  let hasNextPage = true;
  let nextCursor: string | undefined;
  const client = new SaviaApiClient(
    "https://api.test",
    "caller",
    async (url, init) => {
      const { pathname, search } = new URL(String(url));
      calls.push(pathname + search);
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer caller",
      );
      if (pathname.endsWith("/active-tenant"))
        return Response.json({ activeTenantId: 14 });
      if (pathname.endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: "hubspot_contacts",
              count: 0,
              config: {
                studio: { collection: { kind: "crm", sourceId: "hubspot" } },
              },
            },
            { name: "local_contacts", count: 0 },
          ],
        });
      if (pathname.endsWith("/summary"))
        return (
          summaryFailure?.() ?? Response.json({ data: [], total: summaryTotal })
        );
      return Response.json({
        data: records,
        pageInfo: { hasNextPage },
        nextCursor,
        total: listTotal,
      });
    },
  );

  expect((await client.listStudioCollections({ all: true })).data).toEqual([
    expect.objectContaining({
      name: "hubspot_contacts",
      recordCount: null,
      sourceId: "hubspot",
    }),
    expect.objectContaining({ name: "local_contacts", recordCount: 0 }),
  ]);
  expect((await client.listStudioCollections()).data[0].count).toBeNull();
  expect(
    await client.listStudioRecords("hubspot_contacts", { perPage: 1 }),
  ).toMatchObject({
    data: [{ id: "1" }],
    pageInfo: { hasNextPage: true },
    total: null,
  });
  listTotal = 0;
  expect(
    await client.listStudioRecords("hubspot_contacts", { perPage: 1 }),
  ).toMatchObject({
    data: [{ id: "1" }],
    total: null,
  });
  listTotal = 1;
  expect(
    await client.listStudioRecords("hubspot_contacts", { perPage: 1 }),
  ).toMatchObject({ total: null });
  records = [];
  listTotal = 0;
  expect(
    await client.listStudioRecords("hubspot_contacts", { perPage: 1 }),
  ).toMatchObject({ data: [], total: null });
  hasNextPage = false;
  nextCursor = "another-page";
  expect(
    await client.listStudioRecords("hubspot_contacts", { perPage: 1 }),
  ).toMatchObject({ data: [], total: null });
  nextCursor = undefined;
  expect(
    await client.listStudioRecords("hubspot_contacts", { perPage: 1 }),
  ).toMatchObject({ data: [], total: 0 });
  expect(await client.aggregateStudioRecords("hubspot_contacts")).toEqual({
    total: 6,
  });
  const emptyFilters = { logic: "and", conditions: [] };
  expect(
    await client.listStudioRecords("hubspot_contacts", {
      filters: emptyFilters,
    }),
  ).toMatchObject({ total: 0, data: [] });
  expect(calls.at(-1)).not.toContain("filters=");
  expect(
    await client.aggregateStudioRecords("hubspot_contacts", {
      filters: emptyFilters,
    }),
  ).toEqual({ total: 6 });
  expect(calls).toContain("/v1/studio/14/api/records/hubspot_contacts/summary");
  summaryTotal = undefined;
  expect(await client.aggregateStudioRecords("hubspot_contacts")).toEqual({
    total: null,
  });
  summaryTotal = "0";
  expect(await client.aggregateStudioRecords("hubspot_contacts")).toEqual({
    total: null,
  });
  summaryFailure = () =>
    Response.json(
      { error: { code: "CRM_UNAVAILABLE", message: "Provider unavailable" } },
      { status: 502 },
    );
  await expect(
    client.aggregateStudioRecords("hubspot_contacts"),
  ).rejects.toThrow("502 CRM_UNAVAILABLE: Provider unavailable");
  const retryAfter = new Date(Date.now() + 60_000).toUTCString();
  summaryFailure = () =>
    Response.json(
      { error: "HubSpot alcanzó el límite de solicitudes." },
      { status: 429, headers: { "Retry-After": retryAfter } },
    );
  await expect(
    client.aggregateStudioRecords("hubspot_contacts"),
  ).rejects.toThrow(
    `429 API_ERROR: HubSpot alcanzó el límite de solicitudes. Retry after ${new Date(retryAfter).toISOString()}.`,
  );
  await expect(
    client.aggregateStudioRecords("hubspot_contacts", {
      groupBy: "lifecyclestage",
      filters: {
        conditions: [{ field: "lifecyclestage", op: "eq", value: "lead" }],
      },
    }),
  ).rejects.toThrow("do not support structured filters");
});

it.each([
  { page: { data: [{ id: "1" }], total: 6 }, total: 6 },
  { page: { data: [{ id: "1" }], total: 0 }, total: null },
  {
    page: { data: [{ id: "1" }], total: 1, pageInfo: { hasNextPage: true } },
    total: null,
  },
  { page: { data: [], total: 0, hasNext: true }, total: null },
  { page: { data: [], total: 0, nextCursor: "next-page" }, total: null },
  { page: { data: [], total: 0 }, total: 0 },
])(
  "uses the same verified total for listing and aggregating $page",
  async ({ page, total }) => {
    const queries: URLSearchParams[] = [];
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/active-tenant"))
          return Response.json({ activeTenantId: 14 });
        if (url.pathname.endsWith("/objects"))
          return Response.json({ data: [{ name: "contacts" }] });
        expect(url.pathname).toBe("/v1/studio/14/api/records/contacts");
        queries.push(url.searchParams);
        return Response.json(page);
      },
    );
    const filters = {
      conditions: [{ field: "status", op: "eq", value: "lead" }],
    };
    expect(await client.listStudioRecords("contacts", { filters })).toEqual({
      ...page,
      total,
    });
    expect(
      await client.aggregateStudioRecords("contacts", { filters }),
    ).toEqual({
      total,
    });
    expect(queries).toHaveLength(2);
    expect(queries[1]?.get("perPage")).toBe("1");
    expect(
      queries.every(
        (query) => query.get("filters") === JSON.stringify(filters),
      ),
    ).toBe(true);
  },
);

it.each([null, { total: 0, data: null }, { total: 0 }])(
  "rejects an incomplete record page instead of returning an empty CRM result: %j",
  async (page) => {
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/active-tenant"))
          return Response.json({ activeTenantId: 14 });
        if (path.endsWith("/objects"))
          return Response.json({ data: [{ name: "contacts" }] });
        return Response.json(page);
      },
    );
    await expect(client.listStudioRecords("contacts", {})).rejects.toThrow(
      /record page/,
    );
    await expect(client.aggregateStudioRecords("contacts")).rejects.toThrow(
      /record page/,
    );
  },
);

it.each(["headers", "body"])(
  "times out a HubSpot read stalled while waiting for %s",
  async (stage) => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => {});
    let signal: AbortSignal | null | undefined;
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/active-tenant"))
          return Response.json({ activeTenantId: 14 });
        if (path.endsWith("/objects"))
          return Response.json({ data: [{ name: "hubspot_contacts" }] });
        signal = init?.signal;
        if (stage === "headers") return stalled;
        return Object.assign(new Response(), { json: () => stalled });
      },
    );
    try {
      const result = client
        .listStudioRecords("hubspot_contacts", {})
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      expect(await result).toMatchObject({
        name: "RequestTimeoutError",
        timeoutMs: 15_000,
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([{ status: 429, retryAfter: "60" }, { status: 502 }])(
  "preserves HTTP $status if the error body stalls",
  async ({ status, retryAfter }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-27T10:00:00Z"));
    const stalled = new Promise<never>(() => {});
    let signal: AbortSignal | null | undefined;
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (_input, init) => {
        signal = init?.signal;
        return Object.assign(
          new Response(null, {
            status,
            headers: retryAfter ? { "Retry-After": retryAfter } : {},
          }),
          { json: () => stalled },
        );
      },
    );

    try {
      const result = client.listEmployees().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(signal?.aborted).toBe(true);
      const retry = retryAfter ? " Retry after 2026-11-27T10:01:00.000Z." : "";
      expect(await result).toMatchObject({
        message: `${status} API_ERROR: Domain API request failed${retry}`,
      });
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["update", "delete"] as const)(
  "does not try to %s a Studio record after the required revision read times out",
  async (action) => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => {});
    const methods: string[] = [];
    let signal: AbortSignal | null | undefined;
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/active-tenant"))
          return Response.json({ activeTenantId: 14 });
        if (path.endsWith("/objects"))
          return Response.json({ data: [{ name: "contacts" }] });
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method !== "GET") return Response.json({ data: {} });
        signal = init?.signal;
        return stalled;
      },
    );
    try {
      const result = (
        action === "update"
          ? client.updateStudioRecord(
              "contacts",
              "1",
              { name: "Example" },
              true,
            )
          : client.deleteStudioRecord("contacts", "1", undefined, true)
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(signal?.aborted).toBe(true);
      expect(await result).toMatchObject({ name: "RequestTimeoutError" });
      expect(methods).toEqual(["GET"]);
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([
  { status: 403, detail: "No access to this record" },
  { status: 502, detail: "HubSpot did not complete the read" },
])(
  "stops record changes when the revision read returns $status",
  async ({ status, detail }) => {
    const methods: string[] = [];
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/active-tenant"))
          return Response.json({ activeTenantId: 14 });
        if (path.endsWith("/objects"))
          return Response.json({ data: [{ name: "contacts" }] });
        const method = init?.method ?? "GET";
        methods.push(method);
        if (method === "GET")
          return Response.json({ error: detail }, { status });
        return Response.json({ data: {} });
      },
    );

    const message = `${status} API_ERROR: ${detail}`;
    await expect(
      client.updateStudioRecord("contacts", "1", { name: "Example" }, true),
    ).rejects.toThrow(message);
    await expect(
      client.deleteStudioRecord("contacts", "1", undefined, true),
    ).rejects.toThrow(message);
    expect(methods).toEqual(["GET", "GET"]);
  },
);

it.each([
  { label: "an empty response", record: null },
  { label: "an empty record", record: { data: null, _version: 4 } },
  {
    label: "a record without an identifier",
    record: { data: { _version: 4 } },
  },
  { label: "a different record", record: { data: { id: "2", _version: 4 } } },
  { label: "a null revision", record: { data: { id: "1", _version: null } } },
  { label: "an invalid revision", record: { id: "1", _version: 0 } },
])("stops record changes when the API returns $label", async ({ record }) => {
  const methods: string[] = [];
  const client = new SaviaApiClient(
    "https://api.test",
    "caller",
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/active-tenant"))
        return Response.json({ activeTenantId: 14 });
      if (path.endsWith("/objects"))
        return Response.json({ data: [{ name: "contacts" }] });
      const method = init?.method ?? "GET";
      methods.push(method);
      return Response.json(method === "GET" ? record : { data: {} });
    },
  );

  await expect(
    client.updateStudioRecord("contacts", "1", { name: "Example" }, true),
  ).rejects.toThrow(/Studio record response/);
  await expect(
    client.deleteStudioRecord("contacts", "1", undefined, true),
  ).rejects.toThrow(/Studio record response/);
  expect(methods).toEqual(["GET", "GET"]);
});

it.each([
  { record: { data: { id: "1", _version: 7 } }, version: 7 },
  { record: { id: "1", _version: 3, data: { note: "Example" } }, version: 3 },
  { record: { data: { id: 1 }, _version: 4 }, version: 4 },
  { record: { data: { id: "1" } }, version: 1 },
])(
  "uses revision $version after a successful record read",
  async ({ record, version }) => {
    const operations: string[] = [];
    const client = new SaviaApiClient(
      "https://api.test",
      "caller",
      async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/active-tenant"))
          return Response.json({ activeTenantId: 14 });
        if (url.pathname.endsWith("/objects")) {
          operations.push("objects");
          return Response.json({ data: [{ name: "contacts" }] });
        }
        const method = init?.method ?? "GET";
        operations.push(method);
        if (method === "GET") return Response.json(record);
        if (method === "PATCH")
          expect(JSON.parse(String(init?.body))._version).toBe(version);
        if (method === "DELETE")
          expect(url.searchParams.get("version")).toBe(String(version));
        return Response.json({ data: {} });
      },
    );

    await client.updateStudioRecord("contacts", "1", { name: "Example" }, true);
    await client.deleteStudioRecord("contacts", "1", undefined, true);
    expect(operations).toEqual([
      "objects",
      "GET",
      "PATCH",
      "objects",
      "GET",
      "DELETE",
    ]);
  },
);

it("does not report local counts as totals for connected and request-backed screens", async () => {
  const client = new SaviaApiClient(
    "https://api.test",
    "caller",
    async (url) => {
      if (String(url).endsWith("/active-tenant"))
        return Response.json({ activeTenantId: 14 });
      return Response.json({
        data: [
          { name: "local", count: 0 },
          {
            name: "salesforce_contacts",
            count: 0,
            config: {
              studio: { collection: { kind: "crm", sourceId: "salesforce" } },
            },
          },
          {
            name: "database_contacts",
            count: 2,
            config: {
              studio: {
                collection: { kind: "postgres", sourceId: "postgres" },
              },
            },
          },
          {
            name: "request_contacts",
            count: 0,
            config: { studio: { requestPage: { flowId: "contacts" } } },
          },
        ],
      });
    },
  );
  expect((await client.listStudioCollections({ all: true })).data).toEqual([
    expect.objectContaining({ name: "local", recordCount: 0 }),
    expect.objectContaining({ name: "salesforce_contacts", recordCount: null }),
    expect.objectContaining({ name: "database_contacts", recordCount: null }),
    expect.objectContaining({ name: "request_contacts", recordCount: null }),
  ]);
  expect((await client.listStudioCollections()).data).toEqual([
    expect.objectContaining({ name: "salesforce_contacts", count: null }),
  ]);
});

it("requests an ungrouped HubSpot sum and rejects an unsupported ungrouped local sum", async () => {
  const calls: string[] = [];
  const sum = { data: [{ value: null, count: 2, amount: 150 }], total: 2 };
  const client = new SaviaApiClient(
    "https://api.test",
    "caller",
    async (url) => {
      const { pathname, search } = new URL(String(url));
      calls.push(pathname + search);
      if (pathname.endsWith("/active-tenant"))
        return Response.json({ activeTenantId: 14 });
      if (pathname.endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: "hubspot_deals",
              config: {
                studio: { collection: { kind: "crm", sourceId: "hubspot" } },
              },
            },
            { name: "local_deals" },
          ],
        });
      return Response.json(sum);
    },
  );
  await expect(
    client.aggregateStudioRecords("hubspot_deals", { amountField: "amount" }),
  ).resolves.toEqual(sum);
  expect(calls).toContain(
    "/v1/studio/14/api/records/hubspot_deals/summary?amountField=amount",
  );
  await expect(
    client.aggregateStudioRecords("local_deals", { amountField: "amount" }),
  ).rejects.toThrow(/groupBy/i);
  expect(calls.some((path) => path.includes("/records/local_deals"))).toBe(
    false,
  );
});

it("rejects optional quote operations without sending network requests", async () => {
  const client = new SaviaApiClient("https://api.test", "caller", async () => {
    throw new Error("Unexpected network request");
  });

  await expect(client.getQuoteSummary("COT-1")).rejects.toMatchObject({
    name: "OptionalCapabilityUnavailableError",
  });
  await expect(client.createServiceQuote({})).rejects.toMatchObject({
    name: "OptionalCapabilityUnavailableError",
  });
});

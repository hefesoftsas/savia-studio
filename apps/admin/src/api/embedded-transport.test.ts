import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "./api-client";
import { createEmbeddedTransport } from "./embedded-transport";
import { REQUEST_TIMEOUT_MS } from "./request-timeout";
describe("embedded module transport", () => {
  it("preserves binary responses and version headers while using the authenticated API", async () => {
    let request: Request | undefined;
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async (input, init) => {
        request = new Request(input, init);
        return new Response("a,b\n1,2", {
          headers: { "content-type": "text/csv" },
        });
      },
    });
    const transport = createEmbeddedTransport(api, "/v1/dynamic-crm/101");
    const response = await transport("/api/export/contact", {
      headers: { Accept: "text/csv", "Idempotency-Key": "key" },
    });
    expect(request?.url).toBe(
      "https://savia.test/v1/dynamic-crm/101/api/export/contact",
    );
    expect(request?.headers.get("authorization")).toBe("Bearer test");
    expect(request?.headers.get("accept")).toBe("text/csv");
    expect(await response.text()).toBe("a,b\n1,2");
  });
  it("rejects foreign URLs and encoded path traversal", async () => {
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: {
        getAccessToken: async () => {
          throw new Error("must not request token");
        },
      },
    });
    const transport = createEmbeddedTransport(api, "/v1/dynamic-crm/101");
    for (const path of [
      "https://evil.test/api/x",
      "//evil.test/api/x",
      "/api/../x",
      "/api/%2e%2e/x",
      "/api/%252e%252e/x",
    ])
      expect((await transport(path, {})).status).toBe(400);
  });
  it.each(["70%", "En espera...", "Zona\\Norte"])(
    "forwards %s in the search query without interpreting it as a route",
    async (query) => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        expect(new URL(String(input)).searchParams.get("q")).toBe(query);
        return new Response("name\r\n", {
          headers: { "Content-Type": "text/csv" },
        });
      });
      const api = new ApiClient({
        baseUrl: "https://savia.test",
        tokenSource: { getAccessToken: async () => "test" },
        fetcher,
      });

      const response = await createEmbeddedTransport(
        api,
        "/v1/studio/12",
      )(`/api/export/contacts?${new URLSearchParams({ q: query })}`);

      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
});

it("allows document analysis to exceed the ordinary API timeout without extending other requests", async () => {
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => "test" },
    fetcher: async () => Response.json({ data: {} }),
  });
  const request = vi.spyOn(api, "requestResponseWithBody");
  const transport = createEmbeddedTransport(api, "/v1/studio/12");
  await transport("/api/extensions/example.documents/document-analysis", {
    method: "POST",
  });
  expect(request).toHaveBeenLastCalledWith(
    "/v1/studio/12/api/extensions/example.documents/document-analysis",
    { method: "POST" },
    expect.any(Function),
    90000,
  );
  await transport("/api/records/items", { method: "GET" });
  expect(request).toHaveBeenLastCalledWith(
    "/v1/studio/12/api/records/items",
    { method: "GET" },
    expect.any(Function),
    undefined,
  );
});

it("preserves safe document retry metadata through normalized errors", async () => {
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => "test" },
    fetcher: async () =>
      Response.json(
        {
          error: {
            code: "ANALYSIS_PROVIDER_UNAVAILABLE",
            message: "Retry",
            fileId: "550e8400-e29b-41d4-a716-446655440000",
          },
        },
        { status: 502 },
      ),
  });
  const response = await createEmbeddedTransport(api, "/v1/studio/12")(
    "/api/extensions/example.documents/document-analysis",
    { method: "POST" },
  );
  expect(await response.json()).toMatchObject({
    error: "Retry",
    code: "ANALYSIS_PROVIDER_UNAVAILABLE",
    fileId: "550e8400-e29b-41d4-a716-446655440000",
  });
});

it("includes the problem detail in errors returned to embedded modules", async () => {
  const problem = {
    title: "Conflict",
    detail: "Reload the record before saving again.",
  };
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => "test" },
    fetcher: async () =>
      Response.json(problem, {
        status: 409,
        headers: { "content-type": "application/problem+json" },
      }),
  });
  const response = await createEmbeddedTransport(
    api,
    "/v1/studio/12",
  )("/api/records/items");
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ ...problem, error: problem.detail });
});

it("preserves the server's retry delay when normalizing a JSON error", async () => {
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => "test" },
    fetcher: async () =>
      Response.json(
        { error: { message: "Too many requests" } },
        {
          status: 429,
          headers: { "Retry-After": "30" },
        },
      ),
  });
  const response = await createEmbeddedTransport(
    api,
    "/v1/studio/12",
  )("/api/records/items");
  expect(response.status).toBe(429);
  expect(response.headers.get("Retry-After")).toBe("30");
  expect(await response.json()).toEqual({ error: "Too many requests" });
});

it.each([
  { body: "", status: 403 },
  { body: "null", status: 409 },
  { body: "invalid JSON", status: 429 },
  { body: '{"error":{"message":17}}', status: 502 },
])(
  "preserves HTTP $status when the error has no usable message",
  async ({ body, status }) => {
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async () =>
        new Response(body, {
          status,
          headers: { "content-type": "application/json" },
        }),
    });
    const response = await createEmbeddedTransport(
      api,
      "/v1/studio/12",
    )("/api/records/items");
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({
      error: "No se pudo completar la operación.",
    });
  },
);

it.each([
  "/api/extensions/service.quotes/actions/quote",
  "/api/crm-workspace/install",
])("lets a slow POST to %s finish", async (path) => {
  vi.useFakeTimers();
  try {
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async () => {
        await new Promise((resolve) => setTimeout(resolve, 35_000));
        return Response.json({ data: { completed: true } });
      },
    });
    const result = createEmbeddedTransport(api, "/v1/studio/12")(path, {
      method: "POST",
    });

    await vi.advanceTimersByTimeAsync(35_000);
    const response = await result;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { completed: true },
    });
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { reason: "timeout", status: 403 },
  { reason: "timeout", status: 429 },
  { reason: "caller abort", status: 502 },
])(
  "stops reading a stalled HTTP $status body after $reason",
  async ({ reason, status }) => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const abortReason = new Error("Screen closed");
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(new TextEncoder().encode('{"error":'));
            },
          }),
          {
            status,
            headers: {
              "content-type": "application/json",
              ...(status === 429 ? { "Retry-After": "30" } : {}),
            },
          },
        );
      },
    );
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher,
    });
    try {
      const completed = vi.fn();
      const rejected = vi.fn();
      const request = createEmbeddedTransport(api, "/v1/studio/12")(
        "/api/records/items",
        { signal: caller.signal },
      ).then(completed, rejected);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledOnce();
      if (reason === "caller abort") {
        caller.abort(abortReason);
        await vi.advanceTimersByTimeAsync(0);
        expect(rejected).toHaveBeenCalledWith(abortReason);
        expect(completed).not.toHaveBeenCalled();
      } else {
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(completed).toHaveBeenCalledWith(
          expect.objectContaining({ status }),
        );
        const response = completed.mock.calls[0][0] as Response;
        expect(response.headers.get("Retry-After")).toBe(
          status === 429 ? "30" : null,
        );
        expect(await response.json()).toEqual({
          error: "No se pudo completar la operación.",
        });
        expect(rejected).not.toHaveBeenCalled();
      }
      expect(requestSignal?.aborted).toBe(true);
      await request;
    } finally {
      stream?.close();
      vi.useRealTimers();
    }
  },
);

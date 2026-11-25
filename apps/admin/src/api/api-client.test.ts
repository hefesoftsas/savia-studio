import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiClientError } from "./api-client";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "./request-timeout";

describe("ApiClient", () => {
  it("adds a bearer token to Savia requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "quote-1" } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => "access-token" },
      fetcher,
    });

    await expect(
      client.get<{ data: { id: string } }>("/v1/quotes"),
    ).resolves.toEqual({
      data: { id: "quote-1" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/v1/quotes",
      expect.any(Object),
    );
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    const headers = new Headers(request.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer access-token");
  });

  it("maps Savia error envelopes to typed errors", async () => {
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => null },
      fetcher: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "AUTHORIZATION_FORBIDDEN", message: "Forbidden" },
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        ),
      ),
    });

    const request = client.get("/v1/domains");
    await expect(request).rejects.toBeInstanceOf(ApiClientError);
    try {
      await request;
    } catch (error) {
      expect(error).toMatchObject({
        status: 403,
        code: "AUTHORIZATION_FORBIDDEN",
        message: "Forbidden",
      });
    }
  });

  it("surfaces string-valued server error envelopes", async () => {
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => null },
      fetcher: vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "Connected assistant required" },
            { status: 409 },
          ),
        ),
    });

    await expect(
      client.get("/v1/whatsapp/native/assets?agencyId=101"),
    ).rejects.toMatchObject({
      status: 409,
      code: "HTTP_409",
      message: "Connected assistant required",
    });
  });

  it("reads JSON:API documents with a case-insensitive media type", async () => {
    const data = { data: { type: "contacts", id: "contact-1" } };
    const client = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async () =>
        Response.json(data, {
          headers: {
            "content-type": "Application/Vnd.Api+Json; charset=utf-8",
          },
        }),
    });
    await expect(client.get("/v1/contacts")).resolves.toEqual(data);
  });

  it("accepts no-content responses that still declare a JSON media type", async () => {
    const client = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async () =>
        new Response(null, {
          status: 204,
          headers: { "content-type": "application/vnd.api+json" },
        }),
    });
    await expect(
      client.delete("/v1/contacts/contact-1"),
    ).resolves.toBeUndefined();
  });

  it("surfaces the problem detail while keeping the actual HTTP status", async () => {
    const problem = {
      title: "Conflict",
      detail: "Reload the record before saving again.",
      status: 400,
    };
    const client = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async () =>
        Response.json(problem, {
          status: 409,
          headers: { "content-type": "application/problem+json" },
        }),
    });
    await expect(client.get("/v1/contacts")).rejects.toMatchObject({
      status: 409,
      code: "HTTP_409",
      message: problem.detail,
      details: problem,
    });
  });

  it.each(["", '{"error":'] as const)(
    "preserves the HTTP status when an error response claims JSON but returns %j",
    async (body) => {
      const client = new ApiClient({
        baseUrl: "http://127.0.0.1:8787",
        tokenSource: { getAccessToken: async () => null },
        fetcher: vi.fn().mockResolvedValue(
          new Response(body, {
            status: 503,
            headers: { "content-type": "application/json" },
          }),
        ),
      });

      await expect(client.get("/v1/tenants")).rejects.toMatchObject({
        status: 503,
        code: "HTTP_503",
        message: "Request failed",
        details: null,
      });
    },
  );

  it.each([200, 403, 429])(
    "keeps the meaning of HTTP %s when its JSON body stalls",
    async (status) => {
      vi.useFakeTimers();
      try {
        const now = Date.now();
        const fetcher = vi.fn(
          async (_url: RequestInfo | URL, init?: RequestInit) =>
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode('{"error":'));
                  init?.signal?.addEventListener(
                    "abort",
                    () => {
                      controller.error(init.signal?.reason);
                    },
                    { once: true },
                  );
                },
              }),
              {
                status,
                headers: {
                  "Content-Type": "application/json",
                  "Retry-After": "30",
                },
              },
            ),
        );
        const client = new ApiClient({
          baseUrl: "https://savia.test",
          tokenSource: { getAccessToken: async () => "test" },
          fetcher,
        });
        const rejected = vi.fn();
        void client.request("/v1/domains", {}, 100).catch(rejected);
        await vi.advanceTimersByTimeAsync(100);
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining(
            status === 200
              ? { status: 0, code: "REQUEST_TIMEOUT" }
              : {
                  status,
                  code: `HTTP_${status}`,
                  retryAt: status === 429 ? now + 30_000 : undefined,
                },
          ),
        );
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([200, 403, 429])(
    "keeps the meaning of HTTP %s when the response stream disconnects",
    async (status) => {
      const disconnect = new TypeError("Connection closed mid-response");
      const client = new ApiClient({
        baseUrl: "https://savia.test",
        tokenSource: { getAccessToken: async () => "test" },
        fetcher: async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(disconnect);
              },
            }),
            {
              status,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "30",
              },
            },
          ),
      });
      const result = client.get("/v1/domains");
      if (status === 200) {
        await expect(result).rejects.toBe(disconnect);
      } else {
        await expect(result).rejects.toMatchObject({
          status,
          code: `HTTP_${status}`,
          retryAt: status === 429 ? expect.any(Number) : undefined,
        });
      }
    },
  );

  it("calls the browser fetch function with its global receiver", async () => {
    const browserFetch = vi.fn(function (this: typeof globalThis) {
      if (this !== globalThis) throw new Error("fetch lost its receiver");
      return Promise.resolve(
        new Response(JSON.stringify({ data: [] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => null },
    });

    await expect(client.get("/v1/domains")).resolves.toEqual({ data: [] });
    vi.unstubAllGlobals();
  });

  it("rejects an HTML application shell returned as a successful API response", async () => {
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => null },
      fetcher: async () =>
        new Response("<!doctype html><title>Savia Studio</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    });

    await expect(client.get("/v1/tenants")).rejects.toMatchObject({
      status: 200,
      code: "UNEXPECTED_HTML_RESPONSE",
    });
    const response = await client.requestResponse("/v1/page-preview");
    await expect(response.text()).resolves.toContain(
      "<title>Savia Studio</title>",
    );
  });

  it("accepts a successful API deletion without a response body", async () => {
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => null },
      fetcher: async () => new Response(null, { status: 204 }),
    });

    await expect(client.delete("/v1/tenants/101")).resolves.toBeUndefined();
  });

  it("sends authenticated JSON PUT requests", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ saved: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => "access-token" },
      fetcher,
    });

    await expect(
      client.put<{ saved: boolean }>("/v1/assistant/configuration/global", {
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual({ saved: true });

    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("PUT");
    expect(request.body).toBe(JSON.stringify({ model: "openai/gpt-5" }));
  });

  it.each(["post", "patch", "put"] as const)(
    "preserves caller-provided HeadersInit values on JSON %s requests",
    async (method) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({ saved: true }),
      );
      const client = new ApiClient({
        baseUrl: "http://127.0.0.1:8787",
        tokenSource: { getAccessToken: async () => "access-token" },
        fetcher,
      });
      const entries: [string, string][] = [
        ["If-Match", '"version-2"'],
        ["content-type", "application/merge-patch+json"],
      ];
      const inputs: HeadersInit[] = [
        new Headers(entries),
        entries,
        Object.fromEntries(entries),
      ];
      for (const headers of inputs) {
        const request = client[method](
          "/v1/tenants/101",
          { isActive: false },
          { headers },
        );
        await expect(request).resolves.toEqual({ saved: true });
        const outgoing = new Headers(fetcher.mock.lastCall?.[1]?.headers);
        expect(outgoing.get("If-Match")).toBe('"version-2"');
        expect(outgoing.get("Content-Type")).toBe(
          "application/merge-patch+json",
        );
        expect(outgoing.get("Authorization")).toBe("Bearer access-token");
        expect(new Headers(headers).has("Authorization")).toBe(false);
      }
    },
  );

  it("sends authenticated multipart uploads without overriding the boundary content type", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { mediaId: "123" } }));
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:8787",
      tokenSource: { getAccessToken: async () => "access-token" },
      fetcher,
    });
    const form = new FormData();
    form.append("file", new File(["image"], "photo.png"));
    await expect(
      client.postForm("/v1/whatsapp/native/media", form),
    ).resolves.toEqual({
      data: { mediaId: "123" },
    });
    const request = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(request.body).toBe(form);
    expect(new Headers(request.headers).get("Authorization")).toBe(
      "Bearer access-token",
    );
    expect(new Headers(request.headers).has("Content-Type")).toBe(false);
  });

  it("starts a response request timeout after access-token refresh", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(new Response("audio"));
      const client = new ApiClient({
        baseUrl: "http://127.0.0.1:8787",
        tokenSource: {
          getAccessToken: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "access-token";
          },
        },
        fetcher,
      });

      const response = client.requestResponse(
        "/v1/companion/sessions/audio",
        {},
        100,
      );
      const outcome = response.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(200);

      await expect(outcome).resolves.toEqual({ value: expect.any(Response) });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a JSON request timeout after access-token refresh", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
      const client = new ApiClient({
        baseUrl: "http://127.0.0.1:8787",
        tokenSource: {
          getAccessToken: async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return "access-token";
          },
        },
        fetcher,
      });

      const response = client.get("/v1/domains");
      const outcome = response.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.advanceTimersByTimeAsync(200);

      await expect(outcome).resolves.toEqual({ value: { ok: true } });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["JSON", "raw response"])(
    "times out %s requests that are still waiting for an access token",
    async (kind) => {
      vi.useFakeTimers();
      try {
        let releaseToken!: (token: string) => void;
        const token = new Promise<string>((resolve) => {
          releaseToken = resolve;
        });
        const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
        const client = new ApiClient({
          baseUrl: "https://savia.test",
          tokenSource: { getAccessToken: () => token },
          fetcher,
        });
        const rejected = vi.fn();
        const completed = vi.fn();
        const request =
          kind === "JSON"
            ? client.get("/v1/domains")
            : client.requestResponse("/v1/domains");
        void request.then(completed, rejected);
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

        expect(rejected).toHaveBeenCalledOnce();
        if (kind === "JSON") {
          expect(rejected).toHaveBeenCalledWith(
            expect.objectContaining({ code: "REQUEST_TIMEOUT" }),
          );
        } else {
          expect(rejected).toHaveBeenCalledWith(
            expect.any(RequestTimeoutError),
          );
        }
        releaseToken("late-token");
        await vi.advanceTimersByTimeAsync(0);
        expect(completed).not.toHaveBeenCalled();
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "/v1/domains",
    "/v1/agency-network/agency-profiles?limit=10",
    "/v1/customer-portfolio/commands/update-customer-profile",
    "/v1/reference-values/identification-types",
    "/v1/service-catalog/products",
  ])(
    "keeps tenant path %s on the core worker with authentication",
    async (path) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [] }));
      const client = new ApiClient({
        baseUrl: "http://127.0.0.1:5173",
        tokenSource: { getAccessToken: async () => "token" },
        fetcher,
      });
      await client.get(path);
      expect(fetcher.mock.calls[0][0]).toBe(`http://127.0.0.1:5173${path}`);
      const init = fetcher.mock.calls[0][1] as RequestInit;
      expect(init.credentials).toBe("include");
      expect(new Headers(init.headers).get("Authorization")).toBe(
        "Bearer token",
      );
    },
  );

  it.each([
    "/api/records/contacts",
    "/v1/crm/connections",
    "/v1/domains-other",
    "/v1/assistant/configuration/global",
  ])("keeps generic %s on core", async (path) => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ data: [] }));
    const client = new ApiClient({
      baseUrl: "http://127.0.0.1:5173",
      tokenSource: { getAccessToken: async () => null },
      fetcher,
    });
    await client.get(path);
    expect(fetcher.mock.calls[0][0]).toBe(`http://127.0.0.1:5173${path}`);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "@/api/request-timeout";
import { beginLogout } from "@/auth/logout-progress";
import { rotateSessionScope } from "@/auth/session-scope";
import { apiFetch, dataProvider, downloadCrm } from "../api";
import { setStudioRuntime } from "../runtime";

afterEach(() => {
  setStudioRuntime({ embedded: false });
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it.each(["30", "Wed, 01 Jan 2031 12:00:30 GMT", "invalid"])(
    "keeps a valid rate-limit deadline from %s",
    async (retryAfter) => {
      const now = Date.parse("2031-01-01T12:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(now);
      const request = apiFetch("/api/records/contacts", undefined, async () =>
        Response.json(
          { error: "Rate limit" },
          {
            status: 429,
            headers: { "Retry-After": retryAfter },
          },
        ),
      );
      await expect(request).rejects.toMatchObject({
        status: 429,
        retryAt: retryAfter === "invalid" ? undefined : now + 30_000,
      });
    },
  );

  it.each([200, 403])(
    "stops reading a stalled JSON response with status %s",
    async (status) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
          cancel,
        }),
        { status, headers: { "Content-Type": "application/json" } },
      );
      const rejected = vi.fn();
      try {
        void apiFetch(
          "/api/records/contacts",
          undefined,
          async () => response,
        ).catch(rejected);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(cancel).toHaveBeenCalledOnce();
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining(
            status === 200 ? { name: "RequestTimeoutError" } : { status },
          ),
        );
      } finally {
        if (!cancel.mock.calls.length) stream?.close();
        vi.useRealTimers();
      }
    },
  );

  const customHeaders = {
    "content-type": "application/merge-patch+json",
    "Idempotency-Key": "test-key",
  };
  it.each([
    { format: "a Headers object", input: new Headers(customHeaders) },
    { format: "a tuple list", input: Object.entries(customHeaders) },
    { format: "a record", input: customHeaders },
  ])("preserves caller-supplied headers in $format", async ({ input }) => {
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/merge-patch+json");
      expect(headers.get("idempotency-key")).toBe("test-key");
      return Response.json({ data: {} });
    });
    await apiFetch(
      "/api/records/contacts/1",
      {
        method: "PATCH",
        headers: input,
        body: "{}",
      },
      transport,
    );
  });

  it("leaves the multipart boundary to the browser without mutating the caller headers", async () => {
    const headers = new Headers({ Accept: "application/json" });
    const body = new FormData();
    body.set("name", "Contact");
    const transport = vi.fn(async (_url: string, init?: RequestInit) => {
      const finalHeaders = new Headers(init?.headers);
      expect(finalHeaders.get("Accept")).toBe("application/json");
      expect(finalHeaders.has("Content-Type")).toBe(false);
      return Response.json({ data: {} });
    });
    await apiFetch(
      "/api/import/contacts",
      { method: "POST", headers, body },
      transport,
    );
    expect([...headers]).toEqual([["accept", "application/json"]]);
  });

  it("accepts a successful empty response", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 204 }));
    setStudioRuntime({ embedded: true, transport });

    await expect(apiFetch("/api/extensions/test")).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledWith(
      "/api/extensions/test",
      expect.any(Object),
    );
  });

  it("rejects an HTML sign-in page where a JSON result is expected", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
    await expect(
      apiFetch("/api/records/contacts", undefined, async () => response),
    ).rejects.toMatchObject({
      status: 200,
      code: "UNEXPECTED_HTML_RESPONSE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("preserves HTML files requested explicitly as blobs", async () => {
    const html = "<p>Attachment</p>";
    const response = await apiFetch<Blob>(
      "/api/files/report",
      { responseType: "blob" },
      async () =>
        new Response(html, { headers: { "Content-Type": "text/html" } }),
    );
    expect(await response.text()).toBe(html);
  });

  it.each(["time out", "abort", "abort before reading"] as const)(
    "cancels a pending attachment stream on %s",
    async (termination) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const abortReason = new DOMException("Download cancelled", "AbortError");
      const cancel = vi.fn();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const rejected = vi.fn();
      try {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(Uint8Array.of(1));
            },
            cancel,
          }),
        );
        void apiFetch<Blob>(
          "/api/files/report",
          { responseType: "blob", signal: caller.signal },
          async () => {
            if (termination === "abort before reading")
              caller.abort(abortReason);
            return response;
          },
        ).catch(rejected);
        await vi.advanceTimersByTimeAsync(0);
        if (termination === "abort") caller.abort(abortReason);
        await vi.advanceTimersByTimeAsync(
          termination === "time out" ? REQUEST_TIMEOUT_MS : 0,
        );
        const reason =
          termination === "time out"
            ? expect.any(RequestTimeoutError)
            : abortReason;
        expect(rejected).toHaveBeenCalledWith(reason);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
      } finally {
        if (!cancel.mock.calls.length) stream?.close();
        vi.useRealTimers();
      }
    },
  );

  it("keeps an attachment downloading while bytes arrive within each deadline", async () => {
    vi.useFakeTimers();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    try {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(Uint8Array.of(1));
          },
        }),
        { headers: { "Content-Type": "application/pdf" } },
      );
      const result = apiFetch<Blob>(
        "/api/files/report",
        { responseType: "blob" },
        async () => response,
      );
      void result.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1_000);
      stream.enqueue(Uint8Array.of(2));
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1_000);
      stream.enqueue(Uint8Array.of(3));
      stream.close();
      const blob = await result;
      expect(blob.type).toBe("application/pdf");
      expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the problem detail for direct Studio API errors", async () => {
    const problem = { title: "Conflict", detail: "Reload the current record." };
    await expect(
      apiFetch("/api/records/contacts/1", undefined, async () =>
        Response.json(problem, {
          status: 409,
          headers: { "Content-Type": "application/problem+json" },
        }),
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: problem.detail,
      detail: problem,
    });
  });
});

it.each([
  new Response("Forbidden", { status: 403 }),
  new Response(null, { status: 401 }),
])("preserves authorization status for non-JSON failures", async (response) => {
  setStudioRuntime({ embedded: true, transport: async () => response });
  await expect(apiFetch("/api/records/private")).rejects.toMatchObject({
    status: response.status,
  });
});

describe("downloadCrm", () => {
  it("discards late download headers when the account changes", async () => {
    let finishDownload!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finishDownload = resolve;
    });
    const transport = vi.fn((_path: string, _init?: RequestInit) => pending);
    setStudioRuntime({ embedded: true, transport });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    const download = downloadCrm(
      "/api/export/contacts",
      "contacts.csv",
      "text/csv",
    );

    rotateSessionScope("principal-change");
    finishDownload(
      new Response("name\r\nAna\r\n", {
        headers: { "Content-Type": "text/csv" },
      }),
    );

    expect(await download).toBe(false);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "cancels a pending CSV body on logout with useBodyDeadline=%s",
    async (useBodyDeadline) => {
      const cancel = vi.fn();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode("name\r\n"));
          },
          cancel,
        }),
        { headers: { "Content-Type": "text/csv" } },
      );
      setStudioRuntime({ embedded: true, transport: async () => response });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});
      const download = downloadCrm(
        "/api/export/contacts",
        "contacts.csv",
        "text/csv",
        {
          useBodyDeadline,
        },
      );
      try {
        await vi.waitFor(() => expect(response.body?.locked).toBe(true));
        rotateSessionScope("logout");
        await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce(), {
          timeout: 250,
        });
        expect(await download).toBe(false);
        expect(click).not.toHaveBeenCalled();
      } finally {
        if (!cancel.mock.calls.length) stream.close();
        await download.catch(() => undefined);
      }
    },
  );

  it("does not start a download while logout is pending", async () => {
    const transport = vi.fn(async () => new Response("file"));
    setStudioRuntime({ embedded: true, transport });
    const finishLogout = beginLogout();
    try {
      await expect(
        downloadCrm("/api/file/file-id/download", "file"),
      ).resolves.toBe(false);
      expect(transport).not.toHaveBeenCalled();
    } finally {
      finishLogout();
    }
  });

  it.each([200, 429])(
    "stops a CSV download that stalls after sending HTTP %s",
    async (status) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      setStudioRuntime({
        embedded: true,
        transport: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                controller.enqueue(new TextEncoder().encode("name\r\n"));
              },
              cancel,
            }),
            {
              status,
              headers: {
                "Content-Type":
                  status === 200 ? "text/csv" : "application/json",
              },
            },
          ),
      });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => {});
      const failed = vi.fn();
      try {
        const download = downloadCrm(
          "/api/export/contacts",
          "contacts.csv",
          "text/csv",
        );
        void download.catch(failed);
        await vi.advanceTimersByTimeAsync(15_000);
        expect(failed).toHaveBeenCalledWith(
          expect.objectContaining(
            status === 200 ? { name: "RequestTimeoutError" } : { status },
          ),
        );
        expect(cancel).toHaveBeenCalledOnce();
        expect(click).not.toHaveBeenCalled();
      } finally {
        if (!cancel.mock.calls.length) stream?.close();
        vi.useRealTimers();
      }
    },
  );

  it("downloads a CSV response with a charset", async () => {
    const transport = vi.fn(
      async () =>
        new Response("name\r\nAna\r\n", {
          headers: { "Content-Type": "text/csv; charset=utf-8" },
        }),
    );
    setStudioRuntime({ embedded: true, transport });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        expect(this.download).toBe("contacts.csv");
      });

    await expect(
      downloadCrm("/api/export/contacts", "contacts.csv", "text/csv"),
    ).resolves.toBe(true);

    expect(click).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith("/api/export/contacts", {
      headers: { Accept: "text/csv" },
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    new Response("<html>Sign in</html>", {
      headers: { "Content-Type": "text/html" },
    }),
    new Response(null, { status: 204 }),
  ])(
    "rejects a successful response that does not contain CSV",
    async (response) => {
      setStudioRuntime({ embedded: true, transport: async () => response });

      await expect(
        downloadCrm("/api/export/contacts", "contacts.csv", "text/csv"),
      ).rejects.toThrow("No se recibió un archivo CSV válido.");
    },
  );

  it.each([
    [
      new Response("Bad Gateway", { status: 502 }),
      "No se pudo descargar el archivo.",
    ],
    [
      Response.json(
        { error: { message: "Export forbidden" } },
        { status: 403 },
      ),
      "Export forbidden",
    ],
    [
      Response.json(
        {
          title: "Unavailable",
          detail: "The export is temporarily unavailable.",
        },
        {
          status: 503,
          headers: { "Content-Type": "application/problem+json" },
        },
      ),
      "The export is temporarily unavailable.",
    ],
  ] as const)("reports readable download errors", async (response, message) => {
    setStudioRuntime({ embedded: true, transport: async () => response });

    await expect(
      downloadCrm("/api/export/contacts", "contacts.csv"),
    ).rejects.toMatchObject({
      message,
      status: response.status,
    });
  });
});

it("keeps a record ID with punctuation intact across reads, updates and deletion", async () => {
  const record = { id: "order#2026?", name: "Order", _version: 4 };
  const transport = vi.fn(async (path: string, init?: RequestInit) => {
    const url = new URL(path, "https://savia.test");
    if (decodeURIComponent(url.pathname) !== `/api/records/orders/${record.id}`)
      return Response.json({ error: "Record not found" }, { status: 404 });
    if (init?.method === "DELETE")
      expect(url.searchParams.get("version")).toBe("4");
    return Response.json({ data: record });
  });
  setStudioRuntime({ embedded: true, transport });

  await expect(
    dataProvider.getOne("orders", { id: record.id }),
  ).resolves.toMatchObject({ data: record });
  await expect(
    dataProvider.getMany("orders", { ids: [record.id] }),
  ).resolves.toMatchObject({ data: [record] });
  await expect(
    dataProvider.update("orders", {
      id: record.id,
      data: { name: "Edited" },
      previousData: record,
    }),
  ).resolves.toMatchObject({ data: record });
  await expect(
    dataProvider.delete("orders", { id: record.id, previousData: record }),
  ).resolves.toMatchObject({ data: record });
  expect(transport.mock.calls.map(([, init]) => init?.method)).toEqual([
    "GET",
    "GET",
    "PATCH",
    "DELETE",
  ]);
});

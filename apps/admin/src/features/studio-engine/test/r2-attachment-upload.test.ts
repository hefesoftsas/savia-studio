// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient } from "@/api/api-client";
import { createEmbeddedTransport } from "@/api/embedded-transport";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "@/api/request-timeout";
import { rotateSessionScope } from "@/auth/session-scope";
import { setStudioRuntime } from "../runtime";
import {
  attachTemporaryR2Attachments,
  deleteTemporaryR2Attachments,
  uploadR2Attachments,
  uploadTemporaryR2Attachment,
} from "../r2-attachment-upload";

afterEach(() => {
  vi.unstubAllGlobals();
  setStudioRuntime({ embedded: false });
});

it.each([false, true])(
  "keeps a pending association in its originating workspace (account changed: %s)",
  async (accountChanged) => {
    const draft = {
      id: "draft-1",
      field: "contract",
      name: "contract.pdf",
      mime: "application/pdf",
      size: 8,
      version: 1,
      expiresAt: "2026-09-10T00:00:00.000Z",
    };
    let confirmFirst!: (response: Response) => void;
    const waiting = new Promise<Response>((resolve) => {
      confirmFirst = resolve;
    });
    const origin = vi
      .fn()
      .mockReturnValueOnce(waiting)
      .mockResolvedValueOnce(Response.json({ data: { id: "draft-2" } }));
    const next = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { id: "draft-2" } }));
    setStudioRuntime({ embedded: true, tenantId: 1, transport: origin });
    const result = attachTemporaryR2Attachments("record-1", [
      draft,
      { ...draft, id: "draft-2" },
    ]);

    setStudioRuntime({ embedded: true, tenantId: 2, transport: next });
    if (accountChanged) rotateSessionScope("principal-change");
    confirmFirst(Response.json({ data: { id: "draft-1" } }));

    if (accountChanged) {
      await expect(result).rejects.toMatchObject({ name: "AbortError" });
      expect(origin).toHaveBeenCalledOnce();
    } else {
      await expect(result).resolves.toBeUndefined();
      expect(origin.mock.calls.map(([path]) => path)).toEqual([
        "/api/file-drafts/draft-1/attach",
        "/api/file-drafts/draft-2/attach",
      ]);
    }
    expect(next).not.toHaveBeenCalled();
  },
);

it("limits background cleanup to the requested temporary file", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  await deleteTemporaryR2Attachments([
    {
      id: "draft-1",
      field: "contract",
      name: "contract.pdf",
      mime: "application/pdf",
      size: 8,
      version: 1,
      expiresAt: "2026-09-10T00:00:00.000Z",
    },
  ]);

  const [[path, init]] = fetcher.mock.calls;
  expect(path).toBe("/api/file/draft-1");
  expect(init.method).toBe("DELETE");
  expect(JSON.parse(init.body as string)).toEqual({
    version: 1,
    draftOnly: true,
  });
});

it("cancels an upload waiting for credentials when the account changes", async () => {
  vi.stubGlobal("window", new EventTarget());
  let returnToken!: (token: string) => void;
  const waiting = new Promise<string>((resolve) => {
    returnToken = resolve;
  });
  const getAccessToken = vi.fn(() => waiting);
  const fetcher = vi.fn();
  const client = new ApiClient({
    baseUrl: "https://localhost",
    tokenSource: { getAccessToken },
    fetcher,
  });
  setStudioRuntime({
    embedded: true,
    transport: createEmbeddedTransport(client, "/v1/tenants/1/studio"),
  });
  const uploading = uploadTemporaryR2Attachment(
    "contracts",
    "contract",
    new File(["test"], "contract.pdf"),
  );
  expect(getAccessToken).toHaveBeenCalledOnce();
  const rejected = expect(uploading).rejects.toMatchObject({
    name: "AbortError",
  });
  rotateSessionScope("principal-change");
  returnToken("fixture-token");
  await rejected;
  expect(fetcher).not.toHaveBeenCalled();
});

it("retries a stalled association before continuing with pending attachments", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  try {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller;
          controller.enqueue(new TextEncoder().encode('{"data":'));
        },
        cancel,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce(Response.json({ data: { id: "draft-1" } }))
      .mockResolvedValueOnce(Response.json({ data: { id: "draft-2" } }));
    vi.stubGlobal("fetch", fetcher);
    const attachments = [
      {
        id: "draft-1",
        field: "contract",
        name: "contract.pdf",
        mime: "application/pdf",
        size: 8,
        version: 1,
        expiresAt: "2026-09-10T00:00:00.000Z",
      },
      {
        id: "draft-2",
        field: "photo",
        name: "photo.png",
        mime: "image/png",
        size: 9,
        version: 1,
        expiresAt: "2026-09-10T00:00:00.000Z",
      },
    ];
    const rejected = vi.fn();
    void attachTemporaryR2Attachments("record-1", attachments).catch(rejected);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    expect(rejected).toHaveBeenCalledWith(expect.any(RequestTimeoutError));
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();

    await attachTemporaryR2Attachments("record-1", attachments);
    expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
      "/api/file-drafts/draft-1/attach",
      "/api/file-drafts/draft-1/attach",
      "/api/file-drafts/draft-2/attach",
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        recordId: "record-1",
        version: 1,
      });
    }
  } finally {
    if (!cancel.mock.calls.length) stream?.close();
    vi.useRealTimers();
  }
});

it("uploads each pending R2 attachment with its configured field", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: { id: "file-1" } }));
  vi.stubGlobal("fetch", fetcher);
  const file = new File(["contract"], "contract.pdf", {
    type: "application/pdf",
  });

  await uploadR2Attachments("contracts", "record-1", [
    { field: "contract", files: [file] },
  ]);

  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    "/api/files/contracts/record-1",
  );
  const init = fetcher.mock.calls[0]?.[1] as RequestInit;
  const body = init.body as FormData;
  expect(init.method).toBe("POST");
  expect(body.get("field")).toBe("contract");
  expect(body.get("file")).toBe(file);
});

it.each([
  ["createRequestKey", "new-record-key"],
  ["recordId", "saved-record"],
] as const)(
  "uploads a temporary attachment with its %s",
  async (targetField, value) => {
    const fetcher = vi.fn(async () =>
      Response.json({
        data: {
          id: "temporary-file-1",
          name: "contract.pdf",
          mime: "application/pdf",
          size: 8,
          field: "contract",
          version: 1,
          expiresAt: "2026-09-10T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const file = new File(["contract"], "contract.pdf", {
      type: "application/pdf",
    });

    const attachment = await uploadTemporaryR2Attachment(
      "contracts",
      "contract",
      file,
      targetField === "recordId"
        ? { recordId: value }
        : { createRequestKey: value },
    );

    expect(attachment).toMatchObject({
      id: "temporary-file-1",
      field: "contract",
      version: 1,
    });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      "/api/file-drafts/contracts",
    );
    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    const body = init.body as FormData;
    expect(init.method).toBe("POST");
    expect(body.get("field")).toBe("contract");
    expect(body.get("file")).toBe(file);
    expect(body.get(targetField)).toBe(value);
  },
);

it("reports completed files before a later upload fails so only the failed file stays queued", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: { id: "file-1" } }))
    .mockResolvedValueOnce(
      Response.json({ error: "R2 no está disponible" }, { status: 503 }),
    );
  vi.stubGlobal("fetch", fetcher);
  const onStatus = vi.fn();
  const first = new File(["first"], "first.pdf", { type: "application/pdf" });
  const second = new File(["second"], "second.pdf", {
    type: "application/pdf",
  });

  await expect(
    uploadR2Attachments(
      "contracts",
      "record-1",
      [{ field: "contract", files: [first, second] }],
      onStatus,
    ),
  ).rejects.toThrow("R2 no está disponible");

  expect(onStatus).toHaveBeenCalledWith({
    field: "contract",
    file: first,
    status: "uploaded",
  });
  expect(onStatus).toHaveBeenNthCalledWith(1, {
    field: "contract",
    file: first,
    status: "uploading",
  });
  expect(onStatus).toHaveBeenNthCalledWith(3, {
    field: "contract",
    file: second,
    status: "uploading",
  });
  expect(onStatus).not.toHaveBeenCalledWith({
    field: "contract",
    file: second,
    status: "uploaded",
  });
});

it.each(["temporary", "saved"] as const)(
  "releases a %s attachment upload when confirmation stalls",
  async (type) => {
    vi.useFakeTimers();
    const rejected = vi.fn();
    const cancel = vi.fn();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    try {
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode('{"data":'));
          },
          cancel,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
      const fetcher = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetcher);
      const file = new File(["content"], "contract.pdf");
      const onStatus = vi.fn();
      const upload =
        type === "temporary"
          ? uploadTemporaryR2Attachment("contracts", "contract", file)
          : uploadR2Attachments(
              "contracts",
              "record-1",
              [{ field: "contract", files: [file] }],
              onStatus,
            );
      void upload.catch(rejected);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      expect(rejected).toHaveBeenCalledWith(expect.any(RequestTimeoutError));
      expect(cancel).toHaveBeenCalledExactlyOnceWith(
        expect.any(RequestTimeoutError),
      );
      expect(fetcher).toHaveBeenCalledOnce();
      if (type === "saved") {
        expect(onStatus).toHaveBeenCalledExactlyOnceWith({
          field: "contract",
          file,
          status: "uploading",
        });
      }
    } finally {
      if (!cancel.mock.calls.length) stream?.close();
      vi.useRealTimers();
    }
  },
);

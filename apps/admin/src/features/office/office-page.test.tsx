import { afterEach, it, expect, vi } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { OfficePage } from "./office-page";
import { loadOfficeEngine } from "./office-engine";
import { OfficeApi, type OfficeMetadata } from "./office-api";
vi.mock("./office-engine", () => ({ loadOfficeEngine: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const editableDocument: OfficeMetadata = {
  id: "file-1",
  name: "policy.docx",
  mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  version: 1,
  size: 2,
  field: null,
  object: null,
  recordId: null,
  maxSize: 500000,
  readOnly: false,
};
it("reports denied access without starting the office engine", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Denied" }, { status: 403 })),
  );
  render(<OfficePage search="?base=%2Fv1%2Fdynamic-crm%2F1&file=file-1" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("permiso");
  expect(loadOfficeEngine).not.toHaveBeenCalled();
});

it("opens readers without edit actions and downloads the original bytes", async () => {
  let events: { onDirty(): void; onSave?(): void } | undefined;
  const open = vi.fn(async () => {});
  const save = vi.fn(async () => new Uint8Array([9, 9]));
  vi.mocked(loadOfficeEngine).mockImplementation(async (_canvas, callbacks) => {
    events = callbacks;
    return { open, save, dispose: vi.fn() };
  });
  const requests: { url: string; method?: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method });
      if (url.endsWith("/office"))
        return Response.json({
          data: {
            id: "file-1",
            name: "policy.docx",
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            version: 2,
            size: 2,
            maxSize: 500000,
            readOnly: true,
          },
        });
      if (url.endsWith("/revisions"))
        return Response.json({
          data: [{ version: 1, size: 2, created_at: "2026-09-19" }],
        });
      if (url.endsWith("/revisions/1/download"))
        return new Response(new Uint8Array([3, 4]));
      return new Response(new Uint8Array([1, 2]));
    }),
  );
  const createObjectURL = vi.fn((_blob: Blob) => "blob:reader-copy");
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL }));
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  render(<OfficePage search="?base=%2Fv1%2Fdynamic-crm%2F1&file=file-1" />);

  await waitFor(() => expect(open).toHaveBeenCalled());
  expect(open).toHaveBeenCalledWith(new Uint8Array([1, 2]), "policy.docx", {
    readOnly: true,
  });
  expect(screen.queryByRole("button", { name: "Guardar" })).toBeNull();
  events!.onDirty();
  events!.onSave?.();
  fireEvent.keyDown(window, { key: "s", ctrlKey: true });
  expect(screen.queryByText("Cambios sin guardar")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  expect(requests.some((request) => request.method === "POST")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Descargar copia" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
  const originalBlob = createObjectURL.mock.calls[0][0] as Blob;
  expect([...new Uint8Array(await originalBlob.arrayBuffer())]).toEqual([1, 2]);

  fireEvent.click(screen.getByRole("button", { name: "Descargar versión 1" }));
  await waitFor(() => expect(click).toHaveBeenCalledTimes(2));
  const historyBlob = createObjectURL.mock.calls[1][0] as Blob;
  expect([...new Uint8Array(await historyBlob.arrayBuffer())]).toEqual([3, 4]);
});

it("refuses API saves for read-only metadata", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const api = new OfficeApi("/v1/office-documents", "file-1");
  await expect(
    api.save(
      {
        id: "file-1",
        name: "policy.docx",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 2,
        version: 1,
        field: null,
        object: null,
        recordId: null,
        maxSize: 500000,
        readOnly: true,
      },
      new Uint8Array([1, 2]),
    ),
  ).rejects.toThrow(/solo lectura/i);
  expect(fetcher).not.toHaveBeenCalled();
});

it("retains a recovery download and dirty state after a conflicting save", async () => {
  let dirty = () => {};
  vi.mocked(loadOfficeEngine).mockImplementation(async (_canvas, events) => {
    dirty = events.onDirty;
    return {
      open: async () => {},
      save: async () => new Uint8Array([1, 2]),
      dispose: () => {},
    };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      const url = String(input);
      if (init?.method === "POST")
        return Response.json(
          { error: "Hay una versión más reciente" },
          { status: 409 },
        );
      if (url.endsWith("/office"))
        return Response.json({
          data: {
            id: "file-1",
            name: "policy.docx",
            mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            version: 1,
            size: 2,
            maxSize: 500000,
            readOnly: false,
          },
        });
      if (url.endsWith("/revisions"))
        return Response.json({
          data: [{ version: 1, size: 2, created_at: "2026-09-19" }],
        });
      return new Response(new Uint8Array([1, 2]));
    }),
  );
  render(<OfficePage search="?base=%2Fv1%2Fdynamic-crm%2F1&file=file-1" />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Descargar copia" }),
    ).toBeEnabled(),
  );
  dirty();
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("versión");
  expect(screen.getByRole("button", { name: "Descargar copia" })).toBeEnabled();
  expect(screen.getByText("Cambios sin guardar")).toBeInTheDocument();
  expect(screen.getByText("Versión 1")).toBeInTheDocument();
});

it.each(["headers", "body"])(
  "releases a save when the response %s stall",
  async (phase) => {
    vi.useFakeTimers();
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestSignal: AbortSignal | null | undefined;
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input, init: RequestInit) => {
          requestSignal = init.signal;
          if (phase === "headers") return new Promise<Response>(() => {});
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                stream = controller;
                controller.enqueue(new TextEncoder().encode('{"data":'));
              },
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }),
      );
      const rejected = vi.fn();
      const api = new OfficeApi("/v1/office-documents", "file-1");
      void api.save(editableDocument, new Uint8Array([3, 4])).catch(rejected);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(requestSignal?.aborted).toBe(true);
      expect(rejected).toHaveBeenCalledOnce();
    } finally {
      stream?.close();
      vi.useRealTimers();
    }
  },
);

it("recognizes a previously saved revision and keeps newer edits pending", async () => {
  let dirty = () => {};
  const first = new Uint8Array([3, 4]);
  const newer = new Uint8Array([5, 6]);
  const save = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce(newer);
  vi.mocked(loadOfficeEngine).mockImplementation(async (_canvas, events) => {
    dirty = events.onDirty;
    return { open: async () => {}, save, dispose: () => {} };
  });
  const uploadedVersions: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST") {
        uploadedVersions.push(String((init.body as FormData).get("version")));
        if (uploadedVersions.length === 1) throw new TypeError("Lost response");
        return Response.json({ data: { version: 3 } }, { status: 201 });
      }
      if (path.endsWith("/office"))
        return Response.json({ data: editableDocument });
      if (path.endsWith("/revisions/2/download")) return new Response(first);
      if (path.endsWith("/revisions")) return Response.json({ data: [] });
      return new Response(new Uint8Array([1, 2]));
    }),
  );
  render(<OfficePage search="?base=%2Fv1%2Foffice-documents&file=file-1" />);
  const saveButton = () => screen.getByRole("button", { name: "Guardar" });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Descargar copia" }),
    ).toBeEnabled(),
  );
  dirty();
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "confirmar el guardado",
  );
  expect(saveButton()).toBeEnabled();
  dirty();
  fireEvent.click(saveButton());
  await screen.findByText("Versión 2");
  expect(uploadedVersions).toEqual(["1"]);
  expect(save).toHaveBeenCalledOnce();
  expect(screen.getByText("Cambios sin guardar")).toBeInTheDocument();
  await waitFor(() => expect(saveButton()).toBeEnabled());
  fireEvent.click(saveButton());
  await screen.findByText("Versión 3");
  expect(uploadedVersions).toEqual(["1", "2"]);
  expect(save).toHaveBeenCalledTimes(2);
  expect(saveButton()).toBeDisabled();
});

it.each(["unavailable", "malformed"] as const)(
  "keeps saving while the history is %s and can refresh it independently",
  async (historyProblem) => {
    let dirty = () => {};
    vi.mocked(loadOfficeEngine).mockImplementation(async (_canvas, events) => {
      dirty = events.onDirty;
      return {
        open: async () => {},
        save: async () => new Uint8Array([3, 4]),
        dispose: () => {},
      };
    });
    const revision = (version: number) => ({
      version,
      size: 2,
      created_at: "2026-11-25T12:00:00Z",
      created_by: null,
    });
    let requests = 0;
    let staleSignal: AbortSignal | null | undefined;
    let finishStale = (_response: Response) => {};
    const writes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init: RequestInit) => {
        const path = String(input);
        if (init?.method === "POST") {
          const expected = String((init.body as FormData).get("version"));
          writes.push(expected);
          return Response.json(
            { data: { version: Number(expected) + 1 } },
            { status: 201 },
          );
        }
        if (path.endsWith("/office"))
          return Response.json({ data: editableDocument });
        if (path.endsWith("/revisions")) {
          requests++;
          if (requests === 1) return Response.json({ data: [revision(1)] });
          if (requests === 2) {
            staleSignal = init.signal;
            return new Promise<Response>((resolve) => {
              finishStale = resolve;
            });
          }
          if (requests === 3)
            return historyProblem === "unavailable"
              ? Response.json({ error: "Unavailable" }, { status: 503 })
              : Response.json({ data: [null] });
          return Response.json({
            data: [revision(3), revision(2), revision(1)],
          });
        }
        return new Response(new Uint8Array([1, 2]));
      }),
    );
    render(<OfficePage search="?base=%2Fv1%2Foffice-documents&file=file-1" />);
    const saveButton = () => screen.getByRole("button", { name: "Guardar" });
    await screen.findByRole("button", { name: "Descargar versión 1" });

    dirty();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await screen.findByText("Versión 2");
    await waitFor(() => expect(staleSignal).toBeDefined());
    dirty();
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.click(saveButton());
    await screen.findByText("Versión 3");
    expect(staleSignal?.aborted).toBe(true);
    expect(writes).toEqual(["1", "2"]);
    const retry = await screen.findByRole("button", {
      name: "Reintentar historial",
    });
    expect(
      screen.getByRole("button", { name: "Descargar versión 1" }),
    ).toBeInTheDocument();
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Descargar versión 3" });
    await act(async () => finishStale(Response.json({ data: [revision(2)] })));
    expect(
      screen.getByRole("button", { name: "Descargar versión 3" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reintentar historial" }),
    ).toBeNull();
  },
);

it("preserves a revision with different bytes when a save is retried", async () => {
  const fetcher = vi.fn(async () => new Response(new Uint8Array([7, 8])));
  vi.stubGlobal("fetch", fetcher);
  const api = new OfficeApi("/v1/office-documents", "file-1");
  await expect(
    api.save(editableDocument, new Uint8Array([3, 4]), true),
  ).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "retries a missing revision even if its original save commits during the retry: %s",
  async (originalCommitsDuringRetry) => {
    const bytes = new Uint8Array([3, 4]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: "Missing" }, { status: 404 }),
      )
      .mockResolvedValueOnce(
        originalCommitsDuringRetry
          ? Response.json({ error: "Conflict" }, { status: 409 })
          : Response.json({ data: { version: 2 } }, { status: 201 }),
      )
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal("fetch", fetcher);
    const api = new OfficeApi("/v1/office-documents", "file-1");
    await expect(api.save(editableDocument, bytes, true)).resolves.toEqual({
      version: 2,
    });
    const writes = fetcher.mock.calls.filter(
      ([, init]) => init.method === "POST",
    );
    expect(writes).toHaveLength(1);
    const body = writes[0]![1].body as FormData;
    expect(body.get("version")).toBe("1");
    expect(
      new Uint8Array(await (body.get("file") as File).arrayBuffer()),
    ).toEqual(bytes);
  },
);

it.each([false, true])(
  "tracks edits that arrive during upload: %s",
  async (editDuringUpload) => {
    let dirty = () => {};
    let finishUpload: (response: Response) => void = () => {};
    let uploading = false;
    vi.mocked(loadOfficeEngine).mockImplementation(async (_canvas, events) => {
      dirty = events.onDirty;
      return {
        open: async () => {},
        save: async () => {
          dirty();
          return new Uint8Array([1, 2]);
        },
        dispose: () => {},
      };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        if (init?.method === "POST") {
          uploading = true;
          return new Promise<Response>((resolve) => {
            finishUpload = resolve;
          });
        }
        if (String(input).endsWith("/office"))
          return Response.json({
            data: {
              id: "file-1",
              name: "policy.docx",
              mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 2,
              version: 1,
              maxSize: 500000,
              readOnly: false,
            },
          });
        if (String(input).endsWith("/revisions"))
          return Response.json({ data: [] });
        return new Response(new Uint8Array([1, 2]));
      }),
    );
    render(<OfficePage search="?base=%2Fv1%2Fdynamic-crm%2F1&file=file-1" />);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Descargar copia" }),
      ).toBeEnabled(),
    );
    dirty();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Guardar" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(uploading).toBe(true));
    if (editDuringUpload) dirty();
    finishUpload(Response.json({ data: { version: 2 } }, { status: 201 }));
    await screen.findByText("Versión 2");
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Guardar" })
          .hasAttribute("disabled"),
      ).toBe(!editDuringUpload),
    );
    expect(
      screen.getByText(
        editDuringUpload ? "Cambios sin guardar" : "Guardado en Savia",
      ),
    ).toBeInTheDocument();
  },
);

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeConfig } from "@savia/studio-shared/metadata";
import { toast } from "sonner";
import { afterEach, expect, it, vi } from "vitest";
import Operations from "../operations";
import { setStudioRuntime } from "../runtime";
import { render } from "./locale-test-render";

afterEach(() => {
  cleanup();
  setStudioRuntime({ embedded: false });
  vi.restoreAllMocks();
});

function mount(
  transport: (path: string, init?: RequestInit) => Promise<Response>,
  collectionNames = ["contacts"],
) {
  setStudioRuntime({ embedded: true, tenantId: 24, transport });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Operations
        tab="import"
        objects={collectionNames.map((name) => ({
          name,
          label: name,
          description: "",
          config: makeConfig({ name: { type: "Textbox", label: "Name" } }),
        }))}
      />
    </QueryClientProvider>,
  );
}

function chooseCsv(read: () => Promise<string>) {
  const file = new File([], "records.csv", { type: "text/csv" });
  Object.defineProperty(file, "text", { value: read });
  fireEvent.change(screen.getByLabelText("Seleccionar CSV"), {
    target: { files: [file] },
  });
}

const csvPreview = {
  data: [{ row: 2, status: "ready", data: { name: "Ana" } }],
  total: 1,
  importId: "28583160-267e-402b-b7c8-d004faeda574",
  summary: { ready: 1, created: 0, skipped: 0, errors: 0 },
};

it("ignores a CSV file that finishes reading after changing collections", async () => {
  const file = Promise.withResolvers<string>();
  const transport = vi.fn();
  mount(transport, ["contacts", "companies"]);
  chooseCsv(() => file.promise);
  fireEvent.change(screen.getByRole("combobox", { name: "Objeto" }), {
    target: { value: "companies" },
  });
  await act(async () => file.resolve("name\r\nAna\r\n"));

  expect(
    screen.queryByRole("button", { name: "Validar y previsualizar" }),
  ).toBeNull();
  expect(transport).not.toHaveBeenCalled();
});

it.each(["collection", "column mapping"])(
  "discards a pending CSV preview after changing the %s",
  async (change) => {
    const pending = Promise.withResolvers<Response>();
    const transport = vi.fn(
      (_path: string, _init?: RequestInit) => pending.promise,
    );
    mount(transport, ["contacts", "companies"]);
    chooseCsv(async () => "name\r\nAna\r\n");
    fireEvent.click(
      await screen.findByRole("button", { name: "Validar y previsualizar" }),
    );
    expect(transport.mock.calls[0][0]).toBe("/api/import/contacts/preview");
    const signal = transport.mock.calls[0][1]?.signal;

    if (change === "collection") {
      fireEvent.change(screen.getByRole("combobox", { name: "Objeto" }), {
        target: { value: "companies" },
      });
    } else {
      fireEvent.change(screen.getByRole("combobox", { name: "name" }), {
        target: { value: "" },
      });
    }
    await act(async () => pending.resolve(Response.json(csvPreview)));

    expect(
      screen.queryByRole("button", { name: /Importar 1 filas válidas/ }),
    ).toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  },
);

it("keeps the validated collection and mapping while committing a CSV import", async () => {
  const commit = Promise.withResolvers<Response>();
  const transport = vi.fn(
    (_path: string, _init?: RequestInit) => commit.promise,
  );
  transport.mockResolvedValueOnce(Response.json(csvPreview));
  mount(transport, ["contacts", "companies"]);
  chooseCsv(async () => "name\r\nAna\r\n");
  fireEvent.click(
    await screen.findByRole("button", { name: "Validar y previsualizar" }),
  );
  const confirm = await screen.findByRole("button", {
    name: /Importar 1 filas válidas/,
  });
  fireEvent.click(confirm);
  fireEvent.click(confirm);

  expect(transport).toHaveBeenCalledTimes(2);
  const [path, request] = transport.mock.calls[1];
  expect(path).toBe("/api/import/contacts/commit");
  expect(JSON.parse(String(request?.body))).toMatchObject({
    csv: "name\r\nAna\r\n",
    mapping: { name: "name" },
    importId: csvPreview.importId,
  });
  expect(screen.getByRole("combobox", { name: "Objeto" })).toBeDisabled();
  expect(screen.getByRole("combobox", { name: "name" })).toBeDisabled();
  expect(screen.getByLabelText("Seleccionar CSV")).toBeDisabled();

  await act(async () =>
    commit.resolve(
      Response.json({
        ...csvPreview,
        data: [{ row: 2, status: "created", id: "record-1" }],
        summary: { ready: 0, created: 1, skipped: 0, errors: 0 },
      }),
    ),
  );
  expect(screen.getByText("Creados")).toBeVisible();
  expect(screen.getByRole("combobox", { name: "Objeto" })).toBeEnabled();
});

it("reports a sign-in page without saving it as an export", async () => {
  const transport = vi.fn(
    async () =>
      new Response("<html>Sign in</html>", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  const reportError = vi
    .spyOn(toast, "error")
    .mockReturnValue("download-error");
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  mount(transport);

  const button = screen.getByRole("button", { name: "Exportar CSV completo" });
  fireEvent.click(button);

  await waitFor(() => {
    expect(save).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledWith(
      "No se recibió un archivo CSV válido.",
    );
    expect(button).toBeEnabled();
  });
  expect(transport).toHaveBeenCalledWith("/api/export/contacts", {
    headers: { Accept: "text/csv" },
    signal: expect.any(AbortSignal),
  });
});

it("waits for one CSV download at a time and keeps the export filename", async () => {
  let finishExport!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finishExport = resolve;
  });
  const transport = vi.fn(async () => pending);
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe("contacts.csv");
    });
  mount(transport);

  const button = screen.getByRole("button", { name: "Exportar CSV completo" });
  fireEvent.click(button);
  fireEvent.click(button);

  expect(transport).toHaveBeenCalledOnce();
  expect(button).toBeDisabled();
  expect(save).not.toHaveBeenCalled();

  finishExport(
    new Response("Name\r\nAna\r\n", {
      headers: { "Content-Type": "text/csv; charset=utf-8" },
    }),
  );
  await waitFor(() => {
    expect(save).toHaveBeenCalledOnce();
    expect(button).toBeEnabled();
  });
});

it("waits for the rejected collection's CSV deadline across collection changes", async () => {
  const transport = vi.fn(
    async (_path: string) =>
      new Response("Name\r\nAna\r\n", {
        headers: { "Content-Type": "text/csv" },
      }),
  );
  transport.mockResolvedValueOnce(
    Response.json(
      { error: "Export limit reached" },
      {
        status: 429,
        headers: { "Retry-After": "30" },
      },
    ),
  );
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const reportError = vi
    .spyOn(toast, "error")
    .mockReturnValue("download-error");
  mount(transport, ["contacts", "companies"]);
  const button = screen.getByRole("button", { name: "Exportar CSV completo" });
  const collection = screen.getByRole("combobox", { name: "Objeto" });

  vi.useFakeTimers();
  try {
    await act(async () => fireEvent.click(button));
    expect(button).toBeDisabled();
    expect(reportError).toHaveBeenCalledWith("Export limit reached");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Puedes reintentar a partir de",
    );
    fireEvent.change(collection, { target: { value: "companies" } });
    expect(button).toBeEnabled();
    await act(async () => fireEvent.click(button));
    expect(save).toHaveBeenCalledOnce();
    fireEvent.change(collection, { target: { value: "contacts" } });
    act(() => vi.advanceTimersByTime(29_999));
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(transport).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(1));
    expect(button).toBeEnabled();
    expect(transport).toHaveBeenCalledTimes(2);
    await act(async () => fireEvent.click(button));
    expect(transport.mock.calls.map(([path]) => path)).toEqual([
      "/api/export/contacts",
      "/api/export/companies",
      "/api/export/contacts",
    ]);
    expect(save).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("allows a full export to finish streaming past the table download deadline", async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      body = controller;
      body.enqueue(new TextEncoder().encode("Name\r\n"));
    },
  });
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  mount(
    async () =>
      new Response(stream, {
        headers: { "Content-Type": "text/csv" },
      }),
  );
  const button = screen.getByRole("button", { name: "Exportar CSV completo" });

  vi.useFakeTimers();
  try {
    await act(async () => fireEvent.click(button));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(button).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    body.enqueue(new TextEncoder().encode("Ana\r\n"));
    body.close();
  } finally {
    vi.useRealTimers();
  }
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
});

it("cancels a stalled CSV body and allows another download", async () => {
  const cancelBody = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("Name\r\n"));
    },
    cancel: cancelBody,
  });
  const transport = vi.fn(
    async (_path: string, _init?: RequestInit) =>
      new Response("Name\r\nAna\r\n", {
        headers: { "Content-Type": "text/csv" },
      }),
  );
  transport.mockResolvedValueOnce(
    new Response(body, { headers: { "Content-Type": "text/csv" } }),
  );
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  const notify = vi.spyOn(toast, "error").mockReturnValue("download-error");
  mount(transport);
  const exportButton = screen.getByRole("button", {
    name: "Exportar CSV completo",
  });
  fireEvent.click(exportButton);
  await waitFor(() => expect(body.locked).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Cancelar descarga" }));

  expect(exportButton).toBeEnabled();
  expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  await waitFor(() => expect(cancelBody).toHaveBeenCalledOnce());
  expect(save).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  fireEvent.click(exportButton);
  await waitFor(() => expect(save).toHaveBeenCalledOnce());
  expect(exportButton).toBeEnabled();
});

it("keeps a new export active when a cancelled request returns late", async () => {
  const abandoned = Promise.withResolvers<Response>();
  const replacement = Promise.withResolvers<Response>();
  const transport = vi
    .fn()
    .mockReturnValueOnce(abandoned.promise)
    .mockReturnValueOnce(replacement.promise);
  const save = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  mount(transport);
  const exportButton = screen.getByRole("button", {
    name: "Exportar CSV completo",
  });
  fireEvent.click(exportButton);
  fireEvent.click(screen.getByRole("button", { name: "Cancelar descarga" }));
  fireEvent.click(exportButton);
  expect(transport).toHaveBeenCalledTimes(2);
  const csv = () =>
    new Response("Name\r\nAna\r\n", {
      headers: { "Content-Type": "text/csv" },
    });
  await act(async () => abandoned.resolve(csv()));

  expect(save).not.toHaveBeenCalled();
  expect(exportButton).toBeDisabled();
  await act(async () => replacement.resolve(csv()));
  expect(save).toHaveBeenCalledOnce();
  expect(exportButton).toBeEnabled();
});

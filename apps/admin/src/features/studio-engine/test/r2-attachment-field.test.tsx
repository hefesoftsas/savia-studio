// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  act,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { render } from "./locale-test-render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { R2AttachmentField } from "../r2-attachment-field";
import { setStudioRuntime } from "../runtime";
import { OfficeAvailabilityContext } from "@/features/office-settings/office-availability";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "@/api/request-timeout";

const savedAttachment = {
  id: "attachment-1",
  name: "contract.pdf",
  mime: "application/pdf",
  size: 200,
  field: "contract",
  version: 1,
  created_at: "2026-09-09T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  setStudioRuntime({ embedded: false });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mountAttachmentField(recordId?: string, disabled = false) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <OfficeAvailabilityContext.Provider
        value={{ enabled: true, loading: false, error: false }}
      >
        <R2AttachmentField
          field="contract"
          object="contracts"
          onPendingChange={vi.fn()}
          pending={[]}
          policy={{
            accept: ["application/pdf"],
            maxFiles: 1,
            maxSize: 1024,
          }}
          recordId={recordId}
          disabled={disabled}
        />
      </OfficeAvailabilityContext.Provider>
    </QueryClientProvider>,
  );
}

function stalledResponse() {
  const cancel = vi.fn();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    }),
    { headers: { "Content-Type": "application/json" } },
  );
  function close() {
    if (!cancel.mock.calls.length) stream.close();
  }
  return { response, cancel, close };
}

it("does not show attachment loading before a new record is saved", () => {
  mountAttachmentField();
  expect(screen.queryByText("Cargando archivos…")).toBeNull();
  expect(
    screen.getByText(
      "El archivo se cargará ahora y se asociará al guardar el registro.",
    ),
  ).toBeTruthy();
});

it("lists attachments belonging to its field only", async () => {
  const fetcher = vi.fn(async () => Response.json({ data: [savedAttachment] }));
  vi.stubGlobal("fetch", fetcher);
  mountAttachmentField("record-1");

  expect(await screen.findByText("contract.pdf")).toBeTruthy();
  await waitFor(() =>
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/api/files/contracts/record-1?field=contract",
    ),
  );
});

it("keeps an Office viewer link available on a read-only attachment field", async () => {
  const document = {
    ...savedAttachment,
    name: "contract.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  };
  setStudioRuntime({
    embedded: true,
    apiBasePath: "/v1/studio/101",
    tenantId: 101,
    transport: async () => Response.json({ data: [document] }),
  });
  mountAttachmentField("record-1", true);
  expect(
    await screen.findByRole("link", { name: "Abrir contract.docx en Office" }),
  ).toHaveAttribute(
    "href",
    "/office/?base=%2Fv1%2Fstudio%2F101&file=attachment-1",
  );
  expect(
    screen.getByRole("button", { name: "Eliminar contract.docx" }),
  ).toBeDisabled();
});

it("allows a manual retry after a stalled attachment list", async () => {
  vi.useFakeTimers();
  const pending = stalledResponse();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(pending.response)
    .mockResolvedValueOnce(Response.json({ data: [savedAttachment] }));
  vi.stubGlobal("fetch", fetcher);
  try {
    mountAttachmentField("record-1");
    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1));
    expect(screen.queryByText("Cargando archivos…")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      new RequestTimeoutError().message,
    );
    expect(pending.cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByText(savedAttachment.name)).toBeTruthy();
  } finally {
    pending.close();
  }
});

it("refreshes the attachment list after an interrupted deletion confirmation", async () => {
  const pending = stalledResponse();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: [savedAttachment] }))
    .mockResolvedValueOnce(pending.response)
    .mockResolvedValueOnce(Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetcher);
  try {
    mountAttachmentField("record-1");
    const remove = await screen.findByRole("button", {
      name: "Eliminar contract.pdf",
    });
    vi.useFakeTimers();
    fireEvent.click(remove);
    await act(async () => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1));

    expect(screen.getByRole("alert").textContent).toContain(
      new RequestTimeoutError().message,
    );
    expect(pending.cancel).toHaveBeenCalledOnce();
    expect(screen.queryByText(savedAttachment.name)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      method: "DELETE",
      body: JSON.stringify({ version: 1 }),
    });
  } finally {
    pending.close();
  }
});

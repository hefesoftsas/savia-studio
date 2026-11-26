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
) {
  setStudioRuntime({ embedded: true, tenantId: 24, transport });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Operations
        tab="import"
        objects={[
          {
            name: "contacts",
            label: "Contacts",
            description: "",
            config: makeConfig({ name: { type: "Textbox", label: "Name" } }),
          },
        ]}
      />
    </QueryClientProvider>,
  );
}

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

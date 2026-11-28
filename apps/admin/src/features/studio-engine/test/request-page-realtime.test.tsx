import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "./locale-test-render";
import type { StudioObject } from "@savia/studio-shared/metadata";
import type { PageRun } from "../request-page-api";
import { setStudioRuntime } from "../runtime";
import RequestPage from "../request-page";

const state = vi.hoisted(() => ({
  callbacks: null as any,
  status: "live",
  durable: false,
  formValues: {} as Record<string, unknown>,
}));
const requestPageApi = vi.hoisted(() => vi.fn());
const executeRequestPageAction = vi.hoisted(() => vi.fn());
vi.mock("@/realtime/use-realtime", () => ({
  useRealtimeTopics: (options: any) => {
    state.callbacks = options;
    return { status: state.status, lastEvent: null };
  },
}));
vi.mock("@/realtime/use-durable-realtime", () => ({
  useDurableRealtime: () => state.durable,
}));
vi.mock("../request-page-api", () => ({
  requestPageApi,
  executeRequestPageAction,
}));
vi.mock("../dynamic-form", () => ({
  default: ({
    onSave,
    submitLabel,
  }: {
    onSave: (values: Record<string, unknown>) => void;
    submitLabel: string;
  }) => (
    <button type="button" onClick={() => void onSave(state.formValues)}>
      {submitLabel}
    </button>
  ),
}));
vi.mock("../lookup-actions", () => ({ LookupActions: () => null }));

afterEach(() => {
  cleanup();
  setStudioRuntime({ embedded: false });
  state.callbacks = null;
  state.status = "live";
  state.durable = false;
  state.formValues = {};
  vi.useRealTimers();
  requestPageApi.mockReset();
  executeRequestPageAction.mockReset();
});

const config = {
  studio: {
    requestPage: {
      version: 1,
      source: "savia-request",
      actions: [
        {
          id: "quote",
          operationId: "quote",
          label: "Cotizar",
          kind: "submit",
          input: {},
        },
      ],
    },
  },
};
function page(name: string): StudioObject {
  return {
    name,
    label: name,
    description: "",
    config,
  } as unknown as StudioObject;
}
function run(pageName: string, label: string): PageRun {
  return {
    id: `${pageName}-run`,
    tenantId: "0",
    pageName,
    actionId: "quote",
    label,
    mode: "mock",
    status: "complete",
    values: {},
    result: null,
    error: null,
    createdAt: "2026-10-30T00:00:00Z",
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

it.each(["live", "unavailable"])(
  "does not poll pending page runs while realtime is %s",
  async (status) => {
  vi.useFakeTimers();
  state.status = status;
  state.durable = false;
  const running = {
    ...run("first_page", "En curso"),
    status: "running" as const,
    createdAt: new Date().toISOString(),
  };
  requestPageApi.mockResolvedValue({ data: [running] });
  render(<RequestPage object={page("first_page")} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(requestPageApi).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300_000);
  });
  expect(requestPageApi).toHaveBeenCalledTimes(1);
  },
);

it("does not poll a pending page while its durable realtime connection is live", async () => {
  vi.useFakeTimers();
  state.durable = true;
  const running = {
    ...run("first_page", "En curso"),
    status: "running" as const,
    createdAt: new Date().toISOString(),
  };
  requestPageApi.mockResolvedValue({ data: [running] });
  render(<RequestPage object={page("first_page")} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(requestPageApi).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300_000);
  });
  expect(requestPageApi).toHaveBeenCalledTimes(1);
});

it("loads the page's runs from a principal realtime hint", async () => {
  requestPageApi
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [run("first_page", "Actualizado remoto")] });
  render(<RequestPage object={page("first_page")} />);
  await waitFor(() =>
    expect(screen.queryByText("Cargando resultados…")).toBeNull(),
  );
  expect(state.callbacks.topics).toEqual(["request-pages"]);

  await act(async () =>
    state.callbacks.onEvent({
      topic: "request-pages",
      type: "updated",
      collection: "first_page",
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("Actualizado remoto")).toBeTruthy(),
  );
});

it("clears a results-read error after successfully reloading history", async () => {
  requestPageApi
    .mockRejectedValueOnce(new Error("Historial temporalmente no disponible"))
    .mockResolvedValueOnce({
      data: [run("quote_page", "Cotización recuperada")],
    });
  render(<RequestPage object={page("quote_page")} />);

  await screen.findByText("Historial temporalmente no disponible");
  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar resultados" }),
  );
  await screen.findByText("Cotización recuperada");
  expect(
    screen.queryByText("Historial temporalmente no disponible"),
  ).toBeNull();
  expect(executeRequestPageAction).not.toHaveBeenCalled();
});

it("keeps a submission error through a successful history read and clears it on the next submission", async () => {
  const saved = run("quote_page", "Cotización guardada");
  requestPageApi
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValue({ data: [saved] });
  executeRequestPageAction
    .mockRejectedValueOnce(new Error("No se pudo ejecutar la cotización"))
    .mockResolvedValueOnce(saved);
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledTimes(2));
  await screen.findByText("No se pudo ejecutar la cotización");

  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await screen.findByText("Cotización guardada");
  expect(screen.queryByText("No se pudo ejecutar la cotización")).toBeNull();
  expect(executeRequestPageAction).toHaveBeenCalledTimes(2);
});

it("clears an uncertain submission once the matching completed run is in history", async () => {
  const completed = run("quote_page", "Resultado confirmado");
  let submittedId: string;
  requestPageApi
    .mockResolvedValueOnce({ data: [] })
    .mockImplementation(async () => ({
      data: [{ ...completed, id: submittedId }],
    }));
  executeRequestPageAction.mockImplementationOnce(
    async (_name, _action, _data, _mode, id) => {
      if (id === undefined) throw new Error("Expected an execution ID");
      submittedId = id;
      throw new Error("Unconfirmed submission");
    },
  );
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));

  await screen.findByText("Resultado confirmado");
  expect(screen.queryByText("Unconfirmed submission")).toBeNull();
  expect(executeRequestPageAction).toHaveBeenCalledOnce();
});

it("keeps the pending ID when retrying identical values in another key order", async () => {
  state.formValues = { reference: "TEST", plate: "TESTCAR" };
  requestPageApi.mockResolvedValue({ data: [] });
  executeRequestPageAction
    .mockRejectedValueOnce(new Error("No receipt"))
    .mockResolvedValueOnce(run("quote_page", "Recovered"));
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await screen.findByText("No receipt");
  await screen.findByRole("button", { name: "Ejecutar" });

  state.formValues = { plate: "TESTCAR", reference: "TEST" };
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await waitFor(() =>
    expect(executeRequestPageAction).toHaveBeenCalledTimes(2),
  );
  expect(executeRequestPageAction.mock.calls[1][4]).toBe(
    executeRequestPageAction.mock.calls[0][4],
  );
});

it("keeps an uncertain quote's execution ID after another quote completes", async () => {
  const first = { reference: "FIRST" };
  const second = { reference: "SECOND" };
  requestPageApi.mockResolvedValue({ data: [] });
  executeRequestPageAction
    .mockRejectedValueOnce(new Error("First receipt lost"))
    .mockResolvedValueOnce(run("quote_page", "Second quote saved"))
    .mockResolvedValueOnce(run("quote_page", "First quote recovered"));
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledOnce());

  state.formValues = first;
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await screen.findByText("First receipt lost");

  state.formValues = second;
  fireEvent.click(await screen.findByRole("button", { name: "Ejecutar" }));
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledTimes(3));

  state.formValues = first;
  fireEvent.click(await screen.findByRole("button", { name: "Ejecutar" }));
  await waitFor(() =>
    expect(executeRequestPageAction).toHaveBeenCalledTimes(3),
  );
  const [firstAttempt, secondAttempt, retry] =
    executeRequestPageAction.mock.calls;
  expect(firstAttempt[4]).toEqual(expect.any(String));
  expect(secondAttempt[4]).not.toBe(firstAttempt[4]);
  expect(retry[4]).toBe(firstAttempt[4]);
});

it("keeps the latest error when history confirms an earlier quote", async () => {
  requestPageApi.mockResolvedValue({ data: [] });
  executeRequestPageAction
    .mockRejectedValueOnce(new Error("First receipt lost"))
    .mockRejectedValueOnce(new Error("Second receipt lost"));
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledOnce());

  state.formValues = { reference: "FIRST" };
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await screen.findByText("First receipt lost");

  state.formValues = { reference: "SECOND" };
  fireEvent.click(await screen.findByRole("button", { name: "Ejecutar" }));
  await screen.findByText("Second receipt lost");
  await screen.findByRole("button", { name: "Ejecutar" });

  const completed = {
    ...run("quote_page", "First quote recovered"),
    id: executeRequestPageAction.mock.calls[0][4],
  };
  requestPageApi.mockResolvedValue({ data: [completed] });
  await act(async () =>
    state.callbacks.onEvent({
      topic: "request-pages",
      type: "updated",
      collection: "quote_page",
    }),
  );

  await screen.findByText("First quote recovered");
  expect(screen.getByText("Second receipt lost")).toBeTruthy();
});

it("keeps a confirmed quote when an older history read arrives before a failed refresh", async () => {
  const oldHistory = deferred<{ data: PageRun[] }>();
  requestPageApi
    .mockResolvedValueOnce({ data: [] })
    .mockReturnValueOnce(oldHistory.promise)
    .mockRejectedValueOnce(new Error("History offline"));
  executeRequestPageAction.mockImplementationOnce(
    async (_name, _action, _data, _mode, id) => ({
      ...run("quote_page", "Confirmed quote"),
      id,
    }),
  );
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() =>
    expect(screen.queryByText("Cargando resultados…")).toBeNull(),
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar resultados" }),
  );
  expect(requestPageApi).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await screen.findByText("Confirmed quote");

  await act(async () => oldHistory.resolve({ data: [] }));
  await screen.findByText("History offline");
  expect(screen.getByText("Confirmed quote")).toBeTruthy();
  expect(requestPageApi).toHaveBeenCalledTimes(3);
});

it("keeps the completed history row when a delayed running receipt arrives", async () => {
  const delayedReceipt = deferred<PageRun>();
  const completed = {
    ...run("quote_page", "Confirmed quote"),
    createdAt: new Date().toISOString(),
  };
  requestPageApi
    .mockResolvedValueOnce({ data: [] })
    .mockResolvedValueOnce({ data: [completed] })
    .mockRejectedValueOnce(new Error("History offline"));
  executeRequestPageAction.mockImplementationOnce(
    (_name, _action, _data, _mode, id) => {
      completed.id = id;
      return delayedReceipt.promise;
    },
  );
  render(<RequestPage object={page("quote_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar resultados" }),
  );
  await screen.findByText("Completado");

  await act(async () =>
    delayedReceipt.resolve({ ...completed, status: "running" }),
  );
  await screen.findByText("History offline");
  expect(screen.getByText("Completado")).toBeTruthy();
  expect(screen.queryByText("En proceso")).toBeNull();
});

it.each([401, 403])(
  "clears protected history on %s and keeps a late receipt hidden until an authorized read",
  async (status) => {
    const denied = Object.assign(new Error("Quote access denied"), { status });
    const delayedReceipt = deferred<PageRun>();
    const previous = run("quote_page", "Previously authorized quote");
    requestPageApi
      .mockResolvedValueOnce({ data: [previous] })
      .mockRejectedValue(denied);
    executeRequestPageAction.mockReturnValueOnce(delayedReceipt.promise);
    render(<RequestPage object={page("quote_page")} />);
    await screen.findByText(previous.label);
    fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar resultados" }),
    );
    await screen.findByText(denied.message);
    expect(screen.queryByText(previous.label)).toBeNull();

    const late = {
      ...run("quote_page", "Late quote receipt"),
      id: executeRequestPageAction.mock.calls[0][4],
    };
    await act(async () => delayedReceipt.resolve(late));
    expect(screen.queryByText(late.label)).toBeNull();
    expect(screen.getByText(denied.message)).toBeTruthy();

    requestPageApi.mockResolvedValueOnce({ data: [late] });
    fireEvent.click(
      screen.getByRole("button", { name: "Actualizar resultados" }),
    );
    await screen.findByText(late.label);
    expect(screen.queryByText(denied.message)).toBeNull();
    expect(executeRequestPageAction).toHaveBeenCalledOnce();
  },
);

it("ignores a successful history response started before an execution was denied", async () => {
  const oldHistory = deferred<{ data: PageRun[] }>();
  const denied = Object.assign(new Error("Quote access denied"), {
    status: 403,
  });
  const previous = run("quote_page", "Previously authorized quote");
  requestPageApi
    .mockResolvedValueOnce({ data: [previous] })
    .mockReturnValueOnce(oldHistory.promise)
    .mockRejectedValue(denied);
  executeRequestPageAction.mockRejectedValueOnce(denied);
  render(<RequestPage object={page("quote_page")} />);
  await screen.findByText(previous.label);
  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar resultados" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await screen.findByText(denied.message);
  expect(screen.queryByText(previous.label)).toBeNull();

  await act(async () => oldHistory.resolve({ data: [previous] }));
  expect(screen.queryByText(previous.label)).toBeNull();
  expect(screen.getByText(denied.message)).toBeTruthy();
});

it("drops an old page read and runs a catch-up read after a scope switch", async () => {
  const oldRead = deferred<{ data: PageRun[] }>();
  requestPageApi
    .mockResolvedValueOnce({
      data: [run("first_page", "Página actual antigua")],
    })
    .mockReturnValueOnce(oldRead.promise)
    .mockResolvedValueOnce({
      data: [run("second_page", "Solo página actual")],
    });
  const view = render(<RequestPage object={page("first_page")} />);
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(screen.getByText("Página actual antigua")).toBeTruthy(),
  );

  await act(async () =>
    state.callbacks.onEvent({
      topic: "request-pages",
      type: "updated",
      collection: "first_page",
    }),
  );
  await waitFor(() => expect(requestPageApi).toHaveBeenCalledTimes(2));

  view.rerender(<RequestPage object={page("second_page")} />);
  expect(screen.queryByText("Página actual antigua")).toBeNull();
  expect(screen.queryByText("Página anterior")).toBeNull();
  await act(async () => {
    oldRead.resolve({ data: [run("first_page", "Página anterior")] });
  });
  await waitFor(() =>
    expect(screen.getByText("Solo página actual")).toBeTruthy(),
  );
  expect(screen.queryByText("Página anterior")).toBeNull();
  expect(requestPageApi).toHaveBeenCalledTimes(3);
  expect(requestPageApi.mock.calls[2][0]).toContain("pageName=second_page");
});

it("ignores a late action result after the page scope switches", async () => {
  const delayedAction = deferred<PageRun>();
  requestPageApi.mockResolvedValue({ data: [] });
  executeRequestPageAction.mockReturnValue(delayedAction.promise);
  const view = render(<RequestPage object={page("first_page")} />);
  await waitFor(() =>
    expect(screen.queryByText("Cargando resultados…")).toBeNull(),
  );

  fireEvent.click(screen.getByRole("button", { name: "Ejecutar" }));
  await waitFor(() => expect(executeRequestPageAction).toHaveBeenCalledOnce());
  expect(screen.getByRole("button", { name: "Cotizando…" })).toBeTruthy();
  view.rerender(<RequestPage object={page("second_page")} />);
  expect(screen.getByRole("button", { name: "Ejecutar" })).toBeTruthy();
  await act(async () => {
    delayedAction.resolve(run("first_page", "Ejecución tardía"));
  });

  expect(screen.queryByText("Ejecución tardía")).toBeNull();
  expect(requestPageApi.mock.calls.at(-1)?.[0]).toContain(
    "pageName=second_page",
  );
});

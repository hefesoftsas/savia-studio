import type { ReactNode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import type { AppServices } from "@/app-services";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import {
  SaviaRequestProvider,
  useSaviaRequestWorkspace,
} from "./savia-request-provider";
import {
  clearAllSaviaRequestSnapshots,
  writeSaviaRequestSnapshot,
} from "./savia-request-cache";
import type { RequestFlow } from "./types";

vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
}));

const autos: RequestFlow = {
  id: "autos",
  name: "Autos",
  description: "Cotiza autos.",
  input: {},
  variables: [],
  versions: [],
  steps: [
    {
      id: "crear-sesion",
      name: "Crear sesión",
      url: "https://provider.test/session",
      method: "POST",
      headers: {},
      body: "{}",
      pre: "",
      post: "",
    },
    {
      id: "cotizar",
      name: "Cotizar",
      url: "https://provider.test/quote",
      method: "POST",
      headers: {},
      body: "{}",
      pre: "",
      post: "",
    },
  ],
};

const hogar: RequestFlow = {
  ...autos,
  id: "hogar",
  name: "Hogar",
  steps: [{ ...autos.steps[0], id: "cotizar-hogar", name: "Cotizar hogar" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function WorkspaceProbe() {
  const { dirty, flow, stepIndex, selectFlow, openSecrets, updateDraft, view } =
    useSaviaRequestWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="active-flow">{flow?.name ?? "sin flow"}</p>
      <p data-testid="active-view">{view}</p>
      <p data-testid="active-step">{stepIndex}</p>
      <p data-testid="selection-url">{location.pathname + location.search}</p>
      <p data-testid="draft-status">{dirty ? "unsaved" : "saved"}</p>
      <button
        onClick={() =>
          flow ? updateDraft({ ...flow, name: "Autos editado" }) : undefined
        }
        type="button"
      >
        Editar autos
      </button>
      <button onClick={() => void selectFlow("hogar")} type="button">
        Seleccionar hogar
      </button>
      <button onClick={openSecrets} type="button">
        Abrir secretos
      </button>
      <button
        onClick={() => navigate("/savia-request?flow=hogar&step=0")}
        type="button"
      >
        Navegar hogar directamente
      </button>
      <button
        onClick={() => navigate("/bookings?tab=reservations&date=2026-11-25")}
        type="button"
      >
        Abrir Citas
      </button>
      <button onClick={() => navigate(-1)} type="button">
        Volver a la página anterior
      </button>
      <button onClick={() => navigate("/savia-request")} type="button">
        Abrir Savia Request sin selección
      </button>
    </>
  );
}

function renderProvider(initialEntry: string, extra?: ReactNode) {
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/flows")) {
      return [
        { id: autos.id, name: autos.name, steps: autos.steps },
        { id: hogar.id, name: hogar.name, steps: hogar.steps },
      ];
    }
    if (path.endsWith("/folders")) return ["Cotizaciones"];
    if (path.endsWith("/flows/autos")) return autos;
    if (path.endsWith("/flows/hogar")) return hogar;
    throw new Error(`Ruta inesperada: ${path}`);
  });
  const put = vi.fn().mockResolvedValue({ ok: true });
  const services = {
    apiClient: { get, put, post: vi.fn(), delete: vi.fn(), request: vi.fn() },
  } as unknown as AppServices;

  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppServicesProvider services={services}>
        <SaviaRequestProvider>
          <WorkspaceProbe />
          {extra}
        </SaviaRequestProvider>
      </AppServicesProvider>
    </MemoryRouter>,
  );
  return { get, put };
}

afterEach(() => {
  cleanup();
  clearAllSaviaRequestSnapshots();
  vi.restoreAllMocks();
});

beforeEach(() => {
  clearAllSaviaRequestSnapshots();
});

describe("SaviaRequestProvider", () => {
  it("restores the requested flow and step from the Savia Request URL", async () => {
    renderProvider("/savia-request?flow=autos&step=1");

    expect(await screen.findByTestId("active-flow")).toHaveTextContent("Autos");
    expect(screen.getByTestId("active-step")).toHaveTextContent("1");
  });

  it("saves a dirty flow before switching to another selection", async () => {
    const user = userEvent.setup();
    const { put } = renderProvider("/savia-request?flow=autos&step=0");

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Editar autos" }));
    await user.click(screen.getByRole("button", { name: "Seleccionar hogar" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos",
        expect.objectContaining({ name: "Autos editado" }),
      ),
    );
    expect(await screen.findByTestId("active-flow")).toHaveTextContent("Hogar");
    expect(screen.getByTestId("selection-url")).toHaveTextContent(
      "/savia-request?flow=hogar&step=0",
    );
  });

  it.each([false, true])(
    "keeps the latest route when an older selection finishes saving, back navigation = %s",
    async (goBack) => {
      const user = userEvent.setup();
      const original = "/savia-request?flow=autos&step=0";
      const bookings = "/bookings?tab=reservations&date=2026-11-25";
      const { put } = renderProvider(original);
      const { promise, resolve } = deferred<{ ok: true }>();
      put.mockReturnValueOnce(promise);

      await screen.findByText("Autos");
      await user.click(screen.getByRole("button", { name: "Editar autos" }));
      await user.click(
        screen.getByRole("button", { name: "Seleccionar hogar" }),
      );
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos",
        expect.objectContaining({ name: "Autos editado" }),
      );
      await user.click(screen.getByRole("button", { name: "Abrir Citas" }));
      expect(screen.getByTestId("selection-url")).toHaveTextContent(bookings);
      if (goBack)
        await user.click(
          screen.getByRole("button", { name: "Volver a la página anterior" }),
        );

      await act(async () => {
        resolve({ ok: true });
        await promise;
      });
      expect(screen.getByTestId("selection-url")).toHaveTextContent(
        goBack ? original : bookings,
      );
      expect(screen.getByTestId("active-flow")).toHaveTextContent(
        "Autos editado",
      );
      expect(screen.getByTestId("draft-status")).toHaveTextContent(/^saved$/);
      expect(put).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["select", "clear"] as const)(
    "ignores a delayed %s action from the previous screen",
    async (mode) => {
      const user = userEvent.setup();
      const { promise, resolve } = deferred<void>();
      function DeferredAction() {
        const { selectFlow, clearSelection } = useSaviaRequestWorkspace();
        return (
          <button
            type="button"
            onClick={() =>
              void promise.then(() =>
                mode === "select" ? selectFlow("hogar") : clearSelection(),
              )
            }
          >
            Start request action
          </button>
        );
      }
      renderProvider("/savia-request?flow=autos&step=0", <DeferredAction />);
      await screen.findByText("Autos");
      await user.click(
        screen.getByRole("button", { name: "Start request action" }),
      );
      await user.click(screen.getByRole("button", { name: "Abrir Citas" }));

      await act(async () => {
        resolve();
        await promise;
      });
      expect(screen.getByTestId("selection-url")).toHaveTextContent(
        "/bookings?tab=reservations&date=2026-11-25",
      );
      expect(screen.getByTestId("active-flow")).toHaveTextContent("Autos");
    },
  );

  it("saves a dirty flow before loading a selection from the URL", async () => {
    const user = userEvent.setup();
    const { put } = renderProvider("/savia-request?flow=autos&step=0");

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Editar autos" }));
    await user.click(
      screen.getByRole("button", { name: "Navegar hogar directamente" }),
    );

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos",
        expect.objectContaining({ name: "Autos editado" }),
      ),
    );
    expect(await screen.findByTestId("active-flow")).toHaveTextContent("Hogar");
  });

  it("switches flows from the sidebar after returning to a cached workspace", async () => {
    const user = userEvent.setup();
    renderProvider("/savia-request?flow=autos&step=0");

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Abrir Citas" }));
    await user.click(
      screen.getByRole("button", { name: "Volver a la página anterior" }),
    );
    await user.click(screen.getByRole("button", { name: "Seleccionar hogar" }));

    await waitFor(() =>
      expect(screen.getByTestId("active-flow")).toHaveTextContent("Hogar"),
    );
    expect(screen.getByTestId("selection-url")).toHaveTextContent(
      "/savia-request?flow=hogar&step=0",
    );
  });

  it("does not restore an unrelated cached flow while loading a deep link", async () => {
    writeSaviaRequestSnapshot(undefined, {
      flows: [autos],
      folders: [],
      flow: autos,
      stepIndex: 0,
      error: null,
      updatedAt: Date.now(),
    });
    const pending = deferred<RequestFlow>();
    const { get } = renderProvider("/savia-request?flow=hogar&step=0");
    const read = get.getMockImplementation()!;
    get.mockImplementation((path) =>
      path.endsWith("/flows/hogar") ? pending.promise : read(path),
    );

    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/v1/savia-request/api/flows/hogar"),
    );
    expect(screen.getByTestId("active-flow")).toHaveTextContent("sin flow");
    await act(async () => pending.resolve(hogar));
    expect(screen.getByTestId("active-flow")).toHaveTextContent("Hogar");
  });

  it("saves the retained draft before opening a different flow from a direct link", async () => {
    const user = userEvent.setup();
    const { put } = renderProvider("/savia-request?flow=autos&step=0");

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Editar autos" }));
    await user.click(screen.getByRole("button", { name: "Abrir Citas" }));
    await user.click(
      screen.getByRole("button", { name: "Navegar hogar directamente" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("active-flow")).toHaveTextContent("Hogar"),
    );
    expect(put).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos",
      expect.objectContaining({ name: "Autos editado" }),
    );
  });

  it("keeps new edits when a requested flow finishes loading", async () => {
    const user = userEvent.setup();
    const pending = deferred<RequestFlow>();
    const { get } = renderProvider("/savia-request?flow=autos&step=0");
    const read = get.getMockImplementation()!;
    get.mockImplementation((path) =>
      path.endsWith("/flows/hogar") ? pending.promise : read(path),
    );

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Abrir Citas" }));
    await user.click(
      screen.getByRole("button", { name: "Navegar hogar directamente" }),
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/v1/savia-request/api/flows/hogar"),
    );
    await user.click(screen.getByRole("button", { name: "Editar autos" }));
    await act(async () => pending.resolve(hogar));

    expect(screen.getByTestId("active-flow")).toHaveTextContent(
      "Autos editado",
    );
    expect(screen.getByTestId("draft-status")).toHaveTextContent("unsaved");
    expect(screen.getByTestId("selection-url")).toHaveTextContent(
      "/savia-request?flow=autos&step=0",
    );
  });

  it("selects an available flow when the cached one is no longer listed", async () => {
    const user = userEvent.setup();
    const { get } = renderProvider("/savia-request?flow=autos&step=0");
    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Abrir Citas" }));

    const read = get.getMockImplementation()!;
    get.mockImplementation(async (path) =>
      path.endsWith("/flows") ? [hogar] : read(path),
    );
    await user.click(
      screen.getByRole("button", { name: "Abrir Savia Request sin selección" }),
    );

    await waitFor(() =>
      expect(screen.getByTestId("active-flow")).toHaveTextContent("Hogar"),
    );
    expect(screen.getByTestId("selection-url")).toHaveTextContent(
      "/savia-request?flow=hogar&step=0",
    );
  });

  it("keeps the secretos view without selecting a flow", async () => {
    const { get } = renderProvider("/savia-request?view=secretos");

    expect(await screen.findByTestId("active-view")).toHaveTextContent(
      "secretos",
    );
    expect(screen.getByTestId("active-flow")).toHaveTextContent("sin flow");
    expect(screen.getByTestId("selection-url")).toHaveTextContent(
      "/savia-request?view=secretos",
    );
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith(expect.stringContaining("/flows")),
    );
    expect(get).not.toHaveBeenCalledWith(
      expect.stringMatching(/\/flows\/(autos|hogar)$/),
    );
  });

  it("opens the secretos view keeping the in-progress draft", async () => {
    const user = userEvent.setup();
    renderProvider("/savia-request?flow=autos&step=0");

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Editar autos" }));
    await user.click(screen.getByRole("button", { name: "Abrir secretos" }));

    expect(await screen.findByTestId("active-view")).toHaveTextContent(
      "secretos",
    );
    expect(screen.getByTestId("selection-url")).toHaveTextContent(
      "/savia-request?view=secretos",
    );
    expect(screen.getByTestId("active-flow")).toHaveTextContent(
      "Autos editado",
    );
  });

  it("keeps a dirty draft when leaving the route and returning", async () => {
    const user = userEvent.setup();
    function LeaveAndReturn() {
      const workspace = useSaviaRequestWorkspace();
      const navigate = useNavigate();
      return (
        <>
          <WorkspaceProbe />
          <button type="button" onClick={() => navigate("/my-day")}>
            Salir a Mi día
          </button>
          <button
            type="button"
            onClick={() => navigate("/savia-request?flow=autos&step=0")}
          >
            Volver a Savia Request
          </button>
          <p data-testid="flows-count">{workspace.flows.length}</p>
        </>
      );
    }
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/flows")) {
        return [
          { id: autos.id, name: autos.name, steps: autos.steps },
          { id: hogar.id, name: hogar.name, steps: hogar.steps },
        ];
      }
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) return autos;
      if (path.endsWith("/flows/hogar")) return hogar;
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const put = vi.fn().mockResolvedValue({ ok: true });
    const services = {
      apiClient: { get, put, post: vi.fn(), delete: vi.fn(), request: vi.fn() },
    } as unknown as AppServices;
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={services}>
          <SaviaRequestProvider>
            <LeaveAndReturn />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Autos");
    await user.click(screen.getByRole("button", { name: "Editar autos" }));
    expect(await screen.findByTestId("active-flow")).toHaveTextContent(
      "Autos editado",
    );
    await user.click(screen.getByRole("button", { name: "Salir a Mi día" }));
    // Al salir se conserva en memoria: el borrador sigue intacto.
    await user.click(
      screen.getByRole("button", { name: "Volver a Savia Request" }),
    );
    expect(await screen.findByTestId("active-flow")).toHaveTextContent(
      "Autos editado",
    );
    // La revalidación no sobrescribe el borrador ni lo guarda sola.
    expect(put).not.toHaveBeenCalled();
  });

  it("shows the cached flows immediately on return and revalidates", async () => {
    const user = userEvent.setup();
    let version = 0;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/flows")) {
        version += 1;
        return version === 1
          ? [{ id: autos.id, name: autos.name, steps: autos.steps }]
          : [
              { id: autos.id, name: autos.name, steps: autos.steps },
              { id: hogar.id, name: hogar.name, steps: hogar.steps },
            ];
      }
      if (path.endsWith("/folders")) return ["Cotizaciones"];
      if (path.endsWith("/flows/autos")) return autos;
      if (path.endsWith("/flows/hogar")) return hogar;
      throw new Error(`Ruta inesperada: ${path}`);
    });
    const services = {
      apiClient: {
        get,
        put: vi.fn().mockResolvedValue({ ok: true }),
        post: vi.fn(),
        delete: vi.fn(),
        request: vi.fn(),
      },
    } as unknown as AppServices;
    function LeaveAndReturn() {
      const navigate = useNavigate();
      return (
        <>
          <WorkspaceProbe />
          <button type="button" onClick={() => navigate("/my-day")}>
            Salir
          </button>
          <button
            type="button"
            onClick={() => navigate("/savia-request?flow=autos&step=0")}
          >
            Volver
          </button>
        </>
      );
    }
    render(
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider services={services}>
          <SaviaRequestProvider>
            <LeaveAndReturn />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>,
    );
    await screen.findByText("Autos");
    const callsOnFirstVisit = get.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Salir" }));
    await user.click(screen.getByRole("button", { name: "Volver" }));
    // Contenido útil inmediato desde caché, sin pantalla de carga vacía.
    expect(await screen.findByTestId("active-flow")).toHaveTextContent("Autos");
    await waitFor(() =>
      expect(get.mock.calls.length).toBeGreaterThan(callsOnFirstVisit),
    );
  });
});

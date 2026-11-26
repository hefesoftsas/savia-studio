import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Link, MemoryRouter, useLocation } from "react-router-dom";
import { ApiClientError } from "@/api/api-client";
import type { AppServices } from "@/app-services";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import { SaviaRequestProvider } from "./savia-request-provider";
import { SaviaRequestWorkspace } from "./savia-request-workspace";
import type { RequestFlow, RequestRun } from "./types";

vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
}));

const autos: RequestFlow = {
  id: "autos",
  name: "Autos",
  folderPath: "Cotizaciones",
  description: "Cotiza autos livianos.",
  input: { plate: "TESTCAR" },
  variables: [],
  versions: [],
  steps: [
    {
      id: "cotizar",
      name: "Cotizar auto",
      url: "https://provider.test/autos",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      bodyType: "json",
      pre: "",
      post: "",
    },
  ],
};

const run: RequestRun = {
  id: "run-1",
  flowId: "autos",
  mode: "mock",
  status: "success",
  createdAt: "2026-09-07T00:00:00Z",
  versionId: null,
  steps: [],
  result: { premiumTotal: 1200000, quoteNumber: "SIM-1" },
};

const hogar = { ...autos, id: "hogar", name: "Hogar" };
const configuredToken = {
  key: "token",
  value: "",
  secret: true,
  configured: true,
};
const hogarRun: RequestRun = {
  ...run,
  id: "run-hogar",
  flowId: hogar.id,
  mode: "live",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setRunInput(value: Record<string, string>) {
  const field = screen.getByRole("textbox", { name: "Entrada JSON" });
  const editor = EditorView.findFromDOM(field);
  if (!editor) throw new Error("Run input editor not mounted");
  act(() => {
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: JSON.stringify(value),
      },
    });
  });
  return field;
}

function WorkspaceAddress() {
  const { search } = useLocation();
  return <output data-testid="workspace-address">{search}</output>;
}

function renderWorkspace(
  flows: RequestFlow[] = [autos],
  listRuns: (path: string) => RequestRun[] | Promise<RequestRun[]> = () => [],
  beforeRead?: (path: string) => void | Promise<void>,
) {
  let remainingFlows = [...flows];
  const get = vi.fn(async (path: string) => {
    if (beforeRead) await beforeRead(path);
    if (path.endsWith("/flows")) {
      return remainingFlows.map(({ id, name, folderPath, steps }) => ({
        id,
        name,
        folderPath,
        steps,
      }));
    }
    if (path.endsWith("/folders")) return ["Cotizaciones"];
    if (path.endsWith("/runs")) return listRuns(path);
    const matched = remainingFlows.find((flow) =>
      path.endsWith(`/flows/${flow.id}`),
    );
    if (matched) return matched;
    if (path.includes("/flows/"))
      throw new ApiClientError(404, "NOT_FOUND", "Flow no encontrado.");
    throw new Error(`Ruta inesperada: ${path}`);
  });
  const put = vi.fn().mockResolvedValue({ ok: true });
  const revealVariable = vi.fn().mockResolvedValue({ value: "fixture-value" });
  const post = vi.fn(async (path: string, body?: unknown) =>
    path.endsWith("/variables/reveal") ? revealVariable(body) : run,
  );
  const remove = vi.fn(async (path: string) => {
    const id = path.split("/").at(-1);
    remainingFlows = remainingFlows.filter((flow) => flow.id !== id);
  });
  const services = {
    apiClient: { get, put, post, delete: remove, request: vi.fn() },
    requestResults: {
      read: vi.fn().mockRejectedValue(new Error("not normalized")),
    },
  } as unknown as AppServices;
  render(
    <MemoryRouter
      initialEntries={[`/savia-request?flow=${flows[0]?.id ?? "autos"}&step=0`]}
    >
      <AppServicesProvider services={services}>
        <SaviaRequestProvider>
          <SaviaRequestWorkspace />
          <WorkspaceAddress />
          {flows.map(({ id, name }) => (
            <Link key={id} to={`/savia-request?flow=${id}&step=0`}>
              Open {name}
            </Link>
          ))}
          <Link to="/savia-request?view=secretos">Open Secretos</Link>
        </SaviaRequestProvider>
      </AppServicesProvider>
    </MemoryRouter>,
  );
  return {
    get,
    post,
    put,
    remove,
    revealVariable,
    storeFlow: (flow: RequestFlow) => remainingFlows.push(flow),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SaviaRequestWorkspace", () => {
  it.each([
    { action: "Guardar", notice: "Cambios guardados.", publishes: false },
    {
      action: "Publicar versión",
      notice: "Versión publicada.",
      publishes: true,
    },
  ])(
    "completes $action after a successful save and a failed catalog refresh",
    async ({ action, notice, publishes }) => {
      const user = userEvent.setup();
      const { get, post, put } = renderWorkspace();
      const name = await screen.findByRole("textbox", {
        name: "Nombre del flow",
      });
      fireEvent.change(name, { target: { value: "Autos actualizado" } });
      get.mockRejectedValueOnce(new Error("Navigation refresh interrupted"));

      await user.click(screen.getByRole("button", { name: action }));

      expect(await screen.findByText(notice)).toBeVisible();
      expect(
        screen.getByRole("option", { name: "Autos actualizado" }),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(put).toHaveBeenCalledOnce();
      const publishCalls = post.mock.calls.filter(([path]) =>
        path.endsWith("/flows/autos/publish"),
      );
      expect(publishCalls).toHaveLength(publishes ? 1 : 0);
    },
  );

  it("shows a configured secret without editing or resaving its value", async () => {
    const user = userEvent.setup();
    const endpoint = {
      key: "endpoint",
      value: "https://original.test",
      secret: false,
    };
    const { revealVariable, put } = renderWorkspace([
      { ...autos, variables: [configuredToken, endpoint] },
    ]);

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    const field = screen.getByLabelText("Valor de token");
    await user.click(screen.getByRole("button", { name: "Mostrar" }));

    expect(field).toHaveValue("fixture-value");
    expect(screen.queryByText(/Cambios sin guardar/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ocultar" }));
    expect(field).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(revealVariable).toHaveBeenCalledTimes(2);

    const editable = screen.getByLabelText("Valor de endpoint");
    await user.clear(editable);
    await user.type(editable, "https://updated.test");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const variables = [
      configuredToken,
      { ...endpoint, value: "https://updated.test" },
    ];
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos/variables",
        {
          flow: expect.objectContaining({ id: "autos", variables: [] }),
          variables,
        },
      ),
    );
    expect(put).not.toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos",
      expect.anything(),
    );
  });

  it("waits for edited variables to save before switching flows", async () => {
    const user = userEvent.setup();
    const saved = deferred<{ ok: boolean }>();
    const { put } = renderWorkspace([
      { ...autos, variables: [configuredToken] },
      hogar,
    ]);
    put.mockImplementation(async (path: string) =>
      path.endsWith("/variables") ? saved.promise : { ok: true },
    );

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.type(screen.getByLabelText("Valor de token"), "new-fixture");
    await user.selectOptions(screen.getByLabelText("Flow activo"), "hogar");

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos/variables",
        expect.objectContaining({
          variables: [{ ...configuredToken, value: "new-fixture" }],
        }),
      ),
    );
    expect(screen.getByRole("heading", { name: "Autos" })).toBeVisible();
    expect(screen.getByText(/Cambios sin guardar/)).toBeVisible();
    await act(async () => saved.resolve({ ok: true }));
    expect(await screen.findByRole("heading", { name: "Hogar" })).toBeVisible();
  });

  it("keeps a failed variable edit available for correcting or retrying", async () => {
    const user = userEvent.setup();
    const { put } = renderWorkspace([
      { ...autos, variables: [configuredToken] },
    ]);
    const saveVariables = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError(
          400,
          "HTTP_400",
          "Para desmarcar un secreto debes reemplazar su valor.",
        ),
      )
      .mockResolvedValue({ ok: true });
    put.mockImplementation(async (path: string, body: unknown) =>
      path.endsWith("/variables") ? saveVariables(body) : { ok: true },
    );

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.type(screen.getByLabelText("Nombre del flow"), " editado");
    await user.click(screen.getByRole("checkbox", { name: "Secreto token" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(
      await screen.findByText(
        "Para desmarcar un secreto debes reemplazar su valor.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/Cambios sin guardar/)).toBeVisible();
    expect(put).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("checkbox", { name: "Secreto token" }),
    ).not.toBeChecked();

    await user.type(
      screen.getByLabelText("Valor de token"),
      "replacement-fixture",
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Cambios guardados.")).toBeVisible();
    expect(screen.queryByText(/Cambios sin guardar/)).not.toBeInTheDocument();
    expect(saveVariables).toHaveBeenLastCalledWith({
      flow: expect.objectContaining({ name: "Autos editado", variables: [] }),
      variables: [
        { ...configuredToken, value: "replacement-fixture", secret: false },
      ],
    });
  });

  it("discards a secret reveal that finishes after switching flows", async () => {
    const user = userEvent.setup();
    const reveal = deferred<{ value: string }>();
    const { post, revealVariable } = renderWorkspace([
      { ...autos, variables: [configuredToken] },
      { ...hogar, variables: [configuredToken] },
    ]);
    revealVariable.mockReturnValueOnce(reveal.promise);

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(post).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/variables/reveal",
      { key: "token" },
    );
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    await screen.findByRole("heading", { name: "Hogar" });
    await act(async () => reveal.resolve({ value: "fixture-value" }));

    expect(screen.getByRole("heading", { name: "Hogar" })).toBeVisible();
    expect(screen.getByLabelText("Valor de token")).toHaveValue("");
    expect(screen.queryByText(/Cambios sin guardar/)).not.toBeInTheDocument();
  });

  it("keeps a replacement typed while a secret reveal is pending", async () => {
    const user = userEvent.setup();
    const reveal = deferred<{ value: string }>();
    const { revealVariable, put } = renderWorkspace([
      { ...autos, variables: [configuredToken] },
    ]);
    revealVariable.mockReturnValueOnce(reveal.promise);

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    const field = screen.getByLabelText("Valor de token");
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    await user.type(field, "new-fixture");
    await act(async () => reveal.resolve({ value: "fixture-value" }));

    expect(field).toHaveValue("new-fixture");
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(field).toHaveAttribute("type", "text");
    await user.clear(field);
    await user.type(field, "updated-fixture");
    expect(field).toHaveAttribute("type", "text");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos/variables",
        {
          flow: expect.objectContaining({ variables: [] }),
          variables: [{ ...configuredToken, value: "updated-fixture" }],
        },
      ),
    );
    expect(await screen.findByText("Cambios guardados.")).toBeVisible();
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveValue("");
    expect(put).not.toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos",
      expect.anything(),
    );
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(revealVariable).toHaveBeenCalledTimes(2);
  });

  it("uses the persisted variables returned by the save endpoint", async () => {
    const user = userEvent.setup();
    const inherited = {
      key: "endpoint",
      value: "https://platform.test",
      secret: false,
    };
    const { put } = renderWorkspace([
      {
        ...autos,
        variables: [
          { ...inherited, value: "https://override.test", overridden: true },
        ],
      },
    ]);
    put.mockImplementation(async (path: string) =>
      path.endsWith("/variables")
        ? { ok: true, variables: [inherited] }
        : { ok: true },
    );
    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.click(screen.getByRole("button", { name: "Eliminar endpoint" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Eliminar",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByText("Cambios guardados.")).toBeVisible();
    expect(screen.getByLabelText("Valor de endpoint")).toHaveValue(
      "https://platform.test",
    );
    expect(put).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/variables",
      expect.objectContaining({ variables: [] }),
    );
  });

  it("keeps focus while typing a new variable key", async () => {
    const user = userEvent.setup();
    const { put } = renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.click(screen.getByRole("button", { name: "Agregar variable" }));
    const key = screen.getByLabelText("Clave 1");
    await user.type(key, "service_token");

    expect(screen.getByLabelText("Clave 1")).toBe(key);
    expect(key).toHaveFocus();
    expect(key).toHaveValue("service_token");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Cambios guardados.")).toBeVisible();
    expect(put).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/variables",
      expect.objectContaining({
        variables: [{ key: "service_token", secret: false, value: "" }],
      }),
    );
  });

  it("requires a replacement before saving a renamed configured secret", async () => {
    const user = userEvent.setup();
    const { put, revealVariable } = renderWorkspace([
      { ...autos, variables: [configuredToken] },
    ]);
    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    fireEvent.change(screen.getByLabelText("Clave 1"), {
      target: { value: "access_token" },
    });
    const field = screen.getByLabelText("Valor de access_token");
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Escribe un valor para cambiar la clave de un secreto guardado.",
    );
    expect(put).not.toHaveBeenCalled();
    expect(revealVariable).not.toHaveBeenCalled();
    expect(screen.getByText(/Cambios sin guardar/)).toBeVisible();

    await user.type(field, "replacement-fixture");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(await screen.findByText("Cambios guardados.")).toBeVisible();
    expect(put).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/variables",
      expect.objectContaining({
        variables: [
          expect.objectContaining({
            key: "access_token",
            secret: true,
            value: "replacement-fixture",
          }),
        ],
      }),
    );
    expect(screen.getByLabelText("Valor de access_token")).toHaveValue("");
  });

  it("lets the user retry a failed secret reveal and clears it on leaving Variables", async () => {
    const user = userEvent.setup();
    const { revealVariable } = renderWorkspace([
      { ...autos, variables: [configuredToken] },
    ]);
    revealVariable
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce({ value: "fixture-value" });

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se pudo mostrar el secreto.",
    );
    await user.click(screen.getByRole("button", { name: "Mostrar" }));
    expect(screen.getByLabelText("Valor de token")).toHaveValue(
      "fixture-value",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: /Pasos/ }));
    await user.click(screen.getByRole("tab", { name: "Variables" }));
    expect(screen.getByLabelText("Valor de token")).toHaveValue("");
  });

  it("keeps the visible history when an older flow's first read finishes late", async () => {
    const previous = deferred<RequestRun[]>();
    const listRuns = vi.fn((path: string) =>
      path.endsWith("/autos/runs") ? previous.promise : [hogarRun],
    );
    const user = userEvent.setup();
    renderWorkspace([autos, hogar], listRuns);

    await screen.findByRole("heading", { name: "Autos" });
    await waitFor(() =>
      expect(listRuns).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos/runs",
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Historial" }));
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    await screen.findByRole("heading", { name: "Hogar" });
    expect(await screen.findByRole("cell", { name: "Real" })).toBeVisible();

    await act(async () => {
      previous.resolve([run]);
      await previous.promise;
    });
    expect(screen.getByRole("cell", { name: "Real" })).toBeVisible();
    expect(
      screen.queryByRole("cell", { name: "Simulado" }),
    ).not.toBeInTheDocument();
  });

  it("hides the previous flow's populated history during a switch with a pending refresh", async () => {
    const previousRefresh = deferred<RequestRun[]>();
    const nextHistory = deferred<RequestRun[]>();
    let previousReads = 0;
    const listRuns = vi.fn((path: string) => {
      if (!path.endsWith("/autos/runs")) return nextHistory.promise;
      return ++previousReads === 1 ? [run] : previousRefresh.promise;
    });
    const user = userEvent.setup();
    renderWorkspace([autos, hogar], listRuns);
    await user.click(await screen.findByRole("tab", { name: "Historial" }));
    expect(await screen.findByRole("cell", { name: "Simulado" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(previousReads).toBe(2);
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    await screen.findByRole("heading", { name: "Hogar" });
    expect(
      screen.queryByRole("cell", { name: "Simulado" }),
    ).not.toBeInTheDocument();

    await act(async () => {
      nextHistory.resolve([hogarRun]);
      previousRefresh.resolve([run]);
      await Promise.all([nextHistory.promise, previousRefresh.promise]);
    });
    expect(screen.getByRole("cell", { name: "Real" })).toBeVisible();
    expect(
      screen.queryByRole("cell", { name: "Simulado" }),
    ).not.toBeInTheDocument();
  });

  it("leaves the new flow's selected tab in place when an earlier execution completes", async () => {
    const previousRun = deferred<RequestRun>();
    const user = userEvent.setup();
    const { post } = renderWorkspace([autos, hogar], (path) =>
      path.endsWith("/hogar/runs") ? [hogarRun] : [],
    );
    const earlierRunPath = "/v1/savia-request/api/flows/autos/runs";
    post.mockImplementation((path: string) =>
      path === earlierRunPath ? previousRun.promise : Promise.resolve(run),
    );
    await user.click(
      await screen.findByRole("button", { name: "Ejecutar simulación" }),
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(earlierRunPath, {
        input: { plate: "TESTCAR" },
        mode: "mock",
      }),
    );
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    await screen.findByRole("heading", { name: "Hogar" });
    await user.click(screen.getByRole("tab", { name: "Historial" }));
    expect(await screen.findByRole("cell", { name: "Real" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Actualizar" })).toBeEnabled();

    await act(async () => {
      previousRun.resolve(run);
      await previousRun.promise;
    });
    expect(screen.getByRole("tab", { name: "Historial" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("cell", { name: "Real" })).toBeVisible();
    expect(screen.queryByText(/Simulación completada/)).not.toBeInTheDocument();
  });

  it("removes visible history when an update is denied for the current flow", async () => {
    const user = userEvent.setup();
    const listRuns = vi
      .fn()
      .mockResolvedValueOnce([run])
      .mockRejectedValue(
        new ApiClientError(403, "forbidden", "History access denied"),
      );
    renderWorkspace([autos], listRuns);
    await user.click(await screen.findByRole("tab", { name: "Historial" }));
    expect(await screen.findByRole("cell", { name: "Simulado" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Actualizar" }));

    expect(await screen.findByText("History access denied")).toBeVisible();
    expect(
      screen.queryByRole("cell", { name: "Simulado" }),
    ).not.toBeInTheDocument();
  });

  it("keeps the newest history when the first read finishes after a manual refresh", async () => {
    const user = userEvent.setup();
    const initial = deferred<RequestRun[]>();
    const listRuns = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockResolvedValue([run]);
    renderWorkspace([autos], listRuns);
    await user.click(await screen.findByRole("tab", { name: "Historial" }));
    await user.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(await screen.findByRole("cell", { name: "Simulado" })).toBeVisible();

    await act(async () => {
      initial.resolve([]);
      await initial.promise;
    });
    expect(screen.getByRole("cell", { name: "Simulado" })).toBeVisible();
  });

  it("saves the edited draft before running a simulation", async () => {
    const user = userEvent.setup();
    const { post, put } = renderWorkspace();

    await user.clear(await screen.findByLabelText("Nombre del flow"));
    await user.type(
      screen.getByLabelText("Nombre del flow"),
      "Autos actualizado",
    );
    await user.click(screen.getByRole("tab", { name: "Ejecutar" }));
    setRunInput({ plate: "FIXTURE-RUN" });
    await user.click(
      screen.getAllByRole("button", { name: "Ejecutar simulación" }).at(-1)!,
    );

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos",
        expect.objectContaining({
          name: "Autos actualizado",
          input: { plate: "TESTCAR" },
        }),
      ),
    );
    expect(post).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/runs",
      { input: { plate: "FIXTURE-RUN" }, mode: "mock" },
    );
    expect(put).not.toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/variables",
      expect.anything(),
    );
  });

  it("sends temporary operation input only to the run until explicitly saved", async () => {
    const user = userEvent.setup();
    const { post, put } = renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Ejecutar" }));
    setRunInput({ plate: "FIXTURE-RUN" });

    await user.click(
      screen.getAllByRole("button", { name: "Ejecutar simulación" }).at(-1)!,
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos/runs",
        {
          input: { plate: "FIXTURE-RUN" },
          mode: "mock",
        },
      ),
    );
    expect(put).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos",
        expect.objectContaining({ input: { plate: "FIXTURE-RUN" } }),
      ),
    );
  });

  it("asks the user to save a new input key before executing", async () => {
    const user = userEvent.setup();
    const { post, put } = renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Ejecutar" }));
    setRunInput({ plate: "FIXTURE-RUN", reference: "test" });

    await user.click(
      screen.getAllByRole("button", { name: "Ejecutar simulación" }).at(-1)!,
    );
    expect(
      await screen.findByText(
        "Guarda las claves nuevas antes de ejecutar (reference).",
      ),
    ).toBeVisible();
    expect(put).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/runs",
      expect.anything(),
    );

    await user.click(screen.getByRole("button", { name: "Guardar" }));
    await screen.findByText("Cambios guardados.");
    await user.click(
      screen.getAllByRole("button", { name: "Ejecutar simulación" }).at(-1)!,
    );
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos/runs",
        {
          input: { plate: "FIXTURE-RUN", reference: "test" },
          mode: "mock",
        },
      ),
    );
  });

  it("restores the selected flow's saved input without writing to the server", async () => {
    const user = userEvent.setup();
    const { post, put } = renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Ejecutar" }));
    const field = setRunInput({ plate: "FIXTURE-RUN" });
    expect(field).toHaveTextContent("FIXTURE-RUN");

    await user.click(
      screen.getByRole("button", { name: "Restaurar entrada del flow" }),
    );

    expect(
      screen.getByRole("textbox", { name: "Entrada JSON" }),
    ).toHaveTextContent("TESTCAR");
    await user.click(
      screen.getAllByRole("button", { name: "Ejecutar simulación" }).at(-1)!,
    );
    expect(post).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/runs",
      {
        input: { plate: "TESTCAR" },
        mode: "mock",
      },
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("publishes the flow without copying temporary operation input into its definition", async () => {
    const user = userEvent.setup();
    const { post, put } = renderWorkspace();
    await user.click(await screen.findByRole("tab", { name: "Ejecutar" }));
    setRunInput({ plate: "FIXTURE-RUN" });
    await user.click(screen.getByRole("button", { name: "Publicar versión" }));

    expect(await screen.findByText("Versión publicada.")).toBeVisible();
    expect(post).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/autos/publish",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("retries opening the confirmed copy after a catalog error without duplicating again", async () => {
    const user = userEvent.setup();
    const copy = { ...autos, id: "request-copy", name: "Autos (copia)" };
    const path = "/v1/savia-request/api/flows/autos/duplicate";
    let failCatalog = false;
    const { post, storeFlow } = renderWorkspace(
      [autos],
      undefined,
      (address) => {
        if (failCatalog && address.endsWith("/flows")) {
          failCatalog = false;
          throw new Error("Se interrumpió la carga de la copia.");
        }
      },
    );
    const duplicate = post.getMockImplementation()!;
    post.mockImplementation(async (address, body) => {
      if (address !== path) return duplicate(address, body);
      storeFlow(copy);
      failCatalog = true;
      return { id: copy.id, name: copy.name };
    });

    await user.click(await screen.findByRole("button", { name: "Duplicar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Se interrumpió la carga de la copia.",
    );
    expect(screen.getByTestId("workspace-address")).toHaveTextContent(
      "?flow=request-copy&step=0",
    );
    await user.click(
      screen.getByRole("button", { name: "Reintentar selección" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Autos (copia)" }),
    ).toBeVisible();
    expect(
      post.mock.calls.filter(([address]) => address === path),
    ).toHaveLength(1);
  });

  it("keeps the destination editor when an earlier duplication completes", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const copy = { ...autos, id: "request-copy", name: "Autos (copia)" };
    const path = "/v1/savia-request/api/flows/autos/duplicate";
    const { post, storeFlow } = renderWorkspace([autos, hogar]);
    const duplicate = post.getMockImplementation()!;
    post.mockImplementation(async (address, body) => {
      if (address !== path) return duplicate(address, body);
      await pending.promise;
      storeFlow(copy);
      return { id: copy.id, name: copy.name };
    });

    await user.click(await screen.findByRole("button", { name: "Duplicar" }));
    await waitFor(() =>
      expect(post.mock.calls.some(([address]) => address === path)).toBe(true),
    );
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    expect(await screen.findByRole("heading", { name: "Hogar" })).toBeVisible();
    await act(async () => pending.resolve());

    expect(screen.getByRole("heading", { name: "Hogar" })).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Autos (copia)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Flow duplicado con sus pasos y variables."),
    ).not.toBeInTheDocument();
  });

  it("starts the next flow with its own input after editing the previous operation", async () => {
    const user = userEvent.setup();
    const { put } = renderWorkspace([
      autos,
      { ...hogar, input: { plate: "OTHER-FLOW" } },
    ]);
    await user.click(await screen.findByRole("tab", { name: "Ejecutar" }));
    setRunInput({ plate: "FIXTURE-RUN" });
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));

    expect(await screen.findByRole("heading", { name: "Hogar" })).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Entrada JSON" }),
    ).toHaveTextContent("OTHER-FLOW");
    expect(put).not.toHaveBeenCalled();
  });

  it.each(["retry action", "flow selector"])(
    "retries a failed selection through the %s while keeping the current editor",
    async (method) => {
      const user = userEvent.setup();
      const pending = deferred<void>();
      let reads = 0;
      renderWorkspace([autos, hogar], undefined, (path) => {
        if (!path.endsWith("/flows/hogar")) return;
        if (++reads === 1) throw new Error("Se interrumpió la carga de Hogar.");
        return pending.promise;
      });

      const field = await screen.findByLabelText("Nombre del flow");
      await user.selectOptions(screen.getByLabelText("Flow activo"), "hogar");
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Se interrumpió la carga de Hogar.",
      );
      expect(screen.getByLabelText("Nombre del flow")).toBe(field);

      if (method === "retry action") {
        await user.click(
          screen.getByRole("button", { name: "Reintentar selección" }),
        );
      } else {
        await user.selectOptions(screen.getByLabelText("Flow activo"), "hogar");
      }
      await waitFor(() => expect(reads).toBe(2));
      expect(screen.getByLabelText("Nombre del flow")).toBe(field);
      await act(async () => pending.resolve());

      expect(
        await screen.findByRole("heading", { name: "Hogar" }),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("returns to the current flow URL with its draft after a failed selection", async () => {
    const user = userEvent.setup();
    const { put, get } = renderWorkspace([autos, hogar], undefined, (path) => {
      if (path.endsWith("/flows/hogar"))
        throw new Error("Se interrumpió la carga de Hogar.");
    });
    const field = await screen.findByLabelText("Nombre del flow");
    await user.selectOptions(screen.getByLabelText("Flow activo"), "hogar");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Se interrumpió la carga de Hogar.",
    );
    await user.type(field, " actualizados");

    await user.click(
      screen.getByRole("button", { name: "Volver al flow actual" }),
    );

    expect(screen.getByTestId("workspace-address")).toHaveTextContent(
      "?flow=autos&step=0",
    );
    expect(screen.getByLabelText("Nombre del flow")).toHaveValue(
      "Autos actualizados",
    );
    expect(screen.getByText(/Cambios sin guardar/)).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(
      get.mock.calls.filter(([path]) => path.endsWith("/flows/hogar")),
    ).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("defaults to simulation when switching flows after choosing real execution", async () => {
    const user = userEvent.setup();
    const { post } = renderWorkspace([autos, hogar]);
    await user.selectOptions(
      await screen.findByRole("combobox", { name: "Modo de ejecución" }),
      "live",
    );
    expect(screen.getByRole("button", { name: "Ejecutar real" })).toBeEnabled();

    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    await screen.findByRole("heading", { name: "Hogar" });
    expect(
      screen.getByRole("combobox", { name: "Modo de ejecución" }),
    ).toHaveValue("mock");
    await user.click(
      screen.getByRole("button", { name: "Ejecutar simulación" }),
    );
    expect(post).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/hogar/runs",
      {
        input: { plate: "TESTCAR" },
        mode: "mock",
      },
    );

    await user.click(screen.getByRole("link", { name: "Open Autos" }));
    await screen.findByRole("heading", { name: "Autos" });
    expect(
      screen.getAllByRole("combobox", { name: "Modo de ejecución" })[0],
    ).toHaveValue("mock");
  });

  it.each([
    { chosen: "mock", historical: "live", label: "Real" },
    { chosen: "live", historical: "mock", label: "Simulación" },
  ] as const)(
    "keeps $chosen selected when opening a previous $historical result",
    async ({ chosen, historical, label }) => {
      const user = userEvent.setup();
      renderWorkspace([autos], () => [{ ...run, mode: historical }]);
      await user.selectOptions(
        await screen.findByRole("combobox", { name: "Modo de ejecución" }),
        chosen,
      );
      await user.click(screen.getByRole("tab", { name: "Historial" }));
      await user.click(
        await screen.findByRole("button", { name: "Ver resultado" }),
      );

      expect(screen.getByText(`Completado · ${label}`)).toBeVisible();
      const selectors = screen.getAllByRole("combobox", {
        name: "Modo de ejecución",
      });
      expect(selectors).toHaveLength(2);
      for (const selector of selectors) expect(selector).toHaveValue(chosen);
    },
  );

  it("configures Basic Auth in the native headers editor", async () => {
    const user = userEvent.setup();
    const { put } = renderWorkspace();

    await user.click(
      await screen.findByRole("tab", { name: "Headers / Auth" }),
    );
    await user.selectOptions(screen.getByLabelText("Autenticación"), "basic");
    await user.type(screen.getByLabelText("Usuario (variable)"), "auth_user");
    await user.type(
      screen.getByLabelText("Contraseña (variable)"),
      "auth_password",
    );
    await user.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() =>
      expect(put).toHaveBeenCalledWith(
        "/v1/savia-request/api/flows/autos",
        expect.objectContaining({
          steps: [
            expect.objectContaining({
              auth: { username: "auth_user", password: "auth_password" },
            }),
          ],
        }),
      ),
    );
  });

  it("clears the editor after deleting the last flow", async () => {
    const user = userEvent.setup();
    const { remove } = renderWorkspace([autos]);

    await screen.findByRole("heading", { name: "Autos" });
    await user.click(screen.getAllByRole("button", { name: "Eliminar" })[0]);
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("/v1/savia-request/api/flows/autos", {
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "No hay flows todavía" }),
    ).toBeVisible();
  });

  it("closes an unconfirmed flow deletion when navigation changes the selected flow", async () => {
    const user = userEvent.setup();
    const { remove } = renderWorkspace([autos, hogar]);
    const nextFlow = screen.getByRole("link", { name: "Open Hogar" });
    await screen.findByRole("heading", { name: "Autos" });
    await user.click(screen.getAllByRole("button", { name: "Eliminar" })[0]);
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /Eliminar «Autos»/,
    );

    fireEvent.click(nextFlow);

    await screen.findByText("Hogar", { selector: "h1" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it("clears a successfully deleted flow when the first list refresh fails", async () => {
    const user = userEvent.setup();
    const { get, remove } = renderWorkspace();
    const deleteFlow = remove.getMockImplementation()!;
    const failedRefresh = vi.fn(() => {
      throw new Error("Navigation refresh interrupted");
    });
    remove.mockImplementationOnce(async (path: string) => {
      await deleteFlow(path);
      get.mockImplementationOnce(async () => failedRefresh());
    });

    await screen.findByRole("heading", { name: "Autos" });
    await user.click(screen.getAllByRole("button", { name: "Eliminar" })[0]);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Eliminar",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "No hay flows todavía" }),
    ).toBeVisible();
    expect(failedRefresh).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });

  it("preserves the current flow when an earlier deletion finishes", async () => {
    const user = userEvent.setup();
    const deletion = deferred<void>();
    const { remove } = renderWorkspace([autos, hogar]);
    const deleteFlow = remove.getMockImplementation()!;
    remove.mockImplementationOnce(async (path: string) => {
      await deletion.promise;
      await deleteFlow(path);
    });
    const nextFlow = screen.getByRole("link", { name: "Open Hogar" });
    await screen.findByRole("heading", { name: "Autos" });
    await user.click(screen.getAllByRole("button", { name: "Eliminar" })[0]);
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Eliminar",
      }),
    );
    expect(remove).toHaveBeenCalledTimes(1);

    fireEvent.click(nextFlow);
    await screen.findByText("Hogar", { selector: "h1" });
    await act(async () => deletion.resolve());

    expect(screen.getByRole("heading", { name: "Hogar" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Autos" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("offers a first-flow action when the workspace has no flows", async () => {
    renderWorkspace([]);

    expect(
      await screen.findByRole("heading", { name: "No hay flows todavía" }),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Crear flow" })).toBeEnabled(),
    );
  });

  it("lets the user retry creation with the same identifier after a failed write", async () => {
    const user = userEvent.setup();
    const { put, storeFlow } = renderWorkspace([]);
    put.mockRejectedValueOnce(new Error("Se interrumpió el guardado."));
    put.mockImplementation(async (_path: string, draft: RequestFlow) => {
      storeFlow(draft);
      return { ok: true };
    });

    await user.click(await screen.findByRole("button", { name: "Crear flow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Se interrumpió el guardado.",
    );
    await user.click(
      screen.getByRole("button", { name: "Reintentar creación" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Nuevo flow" }),
    ).toBeVisible();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][0]).toBe(put.mock.calls[1][0]);
  });

  it("opens the created flow without writing it again if the initial response was lost", async () => {
    const user = userEvent.setup();
    const { put, storeFlow } = renderWorkspace([]);
    put.mockImplementation(async (_path: string, draft: RequestFlow) => {
      storeFlow(draft);
      throw new Error("No se recibió la confirmación.");
    });

    await user.click(await screen.findByRole("button", { name: "Crear flow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No se recibió la confirmación.",
    );
    await user.click(
      screen.getByRole("button", { name: "Reintentar creación" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Nuevo flow" }),
    ).toBeVisible();
    expect(put).toHaveBeenCalledOnce();
  });

  it("retries loading an already-created flow after a catalog refresh failure", async () => {
    const user = userEvent.setup();
    let failCatalog = false;
    const { put, storeFlow } = renderWorkspace([], undefined, (path) => {
      if (failCatalog && path.endsWith("/flows")) {
        failCatalog = false;
        throw new Error("Se interrumpió la lectura del catálogo.");
      }
    });
    put.mockImplementation(async (_path: string, draft: RequestFlow) => {
      storeFlow(draft);
      failCatalog = true;
      return { ok: true };
    });

    await user.click(await screen.findByRole("button", { name: "Crear flow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Se interrumpió la lectura del catálogo.",
    );
    await user.click(screen.getByRole("button", { name: "Reintentar" }));

    expect(
      await screen.findByRole("heading", { name: "Nuevo flow" }),
    ).toBeVisible();
    expect(put).toHaveBeenCalledOnce();
  });

  it("keeps the destination view when an earlier create finishes", async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const { put, storeFlow } = renderWorkspace([]);
    put.mockImplementation(async (_path: string, draft: RequestFlow) => {
      await pending.promise;
      storeFlow(draft);
      return { ok: true };
    });

    await user.click(await screen.findByRole("button", { name: "Crear flow" }));
    expect(put).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("link", { name: "Open Secretos" }));
    expect(
      await screen.findByRole("heading", { name: "Secretos" }),
    ).toBeVisible();
    await act(async () => pending.resolve());

    expect(screen.getByRole("heading", { name: "Secretos" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Nuevo flow" }),
    ).not.toBeInTheDocument();
  });

  it("waits for a successful empty response before inviting the user to create a flow", async () => {
    const pending = deferred<void>();
    renderWorkspace([], undefined, (path) => {
      if (path.endsWith("/flows")) return pending.promise;
    });

    expect(await screen.findByText("Cargando flows…")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "No hay flows todavía" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Crear flow" }),
    ).not.toBeInTheDocument();

    await act(async () => pending.resolve());
    expect(
      await screen.findByRole("heading", { name: "No hay flows todavía" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Crear flow" })).toBeEnabled();
  });

  it.each(["/flows", "/flows/autos"])(
    "retries a failed read of %s in place",
    async (suffix) => {
      const user = userEvent.setup();
      const pending = deferred<void>();
      let attempts = 0;
      const message = "La conexión se interrumpió.";
      renderWorkspace([autos], undefined, (path) => {
        if (!path.endsWith(suffix)) return;
        if (++attempts === 1) throw new Error(message);
        return pending.promise;
      });

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(
        screen.queryByRole("heading", { name: "No hay flows todavía" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Crear flow" }),
      ).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(await screen.findByText("Cargando flows…")).toBeVisible();
      await act(async () => pending.resolve());

      expect(
        await screen.findByRole("heading", { name: "Autos" }),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(attempts).toBe(2);
    },
  );
});

it("defaults the DANE reference service to live without a failing simulation", async () => {
  const { post } = renderWorkspace([
    {
      ...autos,
      id: "dane-city-lookup",
      name: "DANE",
      input: { city: "Bogotá", department: "" },
    },
  ]);
  await screen.findByLabelText("Nombre del flow");
  await userEvent.click(screen.getByRole("button", { name: "Ejecutar real" }));
  await waitFor(() =>
    expect(post).toHaveBeenCalledWith(
      "/v1/savia-request/api/flows/dane-city-lookup/runs",
      { mode: "live", input: { city: "Bogotá", department: "" } },
    ),
  );
});

it("shows the configured HTTP host instead of the source provider when a flow is repointed", async () => {
  const user = userEvent.setup();
  const repointed = {
    ...autos,
    id: "qa-echo",
    name: "QA Echo",
    provider: "DANE",
    steps: [
      {
        ...autos.steps[0]!,
        url: "https://postman-echo.com/post",
      },
    ],
  };
  renderWorkspace([repointed]);

  expect(
    await screen.findByRole("option", { name: "Real · postman-echo.com" }),
  ).toBeInTheDocument();
  await user.click(await screen.findByRole("tab", { name: "Ejecutar" }));
  await user.selectOptions(
    screen.getAllByRole("combobox", { name: "Modo de ejecución" }).at(-1)!,
    "live",
  );
  expect(
    await screen.findByRole("option", {
      name: "postman-echo.com real · ejecuta requests",
    }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(
      "Se enviarán estos datos a postman-echo.com sin reintentos.",
    ),
  ).toBeInTheDocument();
});

it("renders the dedicated secretos screen without selecting a flow", async () => {
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/flows")) return [];
    if (path.endsWith("/folders")) return [];
    throw new Error(`Ruta inesperada: ${path}`);
  });
  const services = {
    apiClient: {
      get,
      put: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
    },
    requestResults: {
      read: vi.fn().mockRejectedValue(new Error("not normalized")),
    },
  } as unknown as AppServices;
  render(
    <MemoryRouter initialEntries={["/savia-request?view=secretos"]}>
      <AppServicesProvider services={services}>
        <SaviaRequestProvider>
          <SaviaRequestWorkspace />
        </SaviaRequestProvider>
      </AppServicesProvider>
    </MemoryRouter>,
  );

  expect(
    await screen.findByRole("heading", { name: "Secretos" }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Exportar todos los secretos" }),
  ).toBeVisible();
});

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
import { Link, MemoryRouter } from "react-router-dom";
import type { AppServices } from "@/app-services";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import { clearAllSaviaRequestSnapshots } from "./savia-request-cache";
import { SaviaRequestProvider } from "./savia-request-provider";
import { SaviaRequestWorkspace } from "./savia-request-workspace";
import type { RequestFlow } from "./types";

vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
  usePermissions: () => ({
    permissions: {
      canManageIdentity: false,
      memberships: [{ agencyId: 101, role: "agency_admin" }],
    },
  }),
}));

vi.mock("@/features/tenants/use-current-tenant", () => ({
  useCurrentTenant: () => ({
    isDedicated: true,
    slug: "acme",
    name: "Acme",
    kind: "commercial",
    id: 101,
    monogram: "A",
    isPlatformAdmin: false,
    isLoading: false,
  }),
  formatSlugToDisplayName: (slug: string) => slug,
}));

const autos: RequestFlow = {
  id: "autos",
  name: "Autos",
  folderPath: "Cotizaciones",
  customized: true,
  hasPlatformDefault: true,
  description: "Cotiza autos livianos.",
  input: {},
  variables: [
    {
      key: "endpoint",
      value: "https://a.test",
      secret: false,
      overridden: true,
      hasPlatformDefault: true,
    },
  ],
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

function renderScopedWorkspace(flow = autos, otherFlow?: RequestFlow) {
  let storedFlow = flow;
  const get = vi.fn(async (rawPath: string) => {
    const path = rawPath.split("?")[0];
    if (path.endsWith("/flows")) {
      const entries = otherFlow ? [storedFlow, otherFlow] : [storedFlow];
      return entries.map(({ id, name, folderPath, customized, steps }) => ({
        id,
        name,
        folderPath,
        customized,
        steps,
      }));
    }
    if (path.endsWith("/folders")) return ["Cotizaciones"];
    if (path.endsWith("/flows/autos")) return storedFlow;
    if (otherFlow && path.endsWith(`/flows/${otherFlow.id}`)) return otherFlow;
    if (path.endsWith("/flows/autos/runs")) return [];
    if (path.endsWith("/runs")) return [];
    throw new Error(`Ruta inesperada: ${rawPath}`);
  });
  const post = vi.fn(async (path: string) => {
    if (path.includes("/reset")) {
      storedFlow = {
        ...flow,
        name: "Autos de plataforma",
        customized: false,
        input: { plate: "PLATFORM" },
      };
      return { ok: true, reverted: true };
    }
    return {};
  });
  const put = vi.fn().mockResolvedValue({ ok: true });
  const request = vi.fn(async () => {
    storedFlow = {
      ...storedFlow,
      variables: storedFlow.variables.map((variable) => ({
        ...variable,
        value: "https://platform.test",
        overridden: false,
      })),
    };
    return { ok: true, reverted: true };
  });
  const services = {
    apiClient: {
      get,
      put,
      post,
      delete: vi.fn(),
      request,
    },
    requestResults: { read: vi.fn() },
  } as unknown as AppServices;

  render(
    <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
      <AppServicesProvider services={services}>
        <SaviaRequestProvider>
          <SaviaRequestWorkspace />
          {otherFlow ? (
            <Link to={`/savia-request?flow=${otherFlow.id}&step=0`}>
              Open {otherFlow.name}
            </Link>
          ) : null}
        </SaviaRequestProvider>
      </AppServicesProvider>
    </MemoryRouter>,
  );
  return { get, post, put, request };
}

afterEach(() => {
  cleanup();
  clearAllSaviaRequestSnapshots();
  vi.restoreAllMocks();
});

describe("SaviaRequestWorkspace tenant reset", () => {
  it.each([false, true])(
    "labels a saved tenant copy as customized (variable edit = %s)",
    async (editVariable) => {
      const user = userEvent.setup();
      const { get, put } = renderScopedWorkspace({
        ...autos,
        customized: false,
        variables: autos.variables.map((variable) => ({
          ...variable,
          overridden: false,
        })),
      });
      await screen.findByRole("heading", { name: "Autos" });
      expect(screen.queryByText("Personalizado")).not.toBeInTheDocument();
      if (editVariable) {
        await user.click(screen.getByRole("tab", { name: "Variables" }));
        fireEvent.change(screen.getByLabelText("Valor de endpoint"), {
          target: { value: "https://tenant.test" },
        });
      } else {
        fireEvent.change(
          screen.getByRole("textbox", { name: "Nombre del flow" }),
          { target: { value: "Autos de Acme" } },
        );
      }
      get.mockRejectedValueOnce(new Error("Catalog refresh interrupted"));

      await user.click(screen.getByRole("button", { name: "Guardar" }));

      expect(await screen.findByText("Cambios guardados.")).toBeVisible();
      expect(screen.getByText("Personalizado")).toBeVisible();
      expect(put).toHaveBeenCalledOnce();
      expect(put.mock.calls[0]?.[0]).toBe(
        `/v1/savia-request/api/flows/autos${editVariable ? "/variables" : ""}?tenant=tenant%3A101`,
      );
    },
  );

  it("loads the platform flow after a confirmed reset even if the catalog refresh fails", async () => {
    const user = userEvent.setup();
    const { get, post, put } = renderScopedWorkspace();
    const read = get.getMockImplementation()!;
    let failCatalog = false;
    get.mockImplementation(async (path: string) => {
      if (failCatalog && path.includes("/flows?"))
        throw new Error("Catalog refresh interrupted");
      return read(path);
    });

    const name = await screen.findByRole("textbox", {
      name: "Nombre del flow",
    });
    fireEvent.change(name, { target: { value: "Borrador local" } });
    await user.click(screen.getByRole("tab", { name: "Ejecutar" }));
    const input = screen.getByRole("textbox", { name: "Entrada JSON" });
    const editor = EditorView.findFromDOM(input)!;
    act(() =>
      editor.dispatch({
        changes: {
          from: 0,
          to: editor.state.doc.length,
          insert: '{"plate":"LOCAL"}',
        },
      }),
    );
    expect(input).toHaveTextContent("LOCAL");
    await user.click(screen.getByRole("button", { name: "Restablecer" }));
    failCatalog = true;
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Restablecer",
      }),
    );

    expect(
      await screen.findByRole("heading", { name: "Autos de plataforma" }),
    ).toBeVisible();
    expect(
      await screen.findByText("Flow restablecido a valores de plataforma."),
    ).toBeVisible();
    expect(screen.queryByText("Personalizado")).not.toBeInTheDocument();
    expect(screen.queryByText(/Cambios sin guardar/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Entrada JSON" }),
    ).toHaveTextContent("PLATFORM");
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining("/flows/autos/reset?"),
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("retries loading the flow when a confirmed reset cannot refresh the editor", async () => {
    const user = userEvent.setup();
    const { get, post, put } = renderScopedWorkspace();
    const read = get.getMockImplementation()!;
    let failDetail = false;
    get.mockImplementation(async (path: string) => {
      if (failDetail && path.includes("/flows/autos?")) {
        failDetail = false;
        throw new Error("Detail refresh interrupted");
      }
      return read(path);
    });

    await screen.findByRole("heading", { name: "Autos" });
    await user.click(screen.getByRole("button", { name: "Restablecer" }));
    failDetail = true;
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Restablecer",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Detail refresh interrupted",
    );
    expect(
      screen.queryByRole("button", { name: "Guardar" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(
      await screen.findByRole("heading", { name: "Autos de plataforma" }),
    ).toBeVisible();
    expect(
      post.mock.calls.filter(([path]) => path.includes("/flows/autos/reset?")),
    ).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("shows the customized badge and resets the flow after confirmation", async () => {
    const user = userEvent.setup();
    const { post } = renderScopedWorkspace();

    expect(await screen.findByText("Personalizado")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Restablecer" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Restablecer flow",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Restablecer" }),
    );

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/flows/autos/reset?requirePlatformDefault=true&tenant=tenant%3A101",
        ),
      ),
    );
    expect(
      await screen.findByText("Flow restablecido a valores de plataforma."),
    ).toBeVisible();
  });

  it("resets a single overridden variable from the variables tab", async () => {
    const user = userEvent.setup();
    const { request } = renderScopedWorkspace();

    await screen.findByRole("heading", { name: "Autos" });
    await user.click(screen.getByRole("tab", { name: "Variables" }));
    await user.click(
      await screen.findByRole("button", { name: "Restablecer endpoint" }),
    );

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        expect.stringContaining(
          "/api/flows/autos/variables/endpoint?requirePlatformDefault=true&tenant=tenant%3A101",
        ),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    expect(
      await screen.findByText("«endpoint» volvió al valor de plataforma."),
    ).toBeVisible();
  });

  it("withholds the old variable value while retrying a read after a confirmed restore", async () => {
    const user = userEvent.setup();
    const { get, put, request } = renderScopedWorkspace();
    const read = get.getMockImplementation()!;
    let failDetail = false;
    get.mockImplementation(async (path) => {
      if (failDetail && path.includes("/flows/autos?")) {
        failDetail = false;
        throw new Error("Detail refresh interrupted");
      }
      return read(path);
    });

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    expect(screen.getByLabelText("Valor de endpoint")).toHaveValue(
      "https://a.test",
    );
    failDetail = true;
    await user.click(
      screen.getByRole("button", { name: "Restablecer endpoint" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Detail refresh interrupted",
    );
    expect(
      screen.queryByLabelText("Valor de endpoint"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Guardar" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reintentar" }));
    expect(await screen.findByLabelText("Valor de endpoint")).toHaveValue(
      "https://platform.test",
    );
    expect(
      screen.queryByRole("button", { name: "Restablecer endpoint" }),
    ).not.toBeInTheDocument();
    expect(request).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps the current draft when the previous flow's variable restore finishes", async () => {
    const user = userEvent.setup();
    const { get, request } = renderScopedWorkspace(autos, {
      ...autos,
      id: "hogar",
      name: "Hogar",
    });
    let finishRestore!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRestore = () => resolve({ ok: true, reverted: true });
        }),
    );

    await user.click(await screen.findByRole("tab", { name: "Variables" }));
    await user.click(
      screen.getByRole("button", { name: "Restablecer endpoint" }),
    );
    expect(request).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("link", { name: "Open Hogar" }));
    await screen.findByRole("heading", { name: "Hogar" });
    fireEvent.change(screen.getByRole("textbox", { name: "Nombre del flow" }), {
      target: { value: "Borrador de Hogar" },
    });
    get.mockClear();
    await act(async () => finishRestore());

    expect(
      screen.getByRole("heading", { name: "Borrador de Hogar" }),
    ).toBeVisible();
    expect(screen.getByText(/Cambios sin guardar/)).toBeVisible();
    expect(get).not.toHaveBeenCalledWith(
      expect.stringContaining("/flows/hogar?"),
    );
    expect(
      screen.queryByText(/volvió al valor de plataforma/),
    ).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "ignores a late reload error from a previous variable restore (next flow loading = %s)",
    async (nextLoading) => {
      const user = userEvent.setup();
      const next = { ...autos, id: "hogar", name: "Hogar" };
      const { get, request } = renderScopedWorkspace(autos, next);
      const read = get.getMockImplementation()!;
      const pendingStarted = vi.fn();
      let failReload!: () => void;
      const pending = new Promise<never>((_resolve, reject) => {
        failReload = () => reject(new Error("Earlier flow refresh failed"));
      });
      let loadNext!: () => void;
      const nextRead = new Promise<RequestFlow>((resolve) => {
        loadNext = () => resolve(next);
      });
      get.mockImplementation(async (path) => {
        if (request.mock.calls.length && path.includes("/flows/autos?")) {
          pendingStarted();
          return pending;
        }
        if (nextLoading && path.includes("/flows/hogar?")) return nextRead;
        return read(path);
      });

      await user.click(await screen.findByRole("tab", { name: "Variables" }));
      await user.click(
        screen.getByRole("button", { name: "Restablecer endpoint" }),
      );
      expect(pendingStarted).toHaveBeenCalledOnce();
      await user.click(screen.getByRole("tab", { name: /^Pasos/ }));
      expect(
        screen.getByRole("textbox", { name: "Body del request" }),
      ).toHaveAttribute("contenteditable", "false");
      await user.click(screen.getByRole("link", { name: "Open Hogar" }));
      await waitFor(() =>
        expect(get).toHaveBeenCalledWith(
          expect.stringContaining("/flows/hogar?"),
        ),
      );
      if (!nextLoading) await screen.findByRole("heading", { name: "Hogar" });
      await act(async () => {
        failReload();
        await pending.catch(() => undefined);
      });

      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      if (nextLoading) await act(async () => loadNext());
      expect(
        await screen.findByRole("heading", { name: "Hogar" }),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("offers deletion for a tenant-only flow and variable without a restore action", async () => {
    const user = userEvent.setup();
    const { post, request } = renderScopedWorkspace({
      ...autos,
      hasPlatformDefault: false,
      variables: autos.variables.map((variable) => ({
        ...variable,
        hasPlatformDefault: false,
      })),
    });

    await screen.findByRole("heading", { name: "Autos" });
    expect(
      screen.queryByRole("button", { name: "Restablecer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Eliminar" })[0],
    ).toBeEnabled();
    await user.click(screen.getByRole("tab", { name: "Variables" }));
    expect(
      screen.queryByRole("button", { name: "Restablecer endpoint" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Eliminar endpoint" }),
    ).toBeEnabled();
    expect(post).not.toHaveBeenCalledWith(expect.stringContaining("/reset"));
    expect(request).not.toHaveBeenCalled();
  });
});

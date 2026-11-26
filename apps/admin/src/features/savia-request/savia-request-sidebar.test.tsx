import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { AppServices } from "@/app-services";
import { rotateSessionScope } from "@/auth/session-scope";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import { SaviaRequestProvider } from "./savia-request-provider";
import { SaviaRequestSidebar } from "./savia-request-sidebar";
import type { RequestFlow } from "./types";

vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
}));

const autos: RequestFlow = {
  id: "autos",
  name: "Autos",
  folderPath: "Cotizaciones/Autos",
  description: "Cotiza autos.",
  input: {},
  variables: [],
  versions: [],
  steps: [
    {
      id: "cotizar",
      name: "Cotizar auto",
      url: "https://provider.test/autos",
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
  folderPath: "Cotizaciones/Propiedades",
  steps: [{ ...autos.steps[0], id: "cotizar-hogar", name: "Cotizar hogar" }],
};

function Selection() {
  const location = useLocation();
  return <output data-testid="selection">{location.search}</output>;
}

function renderSidebar({
  initialFlows = [autos, hogar],
  initialFolders = [
    "Cotizaciones",
    "Cotizaciones/Autos",
    "Cotizaciones/Propiedades",
  ],
  flowReadError,
}: {
  initialFlows?: RequestFlow[];
  initialFolders?: string[];
  flowReadError?: Error;
} = {}) {
  let flows = [...initialFlows];
  let folders = [...initialFolders];
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/flows")) {
      if (flowReadError) throw flowReadError;
      return flows.map(({ id, name, folderPath, steps }) => ({
        id,
        name,
        folderPath,
        steps,
      }));
    }
    if (path.endsWith("/folders")) {
      return folders;
    }
    if (path.endsWith("/flows/autos")) return autos;
    if (path.endsWith("/flows/hogar")) return hogar;
    throw new Error(`Ruta inesperada: ${path}`);
  });
  const post = vi.fn(async (_path: string, body: { path: string }) => {
    const path = body.path
      .split("/")
      .map((part) => part.trim())
      .join("/");
    folders = [...folders, path];
    return { path };
  });
  const request = vi.fn(async (_path: string, options: { body?: string }) => {
    const { path } = JSON.parse(options.body ?? "{}") as { path: string };
    folders = folders.filter(
      (candidate) => candidate !== path && !candidate.startsWith(`${path}/`),
    );
    return { ok: true };
  });
  render(
    <SidebarProvider>
      <MemoryRouter initialEntries={["/savia-request?flow=autos&step=0"]}>
        <AppServicesProvider
          services={
            {
              apiClient: { get, post, put: vi.fn(), request },
            } as unknown as AppServices
          }
        >
          <SaviaRequestProvider>
            <SaviaRequestSidebar />
            <Selection />
          </SaviaRequestProvider>
        </AppServicesProvider>
      </MemoryRouter>
    </SidebarProvider>,
  );
  return { get, post, request };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SaviaRequestSidebar", () => {
  it("filters the contextual tree and updates the shared flow selection", async () => {
    const user = userEvent.setup();
    renderSidebar();

    expect(
      await screen.findByRole("navigation", { name: "Flows de Savia Request" }),
    ).toBeVisible();
    await user.type(
      screen.getByRole("searchbox", { name: "Buscar flows" }),
      "hog",
    );
    expect(
      screen.queryByRole("button", { name: "Autos" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Hogar" }));

    expect(await screen.findByTestId("selection")).toHaveTextContent(
      "?flow=hogar&step=0",
    );
  });

  it("keeps folder expansion out of browser storage", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const user = userEvent.setup();
    renderSidebar();

    await screen.findByRole("button", { name: "Cotizaciones" });
    await user.click(screen.getByRole("button", { name: "Cotizaciones" }));

    expect(setItem).not.toHaveBeenCalled();
  });

  it("creates a folder from the contextual tree", async () => {
    const user = userEvent.setup();
    const { post } = renderSidebar();

    await user.click(
      await screen.findByRole("button", { name: "Crear carpeta" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Ruta de la carpeta" }),
      "Cotizaciones/Nuevos",
    );
    await user.click(screen.getByRole("button", { name: "Crear" }));

    expect(post).toHaveBeenCalledWith("/v1/savia-request/api/folders", {
      path: "Cotizaciones/Nuevos",
    });
    expect(await screen.findByRole("button", { name: "Nuevos" })).toBeVisible();
  });

  it("expands a new nested folder using the path returned by the server", async () => {
    const user = userEvent.setup();
    renderSidebar();
    await screen.findByRole("button", { name: "Cotizaciones" });
    await user.click(screen.getByRole("button", { name: "Crear carpeta" }));
    await user.type(
      screen.getByRole("textbox", { name: "Ruta de la carpeta" }),
      "Nuevas / Procesos",
    );
    await user.click(screen.getByRole("button", { name: "Crear" }));

    expect(
      await screen.findByRole("button", { name: "Procesos" }),
    ).toBeVisible();
  });

  it("retries the list read after folder creation succeeds without creating it again", async () => {
    const user = userEvent.setup();
    const { get, post } = renderSidebar();
    const create = post.getMockImplementation()!;
    post.mockImplementationOnce(async (path, body) => {
      const result = await create(path, body);
      get.mockRejectedValueOnce(new Error("Navigation interrupted"));
      return result;
    });
    await screen.findByRole("button", { name: "Cotizaciones" });
    await user.click(screen.getByRole("button", { name: "Crear carpeta" }));
    await user.type(
      screen.getByRole("textbox", { name: "Ruta de la carpeta" }),
      "Nuevas",
    );
    await user.click(screen.getByRole("button", { name: "Crear" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "La carpeta se creó, pero no pudimos actualizar la lista.",
    );
    await user.click(screen.getByRole("button", { name: "Actualizar lista" }));
    expect(await screen.findByRole("button", { name: "Nuevas" })).toBeVisible();
    expect(post).toHaveBeenCalledOnce();
  });

  it("drops the previous principal's folder draft and ignores its late save error", async () => {
    const user = userEvent.setup();
    const { post } = renderSidebar();
    let rejectSave!: (cause: Error) => void;
    post.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectSave = reject;
      }),
    );
    await screen.findByRole("button", { name: "Cotizaciones" });
    await user.click(screen.getByRole("button", { name: "Crear carpeta" }));
    await user.type(
      screen.getByRole("textbox", { name: "Ruta de la carpeta" }),
      "Carpeta de prueba",
    );
    await user.click(screen.getByRole("button", { name: "Crear" }));
    expect(post).toHaveBeenCalledOnce();

    await act(async () => rotateSessionScope("principal-change"));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Crear carpeta" }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByRole("textbox", { name: "Ruta de la carpeta" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Crear carpeta" }));
    await user.type(
      screen.getByRole("textbox", { name: "Ruta de la carpeta" }),
      "Carpeta nueva",
    );
    await act(async () => rejectSave(new Error("Save interrupted")));

    expect(
      screen.getByRole("textbox", { name: "Ruta de la carpeta" }),
    ).toHaveValue("Carpeta nueva");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows folders created by the API even when they have no flows", async () => {
    renderSidebar({ initialFlows: [], initialFolders: ["Vacías"] });

    expect(await screen.findByRole("button", { name: "Vacías" })).toBeVisible();
  });

  it("shows a failed catalog read without announcing an empty sidebar", async () => {
    renderSidebar({
      initialFolders: [],
      flowReadError: new Error("Navigation interrupted"),
    });
    expect(
      await screen.findByText("No pudimos cargar los flows."),
    ).toBeVisible();
    expect(screen.queryByText("No hay flows todavía.")).not.toBeInTheDocument();
  });

  it("opens the secretos screen from the sidebar", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.click(await screen.findByRole("button", { name: "Secretos" }));

    expect(await screen.findByTestId("selection")).toHaveTextContent(
      "?view=secretos",
    );
    expect(screen.getByRole("button", { name: "Secretos" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("deletes an empty folder after confirmation", async () => {
    const user = userEvent.setup();
    const { request } = renderSidebar({
      initialFlows: [],
      initialFolders: ["Vacías"],
    });

    await screen.findByRole("button", { name: "Vacías" });
    await user.click(
      screen.getByRole("button", { name: "Eliminar carpeta Vacías" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Eliminar" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith("/v1/savia-request/api/folders", {
        method: "DELETE",
        body: JSON.stringify({ path: "Vacías" }),
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(
      screen.queryByRole("button", { name: "Vacías" }),
    ).not.toBeInTheDocument();
  });

  it("closes a folder deletion awaiting confirmation after a principal change", async () => {
    const user = userEvent.setup();
    const { request } = renderSidebar({ initialFolders: ["Vacías"] });
    await user.click(
      await screen.findByRole("button", { name: "Eliminar carpeta Vacías" }),
    );
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      /Eliminar la carpeta «Vacías»/,
    );

    await act(async () => rotateSessionScope("principal-change"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(request).not.toHaveBeenCalled();
  });
});

import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiClient } from "@/api/api-client";
import { rotateSessionScope } from "@/auth/session-scope";
import { render } from "../studio-engine/test/locale-test-render";
import { AddWidgetDialog } from "./add-widget-dialog";

beforeEach(() => {
  for (const method of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
  ]) {
    Object.defineProperty(HTMLElement.prototype, method, {
      configurable: true,
      value: vi.fn(() => false),
    });
  }
});
afterEach(cleanup);

const north = {
  id: "tenant:14",
  tenantId: 14,
  label: "Norte",
  kind: "tenant",
  apiBasePath: "/v1/studio/14",
};
const south = {
  id: "tenant:15",
  tenantId: 15,
  label: "Sur",
  kind: "tenant",
  apiBasePath: "/v1/studio/15",
};
const projects = { data: [{ name: "projects", label: "Proyectos" }] };
const tasks = { data: [{ name: "tasks", label: "Tareas" }] };
const catalog = {
  data: [
    {
      manifest: { id: "example.projects" },
      store: true,
      builtIn: false,
      installed: { enabled: true },
      widgets: [
        {
          id: "overview",
          collection: "projects",
          title: { es: "Vista de proyectos" },
        },
      ],
    },
  ],
};

function openPicker(
  get: (path: string, init?: RequestInit) => Promise<unknown>,
) {
  const onAdd = vi.fn(async () => true);
  render(
    <AddWidgetDialog
      open
      onOpenChange={vi.fn()}
      apiClient={{ get } as ApiClient}
      onAdd={onAdd}
      saving={false}
    />,
  );
  return { onAdd, user: userEvent.setup() };
}

const submit = () => screen.getByRole("button", { name: "Agregar widget" });
const collection = () => screen.getByRole("combobox", { name: "Colección" });
const tenant = () => screen.getByRole("combobox", { name: "Tenant" });

it("clears the previous collection and plugin choice before loading a different organization", async () => {
  let finish!: (value: typeof tasks) => void;
  const pending = new Promise<typeof tasks>((resolve) => {
    finish = resolve;
  });
  const get = vi.fn(async (path: string) => {
    if (path === "/v1/tenant-workspaces") return { data: [north, south] };
    if (path === `${north.apiBasePath}/api/objects`) return projects;
    if (path === `${south.apiBasePath}/api/objects`) return pending;
    if (path === `${north.apiBasePath}/api/extensions`) return catalog;
    if (path === `${south.apiBasePath}/api/extensions`) return { data: [] };
    throw new Error(`Unexpected path: ${path}`);
  });
  const { user, onAdd } = openPicker(get);
  await waitFor(() => expect(collection()).toBeEnabled());
  await user.click(collection());
  await user.click(screen.getByRole("option", { name: "Proyectos" }));
  const kind = screen.getByRole("combobox", { name: "Tipo de widget" });
  await user.click(kind);
  await user.click(screen.getByRole("option", { name: /Vista de proyectos/ }));
  expect(submit()).toBeEnabled();

  await user.click(tenant());
  await user.click(screen.getByRole("option", { name: "Sur" }));
  expect(collection()).toHaveTextContent("Elige una colección");
  expect(submit()).toBeDisabled();
  await user.click(submit());
  expect(onAdd).not.toHaveBeenCalled();

  await act(async () => finish(tasks));
  await user.click(collection());
  await user.click(screen.getByRole("option", { name: "Tareas" }));
  await user.click(submit());
  expect(onAdd).toHaveBeenCalledOnce();
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      apiBasePath: south.apiBasePath,
      collection: "tasks",
      kind: "summary",
    }),
  );
});

it("retries a failed plugin catalog without losing the selected collection", async () => {
  let extensionReads = 0;
  const get = vi.fn(async (path: string) => {
    if (path === "/v1/tenant-workspaces") return { data: [north] };
    if (path.endsWith("/objects")) return projects;
    if (path.endsWith("/extensions")) {
      if (++extensionReads === 1) throw new Error("Temporarily unavailable");
      return catalog;
    }
    throw new Error(`Unexpected path: ${path}`);
  });
  const { user, onAdd } = openPicker(get);
  await waitFor(() => expect(collection()).toBeEnabled());
  await user.click(collection());
  await user.click(screen.getByRole("option", { name: "Proyectos" }));
  expect(submit()).toBeEnabled();

  await user.click(await screen.findByRole("button", { name: "Reintentar" }));
  expect(collection()).toHaveTextContent("Proyectos");
  await user.click(screen.getByRole("combobox", { name: "Tipo de widget" }));
  await user.click(
    await screen.findByRole("option", { name: /Vista de proyectos/ }),
  );
  await user.click(submit());
  expect(extensionReads).toBe(2);
  expect(
    get.mock.calls.filter(([path]) => path.endsWith("/objects")),
  ).toHaveLength(1);
  expect(onAdd).toHaveBeenCalledWith(
    expect.objectContaining({
      collection: "projects",
      kind: "plugin:example.projects:overview",
    }),
  );
});

it("retries the workspace and collection catalogs independently", async () => {
  const workspaces = vi
    .fn()
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue({ data: [north] });
  const objects = vi
    .fn()
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValue(projects);
  const extensions = vi.fn().mockResolvedValue(catalog);
  const { user } = openPicker(async (path) => {
    if (path === "/v1/tenant-workspaces") return workspaces();
    if (path.endsWith("/objects")) return objects();
    if (path.endsWith("/extensions")) return extensions();
    throw new Error(`Unexpected path: ${path}`);
  });

  expect(
    await screen.findByText(/No pudimos cargar la lista de tenants/),
  ).toBeVisible();
  expect(submit()).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(
    await screen.findByText(/No pudimos cargar las colecciones de este tenant/),
  ).toBeVisible();
  expect(collection()).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Reintentar" }));
  await waitFor(() => expect(collection()).toBeEnabled());
  expect(workspaces).toHaveBeenCalledTimes(2);
  expect(objects).toHaveBeenCalledTimes(2);
  expect(extensions).toHaveBeenCalledTimes(1);
});

it("removes the previous account's workspace choices and prevents submitting them", async () => {
  let finish!: (value: { data: (typeof north)[] }) => void;
  const pending = new Promise<{ data: (typeof north)[] }>((resolve) => {
    finish = resolve;
  });
  const catalogReads = vi
    .fn()
    .mockResolvedValueOnce({ data: [north, south] })
    .mockReturnValue(pending);
  const get = vi.fn(async (path: string) => {
    if (path === "/v1/tenant-workspaces") return catalogReads();
    if (path.endsWith("/objects")) return projects;
    if (path.endsWith("/extensions")) return { data: [] };
    throw new Error(`Unexpected path: ${path}`);
  });
  const { user, onAdd } = openPicker(get);
  await waitFor(() => expect(collection()).toBeEnabled());
  await user.click(collection());
  await user.click(screen.getByRole("option", { name: "Proyectos" }));
  expect(submit()).toBeEnabled();

  act(() => rotateSessionScope("principal-change"));
  expect(tenant()).not.toHaveTextContent("Norte");
  expect(collection()).not.toHaveTextContent("Proyectos");
  expect(submit()).toBeDisabled();
  await act(async () => finish({ data: [] }));
  expect(onAdd).not.toHaveBeenCalled();
  expect(catalogReads).toHaveBeenCalledTimes(2);
});

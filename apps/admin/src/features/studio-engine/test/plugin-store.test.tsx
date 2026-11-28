// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { render } from "./locale-test-render";
import { MemoryRouter, useLocation } from "react-router-dom";
import PluginStoreManager from "../plugin-store";
import { api } from "../api";

const realtime = vi.hoisted(() => ({ refreshes: [] as Array<() => unknown> }));

vi.mock("@/realtime/use-realtime-refresh", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/realtime/use-realtime-refresh")>();
  return {
    ...actual,
    useRealtimeRefresh: ({ refresh }: { refresh: () => unknown }) => {
      realtime.refreshes.push(refresh);
      return { changed: false, reload: vi.fn() };
    },
  };
});

vi.mock("../api", () => ({ api: vi.fn(), apiFetch: vi.fn() }));
vi.mock("../custom-plugin-frame", () => ({
  CustomPluginFrame: ({ title }: { title: string }) => (
    <div data-testid="plugin-frame">{title}</div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  realtime.refreshes = [];
});

function CurrentRoute() {
  const location = useLocation();
  return (
    <output data-testid="current-route">
      {location.pathname + location.search}
    </output>
  );
}

function renderStore(props: React.ComponentProps<typeof PluginStoreManager>) {
  return render(
    <MemoryRouter>
      <PluginStoreManager {...props} />
      <CurrentRoute />
    </MemoryRouter>,
  );
}

const item = {
  manifest: {
    id: "custom.demo",
    version: "1.0.0",
    label: "Demo",
    description: "Plugin de demostración.",
    requires: [],
  },
  version: "1.0.0",
  sha256: "abc123",
  sizeBytes: 1024,
  createdAt: "2026-01-01",
  installed: null,
};

it("reads shared release status from the workspace inventory, including bundled plugins", async () => {
  const installed = { enabled: true, version: "1.0.0" };
  const releases = ["1.0.0", "1.1.0", "1.2.0"].map((version, index) => ({
    id: item.manifest.id,
    label: "Shared Demo",
    version,
    sha256: String(index + 1).repeat(64),
  }));
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/plugin-store/registry")
      return { configured: true, data: releases, cursor: null };
    if (path === "/plugin-store")
      return {
        data: releases.map((release) => ({
          ...item,
          manifest: { ...item.manifest, version: release.version },
          version: release.version,
          sha256: release.version === "1.2.0" ? "b".repeat(64) : release.sha256,
          installed,
        })),
      };
    if (path === "/solutions")
      return {
        data: [{ manifest: { requires: [item.manifest.id] } }],
      };
    throw new Error(`Unexpected API request: ${path}`);
  });
  renderStore({ onChanged: vi.fn(), hideBundledPlugins: true });

  expect(
    await screen.findByRole("button", {
      name: "Instalar versión Shared Demo 1.0.0",
    }),
  ).toBeDisabled();
  expect(screen.getByText("Versión instalada")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Instalar versión Shared Demo 1.1.0" }),
  ).toBeEnabled();
  expect(
    screen.getByRole("button", { name: "Añadir al espacio Shared Demo 1.2.0" }),
  ).toBeEnabled();
});

it("keeps a confirmed shared import when an earlier inventory read completes during the import", async () => {
  const release = {
    id: item.manifest.id,
    label: "Shared Demo",
    version: item.version,
    sha256: "a".repeat(64),
  };
  const initialInventory = Promise.withResolvers<{ data: [] }>();
  const imported = Promise.withResolvers<{ data: { id: string } }>();
  let inventoryReads = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/plugin-store/registry")
      return { configured: true, data: [release], cursor: null };
    if (path === "/plugin-store/registry/import") return imported.promise;
    if (path === "/plugin-store") {
      inventoryReads++;
      if (inventoryReads === 1) return initialInventory.promise;
      if (inventoryReads === 2) throw new Error("Workspace list unavailable");
      return { data: [{ ...item, sha256: release.sha256 }] };
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  const onChanged = vi.fn();
  renderStore({ onChanged });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Añadir al espacio Shared Demo 1.0.0",
    }),
  );

  await act(async () => initialInventory.resolve({ data: [] }));
  expect(
    screen.getByText("Aún no subiste plugins a este espacio."),
  ).toBeVisible();
  await act(async () => imported.resolve({ data: { id: release.id } }));

  expect(screen.getByText("Añadido al espacio")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Actualizar lista de plugins" }),
  );
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(screen.getByText("Añadido al espacio")).toBeVisible();
  expect(
    vi.mocked(api).mock.calls.filter(([, method]) => method === "POST"),
  ).toHaveLength(1);
});

it("lista, instala y muestra un plugin del store", async () => {
  let installed: { enabled: boolean; version: string } | null = null;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store") return { data: [{ ...item, installed }] };
    if (path === "/extensions/custom.demo/install" && method === "POST") {
      installed = { enabled: true, version: "1.0.0" };
      return { data: { id: "custom.demo", ...installed } };
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  const changed = vi.fn();
  renderStore({ onChanged: changed });

  expect(await screen.findByText("Demo")).toBeInTheDocument();
  expect(screen.getByText("Disponible")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Instalar Demo" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/extensions/custom.demo/install", "POST"),
  );
  await waitFor(() => expect(changed).toHaveBeenCalled());
});

it("retries the inventory read without repeating a confirmed installation", async () => {
  let installed: { enabled: boolean; version: string } | null = null;
  let canRead = false;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store/registry")
      return { configured: false, data: [], cursor: null };
    if (path === "/plugin-store") {
      if (installed && !canRead) throw new Error("Workspace list unavailable");
      return { data: [{ ...item, installed }] };
    }
    if (path === "/extensions/custom.demo/install" && method === "POST") {
      installed = { enabled: true, version: item.version };
      return { data: { id: item.manifest.id, ...installed } };
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  const changed = vi.fn();
  renderStore({ onChanged: changed });
  const install = await screen.findByRole("button", { name: "Instalar Demo" });

  fireEvent.click(install);
  const notice = await screen.findByText(
    "El cambio se guardó. No pudimos actualizar la lista de plugins.",
  );
  const retry = screen.getByRole("button", {
    name: "Actualizar lista de plugins",
  });
  expect(install).toBeDisabled();
  expect(changed).not.toHaveBeenCalled();

  await act(async () => fireEvent.click(retry));
  expect(notice).toBeVisible();
  expect(install).toBeDisabled();
  canRead = true;
  fireEvent.click(retry);

  expect(
    await screen.findByRole("button", { name: "Desactivar Demo" }),
  ).toBeEnabled();
  expect(notice).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
  expect(
    vi.mocked(api).mock.calls.filter(([, method]) => method === "POST"),
  ).toEqual([["/extensions/custom.demo/install", "POST"]]);
});

it("clears denied inventory after a confirmed deletion and reconciles on retry", async () => {
  let deleted = false;
  let canRead = false;
  const denied = Object.assign(new Error("Access revoked"), { status: 403 });
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store/registry")
      return { configured: false, data: [], cursor: null };
    if (path === "/plugin-store") {
      if (deleted && !canRead) throw denied;
      return { data: deleted ? [] : [item] };
    }
    if (path === "/plugin-store/custom.demo" && method === "DELETE") {
      deleted = true;
      return { data: { deleted: true } };
    }
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  const changed = vi.fn();
  renderStore({ onChanged: changed });
  fireEvent.click(await screen.findByRole("button", { name: "Eliminar Demo" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar definitivamente" }),
  );

  const retry = await screen.findByRole("button", {
    name: "Actualizar lista de plugins",
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Access revoked");
  expect(screen.queryByText("Demo")).not.toBeInTheDocument();
  expect(
    screen.queryByText("Aún no subiste plugins a este espacio."),
  ).not.toBeInTheDocument();
  expect(changed).not.toHaveBeenCalled();

  canRead = true;
  fireEvent.click(retry);
  expect(
    await screen.findByText("Aún no subiste plugins a este espacio."),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(changed).toHaveBeenCalledOnce();
  expect(
    vi.mocked(api).mock.calls.filter(([, method]) => method === "DELETE"),
  ).toEqual([["/plugin-store/custom.demo", "DELETE"]]);
});

it("serializes plugin and connection changes through reconciliation", async () => {
  const second = {
    ...item,
    manifest: { ...item.manifest, id: "custom.second", label: "Second" },
  };
  const sharedRelease = {
    id: "custom.shared",
    version: "1.0.0",
    label: "Shared",
    sha256: "a".repeat(64),
    sizeBytes: 1024,
    createdAt: "2026-01-01",
  };
  const installation = Promise.withResolvers<void>();
  const inventoryRefresh = Promise.withResolvers<void>();
  const imported = Promise.withResolvers<void>();
  const savedConnection = Promise.withResolvers<void>();
  let installed: { enabled: boolean; version: string } | null = null;
  let sharedAdded = false;
  const demo = {
    ...item,
    declarations: {
      connectors: [{ id: "demo-api", label: "Demo API", fields: [] }],
    },
  };
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store") {
      const data = [{ ...demo, installed }, second];
      if (sharedAdded)
        data.push({
          ...item,
          manifest: {
            ...item.manifest,
            id: sharedRelease.id,
            label: sharedRelease.label,
          },
          sha256: sharedRelease.sha256,
        });
      return { data };
    }
    if (path === "/plugin-store/registry")
      return { configured: true, data: [sharedRelease], cursor: null };
    if (path === "/extensions/custom.demo/install" && method === "POST") {
      await installation.promise;
      installed = { enabled: true, version: item.version };
      return { data: { id: item.manifest.id, ...installed } };
    }
    if (path === "/plugin-store/registry/import" && method === "POST") {
      await imported.promise;
      sharedAdded = true;
      return { data: { id: sharedRelease.id } };
    }
    if (path === "/extensions/custom.demo/connections") return { data: [] };
    if (
      path === "/extensions/custom.demo/connections/demo-api" &&
      method === "PUT"
    )
      return savedConnection.promise;
    throw new Error(`Unexpected API request: ${method} ${path}`);
  });
  const changed = vi.fn().mockReturnValueOnce(inventoryRefresh.promise);
  renderStore({ onChanged: changed });
  const installFirst = await screen.findByRole("button", {
    name: "Instalar Demo",
  });
  const installSecond = screen.getByRole("button", { name: "Instalar Second" });
  const addShared = await screen.findByRole("button", {
    name: "Añadir al espacio Shared 1.0.0",
  });
  const upload = screen.getByRole("button", { name: "Subir plugin" });

  fireEvent.click(installFirst);
  expect(installFirst).toBeDisabled();
  expect(installSecond).toBeDisabled();
  expect(addShared).toBeDisabled();
  expect(upload).toBeDisabled();

  await act(async () => installation.resolve());
  expect(changed).toHaveBeenCalledOnce();
  expect(installSecond).toBeDisabled();
  await act(async () => inventoryRefresh.resolve());
  expect(installSecond).toBeEnabled();

  const saveConnection = screen.getByRole("button", {
    name: "Configurar conexión de Demo API",
  });
  fireEvent.click(addShared);
  expect(installSecond).toBeDisabled();
  expect(upload).toBeDisabled();
  expect(saveConnection).toBeDisabled();
  await act(async () => imported.resolve());
  expect(installSecond).toBeEnabled();
  expect(upload).toBeEnabled();
  expect(saveConnection).toBeEnabled();

  fireEvent.click(saveConnection);
  expect(installSecond).toBeDisabled();
  await act(async () =>
    savedConnection.reject(new Error("Connection save failed")),
  );
  expect(screen.getByText("Connection save failed")).toBeVisible();
  expect(installSecond).toBeEnabled();
});

it("sube un zip y desactiva un plugin activo", async () => {
  const installed = { enabled: true, version: "1.0.0" };
  vi.mocked(api).mockImplementation(async (path, method, body) => {
    if (path === "/plugin-store") return { data: [{ ...item, installed }] };
    if (path === "/plugin-store/upload" && method === "POST") {
      expect(body).toBeInstanceOf(FormData);
      return { data: { id: "custom.demo", version: "1.0.0" } };
    }
    if (path === "/extensions/custom.demo" && method === "PATCH") {
      expect(body).toEqual({ enabled: false });
      return { data: { id: "custom.demo", enabled: false } };
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  renderStore({ onChanged: () => undefined });

  expect(await screen.findByText("Demo")).toBeInTheDocument();

  const file = new File(["zip"], "plugin.zip", { type: "application/zip" });
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file] } });
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/plugin-store/upload",
      "POST",
      expect.any(FormData),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: "Desactivar Demo" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/extensions/custom.demo", "PATCH", {
      enabled: false,
    }),
  );
});

it("updates an installed plugin when a newer ZIP is available", async () => {
  let installed = { enabled: true, version: "1.2.0" };
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store")
      return {
        data: [
          {
            ...item,
            version: "1.3.0",
            manifest: { ...item.manifest, version: "1.3.0" },
            installed,
          },
        ],
      };
    if (path === "/extensions/custom.demo/install" && method === "POST") {
      installed = { enabled: true, version: "1.3.0" };
      return { data: { id: "custom.demo", ...installed } };
    }
    throw new Error(`Unexpected API request: ${path}`);
  });
  renderStore({ onChanged: () => undefined });

  fireEvent.click(
    await screen.findByRole("button", { name: "Actualizar Demo" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("/extensions/custom.demo/install", "POST"),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Actualizar Demo" }),
    ).not.toBeInTheDocument(),
  );
});

it("muestra el estado vacío del store", async () => {
  vi.mocked(api).mockResolvedValue({ data: [] });
  renderStore({ onChanged: () => undefined });
  expect(
    await screen.findByText("Aún no subiste plugins a este espacio."),
  ).toBeInTheDocument();
});

it("agrupa varias versiones del mismo plugin en una sola tarjeta", async () => {
  const installed = { enabled: true, version: "2.0.3" };
  const versions = ["1.3.0", "1.3.1", "2.0.0", "2.0.3"].map((version) => ({
    ...item,
    version,
    manifest: { ...item.manifest, version },
    installed,
  }));
  vi.mocked(api).mockResolvedValue({ data: versions });
  renderStore({ onChanged: () => undefined });

  expect(await screen.findByText("Demo")).toBeInTheDocument();
  expect(screen.getAllByText("Demo")).toHaveLength(1);
  expect(screen.getByText("2.0.3")).toBeInTheDocument();
  expect(screen.getByText("4 versiones")).toBeInTheDocument();
  expect(screen.getByText("Mostrando 1 de 1 plugins")).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Editar última versión" }),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Editar código" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Versiones anteriores (3)"));
  fireEvent.click(screen.getAllByRole("button", { name: "Usar como base" })[0]);
  expect(screen.getByTestId("current-route")).toHaveTextContent(
    "/plugin-studio?tenantId=0&source=custom.demo&version=2.0.0",
  );
});

it("omits plugins already included in application activation from the unified catalog", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/solutions")
      return { data: [{ manifest: { requires: ["custom.demo"] } }] };
    if (path === "/plugin-store")
      return {
        data: [
          item,
          {
            ...item,
            manifest: {
              ...item.manifest,
              id: "custom.other",
              label: "Other plugin",
            },
          },
        ],
      };
    throw new Error("Unexpected request");
  });
  renderStore({ hideBundledPlugins: true, onChanged: vi.fn() });
  expect(await screen.findByText("Other plugin")).toBeInTheDocument();
  expect(
    screen.queryByRole("heading", { name: "Demo" }),
  ).not.toBeInTheDocument();
});

it("opens the dedicated plugin studio for new and source-backed projects", async () => {
  vi.mocked(api).mockResolvedValue({ data: [item] });
  renderStore({ onChanged: vi.fn() });

  fireEvent.click(
    await screen.findByRole("button", { name: "Editor de plugins" }),
  );
  expect(screen.getByTestId("current-route")).toHaveTextContent(
    "/plugin-studio?tenantId=0",
  );

  fireEvent.click(
    await screen.findByRole("button", { name: "Editar última versión" }),
  );
  expect(screen.getByTestId("current-route")).toHaveTextContent(
    "/plugin-studio?tenantId=0&source=custom.demo&version=1.0.0",
  );
});

it("ignores a stale initial-load error after a newer refresh succeeds", async () => {
  let rejectInitial!: (reason: Error) => void;
  let requestCount = 0;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path !== "/plugin-store")
      throw new Error(`Unexpected API request: ${path}`);
    requestCount += 1;
    if (requestCount === 1)
      return new Promise((_resolve, reject) => {
        rejectInitial = reject;
      });
    return { data: [item] };
  });
  renderStore({ onChanged: () => undefined });
  await waitFor(() => expect(rejectInitial).toBeTypeOf("function"));

  await act(async () => {
    await realtime.refreshes.at(-1)?.();
  });

  await act(async () => {
    rejectInitial(new Error("Obsolete initial failure"));
  });

  expect(await screen.findByText("Demo")).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("removes protected plugins after a denied background read", async () => {
  const denied = Object.assign(new Error("Access revoked"), { status: 403 });
  let denyReads = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path !== "/plugin-store")
      throw new Error(`Unexpected API request: ${path}`);
    if (denyReads) throw denied;
    return { data: [{ ...item }] };
  });
  renderStore({ onChanged: () => undefined });

  expect(await screen.findByText("Demo")).toBeVisible();
  denyReads = true;
  await act(async () => {
    await expect(realtime.refreshes.at(-1)?.()).rejects.toBe(denied);
  });

  expect(screen.queryByText("Demo")).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Access revoked");
});

it("confirms deletion of an older version with its shared R2 release while preserving the active version", async () => {
  const installed = { enabled: true, version: "2.0.0" };
  let versions = ["2.0.0", "1.0.0"].map((version) => ({
    ...item,
    version,
    manifest: { ...item.manifest, version },
    installed,
  }));
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store")
      return { data: versions, canDeleteFromRegistry: true };
    if (
      path === "/plugin-store/custom.demo?version=1.0.0&registry=true" &&
      method === "DELETE"
    ) {
      versions = versions.filter((release) => release.version !== "1.0.0");
      return { data: { deleted: true } };
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const changed = vi.fn();
  renderStore({ onChanged: changed });
  await screen.findByText("Demo");
  expect(
    screen.getByRole("button", { name: "Eliminar versión Demo 2.0.0" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByText("Versiones anteriores (1)"));
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar versión Demo 1.0.0" }),
  );
  expect(
    screen.getByRole("checkbox", {
      name: "Eliminar también del catálogo compartido (R2)",
    }),
  ).toBeChecked();
  expect(
    vi.mocked(api).mock.calls.some(([, method]) => method === "DELETE"),
  ).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  expect(
    vi.mocked(api).mock.calls.some(([, method]) => method === "DELETE"),
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar versión Demo 1.0.0" }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar definitivamente" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/plugin-store/custom.demo?version=1.0.0&registry=true",
      "DELETE",
    ),
  );
  await waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(screen.getByText("2.0.0")).toBeInTheDocument();
  expect(
    screen.queryByText("Versiones anteriores (1)"),
  ).not.toBeInTheDocument();
});

it("allows local-only version deletion and reports a failed request without removing the version", async () => {
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/plugin-store")
      return { data: [item], canDeleteFromRegistry: true };
    if (method === "DELETE")
      throw new Error("The registry is unavailable. Retry deletion.");
    throw new Error(`Unexpected request: ${path}`);
  });
  renderStore({ onChanged: vi.fn() });
  await screen.findByText("Demo");
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar versión Demo 1.0.0" }),
  );
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Eliminar también del catálogo compartido (R2)",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Eliminar definitivamente" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "/plugin-store/custom.demo?version=1.0.0",
      "DELETE",
    ),
  );
  expect(
    await screen.findByText("The registry is unavailable. Retry deletion."),
  ).toBeVisible();
  expect(screen.getByText("Demo")).toBeInTheDocument();
});

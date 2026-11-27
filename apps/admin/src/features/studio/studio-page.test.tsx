import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { render } from "../studio-engine/test/locale-test-render";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AppServices } from "@/app-services";
import { ApiClientError } from "@/api/api-client";
import { rotateSessionScope } from "@/auth/session-scope";
import { invalidateTenantWorkspaces } from "@/api/tenant-workspaces-client";
import { getStudioRuntime } from "@/features/studio-engine/runtime";
import { PluginStudioPage, StudioPage } from "./studio-page";
import { STUDIO_TENANTS_CHANGED } from "./studio-tenants";
const workspaceRendered = vi.hoisted(() => vi.fn());

vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
}));
vi.mock("@/features/studio-engine/app", () => ({
  default: ({ search }: { search?: string }) => {
    workspaceRendered(search, getStudioRuntime().apiBasePath);
    return <p>Espacio CRM {search}</p>;
  },
}));
vi.mock("@/features/studio-engine/plugin-project-workspace", () => ({
  default: ({ tenantId }: { tenantId: number }) => (
    <main aria-label="Your plugin projects">
      Plugin projects for tenant {tenantId}
    </main>
  ),
}));
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div role="dialog">{children}</div>
  ),
}));

afterEach(() => {
  cleanup();
  invalidateTenantWorkspaces();
  vi.restoreAllMocks();
  workspaceRendered.mockClear();
});

const platform = {
  id: "tenant:0",
  tenantId: 0,
  label: "Plataforma",
  kind: "platform",
  apiBasePath: "/v1/studio/0",
};
const tenant = {
  id: "tenant:101",
  tenantId: 101,
  label: "Norte",
  kind: "tenant",
  apiBasePath: "/v1/studio/101",
};
function servicesFor(tenants: unknown[]): AppServices {
  return {
    authSession: { getIdentity: async () => ({ id: "user-1" }) },
    apiClient: { get: vi.fn(async () => ({ data: tenants })) },
  } as unknown as AppServices;
}
function mount(services: AppServices, route = "/studio") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <div id="header-actions" />
      <StudioPage services={services} />
    </MemoryRouter>,
  );
}
function mountPluginStudio(services: AppServices, route = "/plugin-studio") {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <div id="header-actions" />
      <PluginStudioPage services={services} />
    </MemoryRouter>,
  );
}
describe("Studio tenant integration", () => {
  it.each([
    {
      name: "Studio",
      mountPage: mount,
      route: "/studio",
      workspace: /Espacio CRM/,
    },
    {
      name: "Plugin Studio",
      mountPage: mountPluginStudio,
      route: "/plugin-studio",
      workspace: /Plugin projects for tenant/,
    },
  ])(
    "unmounts $name until the new account's workspace is authorized",
    async ({ mountPage, route, workspace }) => {
      let authorize!: (result: { data: unknown[] }) => void;
      const pending = new Promise<{ data: unknown[] }>((resolve) => {
        authorize = resolve;
      });
      const get = vi.fn(async (path: string): Promise<{ data: unknown[] }> => {
        if (path !== "/v1/tenant-workspaces") return { data: [] };
        return { data: [platform, tenant] };
      });
      const services = {
        ...servicesFor([]),
        apiClient: { get },
      } as unknown as AppServices;
      mountPage(services, `${route}?tenantId=101`);
      const previous = await screen.findByText(workspace);
      expect(screen.getByLabelText("Tenant")).toBeVisible();
      get.mockImplementation((path: string) =>
        path === "/v1/tenant-workspaces"
          ? pending
          : Promise.resolve({ data: [] }),
      );

      act(() => rotateSessionScope("principal-change"));
      expect(previous).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Tenant")).not.toBeInTheDocument();
      expect(getStudioRuntime().embedded).toBe(false);

      await act(async () => authorize({ data: [tenant] }));
      expect(await screen.findByText(workspace)).not.toBe(previous);
      expect(getStudioRuntime().apiBasePath).toBe(tenant.apiBasePath);
      expect(
        get.mock.calls.filter(([path]) => path === "/v1/tenant-workspaces"),
      ).toHaveLength(2);
    },
  );
  it("loads the dedicated plugin workspace under the selected authorized tenant", async () => {
    mountPluginStudio(
      servicesFor([platform, tenant]),
      "/plugin-studio?tenantId=101",
    );
    expect(await screen.findByLabelText("Your plugin projects")).toBeVisible();
    expect(getStudioRuntime().apiBasePath).toBe(tenant.apiBasePath);
    expect(getStudioRuntime().tenantId).toBe(101);
  });
  it("selects reserved platform tenant zero and uses its Studio route", async () => {
    mount(
      servicesFor([platform, tenant]),
      "/studio?tenantId=0&view=designer&object=agencias",
    );
    expect(await screen.findByText(/Espacio CRM/)).toHaveTextContent(
      "tenantId=0",
    );
    expect(getStudioRuntime().apiBasePath).toBe(platform.apiBasePath);
    expect(getStudioRuntime().tenantId).toBe(0);
    expect(screen.getByLabelText("Tenant")).toHaveValue("0");
  });

  it("selects the requested tenant and clears an old domain query parameter", async () => {
    mount(
      servicesFor([platform, tenant]),
      "/studio?tenantId=101&domain=old-domain&object=clientes",
    );
    expect(await screen.findByText(/Espacio CRM/)).toHaveTextContent(
      "tenantId=101",
    );
    expect(getStudioRuntime().apiBasePath).toBe(tenant.apiBasePath);
    expect(getStudioRuntime().tenantId).toBe(101);
    expect(
      screen.queryByRole("button", { name: /Crear dominio|Create domain/ }),
    ).toBeNull();
    expect(screen.queryByLabelText(/Dominio de datos|Data domain/)).toBeNull();
  });

  it("does not fall back to another tenant for an unauthorized tenant id", async () => {
    mount(servicesFor([tenant]), "/studio?tenantId=0");
    expect(
      (await screen.findAllByText(/Selecciona un tenant para administrar/))[0],
    ).toBeVisible();
    expect(screen.queryByText(/Espacio CRM/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Tenant")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Norte" }));
    expect(await screen.findByText(/Espacio CRM/)).toBeVisible();
    expect(getStudioRuntime().tenantId).toBe(101);
  });

  it("opens a single authorized tenant without requiring a query parameter", async () => {
    mount(servicesFor([tenant]));
    expect(await screen.findByText(/Espacio CRM/)).toBeVisible();
    expect(getStudioRuntime().tenantId).toBe(101);
    expect(screen.queryByLabelText("Tenant")).not.toBeInTheDocument();
  });

  it.each(["", "&tenantId=unknown", "&tenantId=0"])(
    "keeps a record link with no valid authorized tenant out of the only available workspace (%s)",
    async (tenantQuery) => {
      mount(
        servicesFor([tenant]),
        `/studio?object=orders&record=12${tenantQuery}`,
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(
        "El espacio de trabajo del enlace no está disponible.",
      );
      expect(workspaceRendered).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", { name: "Norte" }));
      expect(await screen.findByText(/Espacio CRM/)).toHaveTextContent(
        "tenantId=101",
      );
      expect(screen.getByText(/Espacio CRM/)).not.toHaveTextContent("record=");
      expect(screen.getByText(/Espacio CRM/)).not.toHaveTextContent("object=");
    },
  );

  it("opens a record link in its explicitly selected workspace", async () => {
    mount(
      servicesFor([platform, tenant]),
      "/studio?tenantId=101&object=orders&record=12",
    );
    expect(await screen.findByText(/Espacio CRM/)).toHaveTextContent(
      "object=orders&record=12",
    );
    expect(getStudioRuntime().apiBasePath).toBe(tenant.apiBasePath);
  });

  it("clears the authorized workspace after a background tenant access denial", async () => {
    let denyReads = false;
    const apiClient = {
      get: vi.fn(async () => {
        if (denyReads) throw new ApiClientError(403, "forbidden", "Denied");
        return { data: [tenant] };
      }),
    };
    const services = {
      authSession: { getIdentity: async () => ({ id: "user-1" }) },
      apiClient,
    } as unknown as AppServices;
    mount(services, "/studio?tenantId=101");

    expect(await screen.findByText(/Espacio CRM/)).toBeVisible();
    denyReads = true;
    window.dispatchEvent(new Event(STUDIO_TENANTS_CHANGED));

    await waitFor(() => {
      expect(screen.queryByText(/Espacio CRM/)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Denied");
  });

  it.each(["initial", "background"])(
    "offers a retry after a failed %s workspace catalog read",
    async (timing) => {
      let reads = 0;
      const failureRead = timing === "initial" ? 1 : 2;
      const services = {
        ...servicesFor([]),
        apiClient: {
          get: vi.fn(async (path: string) => {
            if (path !== "/v1/tenant-workspaces") return { data: [] };
            if (++reads === failureRead)
              throw new ApiClientError(
                503,
                "unavailable",
                "Workspace catalog unavailable",
              );
            return { data: [tenant] };
          }),
        },
      } as unknown as AppServices;
      mount(services, "/studio?tenantId=101");

      const previous =
        timing === "background"
          ? await screen.findByText(/Espacio CRM/)
          : undefined;
      if (previous)
        act(() => window.dispatchEvent(new Event(STUDIO_TENANTS_CHANGED)));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Workspace catalog unavailable",
      );
      expect(
        screen.queryByText(/No tienes tenants disponibles/),
      ).not.toBeInTheDocument();
      if (previous) expect(screen.getByText(/Espacio CRM/)).toBe(previous);

      fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
      expect(await screen.findByText(/Espacio CRM/)).toBeVisible();
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
      );
      if (previous) expect(screen.getByText(/Espacio CRM/)).toBe(previous);
      expect(reads).toBe(failureRead + 1);
    },
  );

  it("closes the local workspace when leaving Studio", async () => {
    const close = vi.fn();
    const fakeStore = {
      status: vi.fn(async () => ({})),
      subscribe: vi.fn(() => () => undefined),
      db: {
        outbox: { toArray: vi.fn(async () => []) },
        syncState: { toArray: vi.fn(async () => []) },
        collections: { toArray: vi.fn(async () => []) },
        conflicts: { toArray: vi.fn(async () => []) },
      },
    };
    const services = {
      ...servicesFor([platform]),
      localData: {
        open: vi.fn(async () => ({ close, store: fakeStore })),
        cachedMetadata: vi.fn(async (_name: string, load: () => unknown) =>
          load(),
        ),
      },
    } as unknown as AppServices;
    const mounted = mount(services, "/studio?tenantId=0&view=records");
    await screen.findByText(/Espacio CRM/);
    expect(services.localData.open).toHaveBeenCalledWith(platform.apiBasePath);
    mounted.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("Studio Savia theme bridge", () => {
  it("does not keep a private olive brand palette in the imported Studio chrome", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../studio-engine/style.css"), "utf8");
    expect(css).not.toContain("#285841");
    expect(css).toContain("var(--primary)");
    expect(css).toContain("var(--foreground)");
  });
});

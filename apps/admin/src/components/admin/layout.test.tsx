// @vitest-environment-options {"url":"https://clinic.savia-preview.hefesoft.com/"}
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { COOKIE_CONSENT_STORAGE_KEY } from "@/consent/cookie-consent-storage";
import { useCurrentTenant } from "@/features/tenants/use-current-tenant";
import type { ApiClient } from "@/api/api-client";
import type { AppServices } from "@/app-services";
import { fetchTenantWorkspaces } from "@/api/tenant-workspaces-client";
import { QueryClient } from "@tanstack/react-query";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import { STUDIO_TENANTS_CHANGED } from "@/features/studio/studio-tenants";
import type { RealtimeChangeEvent } from "@/realtime/use-realtime";
import { Layout } from "./layout";

vi.mock("ra-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ra-core")>();
  return {
    ...actual,
    useTranslate: () => (key: string) => {
      const labels: Record<string, string> = {
        "savia.layout.back": "Volver",
        "savia.layout.forward": "Adelante",
        "savia.layout.noPreviousScreen": "No hay una pantalla anterior",
        "savia.layout.noNextScreen": "No hay una pantalla siguiente",
        "savia.layout.toggleSidebar": "Mostrar u ocultar menú",
        "savia.layout.backToSavia": "Volver a Savia",
        "savia.consent.title": "Usamos cookies",
        "savia.consent.rejectNonEssential": "Solo esenciales",
        "savia.pwa.bannerTitle": "Instala Savia en tu dispositivo",
        "savia.pwa.installAppShort": "Instalar app",
      };
      return labels[key] ?? key;
    },
  };
});

vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  SidebarTrigger: ({ "aria-label": ariaLabel }: { "aria-label"?: string }) => (
    <button aria-label={ariaLabel} type="button" />
  ),
}));
vi.mock("@/components/admin/app-sidebar", () => ({
  AppSidebar: () => <aside>Navigation</aside>,
}));
vi.mock("@/components/admin/refresh-button", () => ({
  RefreshButton: () => <button type="button">Actualizar</button>,
}));
vi.mock("@/components/admin/locales-menu-button", () => ({
  LocalesMenuButton: () => null,
}));
vi.mock("@/components/admin/notification", () => ({
  Notification: () => null,
}));
vi.mock("@/components/admin/error", () => ({
  Error: () => <p>Error</p>,
}));
vi.mock("@/components/admin/loading", () => ({
  Loading: () => <p>Cargando</p>,
}));
vi.mock("@/features/assistant/assistant-bar", () => ({
  AssistantBar: () => null,
}));
vi.mock("@/features/savia-request/savia-request-provider", () => ({
  SaviaRequestProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
vi.mock("@/features/notifications/notification-bell", () => ({
  NotificationBell: () => null,
}));
vi.mock("@/features/tenants/use-current-tenant", () => ({
  useCurrentTenant: vi.fn(() => ({})),
}));

const subscribe = vi.hoisted(() =>
  vi.fn(
    (_options: {
      topics: string[];
      onEvent?: (event: RealtimeChangeEvent) => void;
    }) => ({ status: "live" }),
  ),
);
vi.mock("@/realtime/use-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/use-realtime")>()),
  useRealtimeTopics: subscribe,
}));

afterEach(() => {
  cleanup();
  subscribe.mockClear();
  localStorage.removeItem(COOKIE_CONSENT_STORAGE_KEY);
});

function RouteControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          navigate(
            "/studio?tenantId=0&object=customer_profiles&view=screen-relations",
          )
        }
      >
        Abrir relaciones
      </button>
      <output role="status">{location.pathname + location.search}</output>
    </>
  );
}

describe("admin layout", () => {
  it("refreshes the workspace catalog once for a burst of account security changes", async () => {
    const workspace = {
      id: "tenant:14",
      tenantId: 14,
      label: "North",
      kind: "tenant",
      apiBasePath: "/v1/studio/14",
    };
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: [workspace] })
      .mockResolvedValue({ data: [] });
    const client = { get } as unknown as ApiClient;
    const queryClient = new QueryClient();
    const permissionsKey = [
      "auth",
      "canAccess",
      { resource: "studio", action: "list" },
    ];
    queryClient.setQueryData(permissionsKey, true);
    await expect(fetchTenantWorkspaces(client)).resolves.toEqual([workspace]);
    const page = vi.fn(() => fetchTenantWorkspaces(client));
    const sidebar = vi.fn(() => fetchTenantWorkspaces(client));
    window.addEventListener(STUDIO_TENANTS_CHANGED, page);
    window.addEventListener(STUDIO_TENANTS_CHANGED, sidebar);
    vi.useFakeTimers();
    try {
      render(
        <MemoryRouter>
          <AppServicesProvider
            services={{ apiClient: client, queryClient } as AppServices}
          >
            <Layout>{null}</Layout>
          </AppServicesProvider>
        </MemoryRouter>,
      );
      const account = subscribe.mock.calls.find(([options]) =>
        options.topics.includes("account"),
      )?.[0];
      expect(account).toBeDefined();
      act(() =>
        account?.onEvent?.({
          topic: "account",
          type: "updated",
          collection: "preferences",
        }),
      );
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(get).toHaveBeenCalledTimes(1);
      expect(page).not.toHaveBeenCalled();
      expect(queryClient.getQueryState(permissionsKey)?.isInvalidated).toBe(
        false,
      );

      act(() => {
        account?.onEvent?.({
          topic: "account",
          type: "updated",
          collection: "security",
        });
        account?.onEvent?.({
          topic: "account",
          type: "updated",
          collection: "security",
        });
      });
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(page).toHaveBeenCalledOnce();
      expect(sidebar).toHaveBeenCalledOnce();
      await expect(page.mock.results[0]?.value).resolves.toEqual([]);
      await expect(sidebar.mock.results[0]?.value).resolves.toEqual([]);
      expect(get).toHaveBeenCalledTimes(2);
      expect(queryClient.getQueryState(permissionsKey)?.isInvalidated).toBe(
        true,
      );
    } finally {
      window.removeEventListener(STUDIO_TENANTS_CHANGED, page);
      window.removeEventListener(STUDIO_TENANTS_CHANGED, sidebar);
      queryClient.clear();
      vi.useRealTimers();
    }
  });
  it("shows cookie choices before the install notice in the reserved workspace footer", () => {
    render(
      <MemoryRouter>
        <Layout>
          <button type="button">Workspace action</button>
        </Layout>
      </MemoryRouter>,
    );

    const action = screen.getByRole("button", { name: "Workspace action" });
    const workspace = action.closest(".overflow-y-auto");
    const notice = screen.getByRole("region", { name: "Usamos cookies" });
    const installNotice = () =>
      screen.queryByRole("region", { name: "Instala Savia en tu dispositivo" });
    expect(workspace).not.toBeNull();
    expect(workspace?.nextElementSibling).toBe(notice);
    expect(notice.closest("main")).toBe(workspace?.parentElement);
    expect(installNotice()).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Solo esenciales" }));

    expect(notice).not.toBeInTheDocument();
    expect(installNotice()).toBeVisible();
    expect(workspace?.nextElementSibling).toBe(installNotice());
  });

  it("lets a blocked Bookings user choose another organization with the same tab and date", () => {
    vi.mocked(useCurrentTenant).mockReturnValueOnce({
      isDedicated: true,
      slug: "clinic",
      name: "Clinic",
      kind: "commercial",
      id: null,
      monogram: "C",
      isPlatformAdmin: false,
      isLoading: false,
      scopeStatus: "error",
      retry: vi.fn(),
    });
    render(
      <MemoryRouter
        initialEntries={[
          "/BOOKINGS/?tab=reservations&date=2026-11-25&ignored=1",
        ]}
      >
        <Layout>
          <p>Protected appointments</p>
        </Layout>
      </MemoryRouter>,
    );

    expect(
      screen.queryByText("Protected appointments"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", {
        name: /Choose another organization|Elegir otra organización/,
      }),
    ).toHaveAttribute(
      "href",
      "https://savia-preview.hefesoft.com/#/bookings?tab=reservations&date=2026-11-25",
    );
  });

  it("keeps the selected workspace when signing in again from Bookings", () => {
    vi.mocked(useCurrentTenant).mockReturnValueOnce({
      isDedicated: true,
      slug: "clinic",
      name: "Clinic",
      kind: "commercial",
      id: null,
      monogram: "C",
      isPlatformAdmin: false,
      isLoading: false,
      scopeStatus: "error",
      requiresSignIn: true,
    });
    render(
      <MemoryRouter
        initialEntries={[
          "/bookings?tab=availability&date=2026-11-25&ignored=1",
        ]}
      >
        <Layout>
          <p>Protected appointments</p>
        </Layout>
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", {
      name: /Sign in again|Volver a iniciar sesión/,
    });
    const authorize = new URL(link.getAttribute("href")!);
    expect(authorize.pathname).toBe("/api/auth/admin/authorize");
    expect(authorize.searchParams.get("resume")).toBe("bookings");
    expect(authorize.searchParams.get("return_to")).toBe(
      "https://clinic.savia-preview.hefesoft.com",
    );
    expect(authorize.searchParams.get("booking_query")).toBe(
      "tab=availability&date=2026-11-25",
    );
    expect(screen.queryByText("Protected appointments")).toBeNull();
  });

  it.each([
    "/savia-flows?tenantId=0",
    "/savia-flows/",
    "/savia-flows/workflows/demo?tenantId=0",
  ])("uses only module navigation when opening %s directly", (route) => {
    render(
      <MemoryRouter initialEntries={[route]}>
        <Layout>
          <nav aria-label="Flows">Workflow editor</nav>
        </Layout>
      </MemoryRouter>,
    );

    expect(screen.getByRole("navigation", { name: "Flows" })).toBeVisible();
    expect(screen.queryByText("Navigation")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mostrar u ocultar menú" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Volver a Savia" })).toBeVisible();
  });

  it("keeps the regular navigation on a disabled Flows link", () => {
    vi.stubEnv("VITE_SAVIA_FLOWS_DISABLED", "true");
    try {
      render(
        <MemoryRouter initialEntries={["/savia-flows"]}>
          <Layout>
            <p>Flows unavailable</p>
          </Layout>
        </MemoryRouter>,
      );
      expect(screen.getByText("Navigation")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Mostrar u ocultar menú" }),
      ).toBeVisible();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns to Savia and restores its navigation", async () => {
    render(
      <MemoryRouter initialEntries={["/savia-flows?tenantId=0"]}>
        <Layout>
          <RouteControls />
        </Layout>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Volver a Savia" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("/my-day"),
    );
    expect(screen.getByText("Navigation")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Mostrar u ocultar menú" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Volver a Savia" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Volver" }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "/savia-flows?tenantId=0",
      ),
    );
    expect(screen.getByRole("link", { name: "Volver a Savia" })).toBeVisible();
    expect(screen.queryByText("Navigation")).not.toBeInTheDocument();
  });

  it.each(["/studio", "/savia-request", "/savia-flows-other"])(
    "keeps Savia navigation on %s without independent module navigation",
    (route) => {
      render(
        <MemoryRouter initialEntries={[route]}>
          <Layout>
            <p>Contenido</p>
          </Layout>
        </MemoryRouter>,
      );

      expect(screen.getByText("Navigation")).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Mostrar u ocultar menú" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("link", { name: "Volver a Savia" }),
      ).not.toBeInTheDocument();
    },
  );

  it("shows a sidebar toggle alongside history navigation", () => {
    render(
      <MemoryRouter>
        <Layout>
          <p>Contenido</p>
        </Layout>
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("button", { name: "Mostrar u ocultar menú" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Instalar|Install/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Volver" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Adelante" })).toBeDisabled();
  });

  it("keeps an app-level back control for in-app navigation", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          "/studio?tenantId=0&object=customer_profiles&view=admin-screen",
        ]}
      >
        <Layout>
          <RouteControls />
        </Layout>
      </MemoryRouter>,
    );

    const back = screen.getByRole("button", { name: "Volver" });
    const forward = screen.getByRole("button", { name: "Adelante" });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Abrir relaciones" }));
    await waitFor(() => expect(back).toBeEnabled());
    expect(forward).toBeDisabled();

    fireEvent.click(back);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "/studio?tenantId=0&object=customer_profiles&view=admin-screen",
      ),
    );
    expect(forward).toBeEnabled();

    fireEvent.click(forward);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "/studio?tenantId=0&object=customer_profiles&view=screen-relations",
      ),
    );
  });
});

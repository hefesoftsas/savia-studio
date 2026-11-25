import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import { createAdminQueryClient } from "@/queries/query-policy";
import { getSessionGeneration, rotateSessionScope } from "@/auth/session-scope";
import type { AppServices } from "@/app-services";
import { ApiClientError, type ApiClient } from "@/api/api-client";
import { describe, expect, it, vi } from "vitest";
import {
  formatSlugToDisplayName,
  useCurrentTenant,
} from "./use-current-tenant";

function createServices(get = vi.fn()) {
  return {
    get,
    services: {
      apiClient: { get } as unknown as ApiClient,
      queryClient: createAdminQueryClient(),
    } as AppServices,
  };
}

function servicesWrapper(services: AppServices) {
  return ({ children }: PropsWithChildren) =>
    createElement(AppServicesProvider, { services }, children);
}

describe("formatSlugToDisplayName", () => {
  it("formats single words to titlecase", () => {
    expect(formatSlugToDisplayName("example")).toBe("Example");
  });

  it("formats hyphenated and underscored words with spaces and titlecase", () => {
    expect(formatSlugToDisplayName("sample-company")).toBe("Sample Company");
    expect(formatSlugToDisplayName("alpha_beta-gamma")).toBe(
      "Alpha Beta Gamma",
    );
  });
});

describe("useCurrentTenant", () => {
  it("returns canonical platform tenant info when on canonical hostname", () => {
    const { result } = renderHook(() =>
      useCurrentTenant({ hostname: "savia.hefesoft.com" }),
    );

    expect(result.current).toEqual({
      isDedicated: false,
      slug: null,
      name: "Savia",
      kind: "platform",
      id: null,
      monogram: "S",
      isPlatformAdmin: false,
      isLoading: false,
      scopeStatus: "platform",
    });
  });

  it("returns canonical platform tenant info when on localhost", () => {
    const { result } = renderHook(() =>
      useCurrentTenant({ hostname: "localhost" }),
    );

    expect(result.current.isDedicated).toBe(false);
    expect(result.current.slug).toBeNull();
    expect(result.current.name).toBe("Savia");
  });

  it("returns dedicated tenant info with fallback name when on tenant subdomain", () => {
    const { result } = renderHook(() =>
      useCurrentTenant({ hostname: "example-organization.savia.hefesoft.com" }),
    );

    expect(result.current.isDedicated).toBe(true);
    expect(result.current.slug).toBe("example-organization");
    expect(result.current.name).toBe("Example Organization");
    expect(result.current.monogram).toBe("E");
    expect(result.current.kind).toBe("commercial");
  });

  it("returns dedicated tenant info on preview subdomain", () => {
    const { result } = renderHook(() =>
      useCurrentTenant({
        hostname: "example-organization.savia-preview.hefesoft.com",
      }),
    );

    expect(result.current.isDedicated).toBe(true);
    expect(result.current.slug).toBe("example-organization");
    expect(result.current.name).toBe("Example Organization");
    expect(result.current.monogram).toBe("E");
    expect(result.current.kind).toBe("commercial");
  });

  it("shares the current-tenant read between simultaneous consumers", async () => {
    const response = {
      data: { name: "Example", kind: "commercial", id: 42 },
    };
    const { get, services } = createServices(
      vi.fn().mockResolvedValue(response),
    );
    const wrapper = servicesWrapper(services);
    const options = { hostname: "example.savia.hefesoft.com" };
    const first = renderHook(() => useCurrentTenant(options), { wrapper });
    const second = renderHook(() => useCurrentTenant(options), { wrapper });

    await waitFor(() => {
      expect(first.result.current.name).toBe("Example");
      expect(second.result.current.name).toBe("Example");
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not reread the tenant when the same scope rerenders", async () => {
    const { get, services } = createServices(
      vi.fn().mockResolvedValue({
        data: { name: "Example", kind: "commercial", id: 42 },
      }),
    );
    const { rerender } = renderHook(
      ({ hostname }) => useCurrentTenant({ hostname }),
      {
        initialProps: { hostname: "example.savia.hefesoft.com" },
        wrapper: servicesWrapper(services),
      },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    rerender({ hostname: "example.savia.hefesoft.com" });
    rerender({ hostname: "example.savia.hefesoft.com" });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it("does not commit a previous hostname result after the hostname changes", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const { get, services } = createServices(
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    const { result, rerender } = renderHook(
      ({ hostname }) => useCurrentTenant({ hostname }),
      {
        initialProps: { hostname: "old.savia.hefesoft.com" },
        wrapper: servicesWrapper(services),
      },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    rerender({ hostname: "new.savia.hefesoft.com" });
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending[1]?.({
        data: { name: "New tenant", kind: "commercial", id: 2 },
      });
    });
    await waitFor(() => expect(result.current.name).toBe("New tenant"));
    await act(async () => {
      pending[0]?.({
        data: { name: "Old tenant", kind: "commercial", id: 1 },
      });
    });

    expect(result.current.name).toBe("New tenant");
    expect(result.current.id).toBe(2);
  });

  it("keeps the current view scoped to a new session generation", async () => {
    const startGeneration = getSessionGeneration();
    const pending: Array<(value: unknown) => void> = [];
    const { get, services } = createServices(
      vi.fn(
        () =>
          new Promise((resolve) => {
            pending.push(resolve);
          }),
      ),
    );
    const { result } = renderHook(
      () => useCurrentTenant({ hostname: "example.savia.hefesoft.com" }),
      { wrapper: servicesWrapper(services) },
    );
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));

    act(() => rotateSessionScope("principal-change"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => {
      pending[1]?.({
        data: { name: "New principal tenant", kind: "commercial", id: 2 },
      });
    });
    await waitFor(() =>
      expect(result.current.name).toBe("New principal tenant"),
    );
    await act(async () => {
      pending[0]?.({
        data: { name: "Old principal tenant", kind: "commercial", id: 1 },
      });
    });

    expect(result.current.name).toBe("New principal tenant");
    expect(getSessionGeneration()).toBe(startGeneration + 1);
  });

  it("does not request a tenant on the platform host", () => {
    const { get, services } = createServices();
    const { result } = renderHook(
      () => useCurrentTenant({ hostname: "savia.hefesoft.com" }),
      { wrapper: servicesWrapper(services) },
    );

    expect(result.current.kind).toBe("platform");
    expect(result.current.isLoading).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps standalone tenant identity available when services are absent", () => {
    const { result } = renderHook(() =>
      useCurrentTenant({ hostname: "example.savia.hefesoft.com" }),
    );

    expect(result.current.name).toBe("Example");
    expect(result.current.isLoading).toBe(false);
    expect(result.current.scopeStatus).toBe("unavailable");
  });

  it("keeps dedicated reads blocked when tenant resolution fails and exposes retry", async () => {
    const { get, services } = createServices(
      vi.fn().mockRejectedValue(new Error("private upstream details")),
    );
    const { result } = renderHook(
      () => useCurrentTenant({ hostname: "example.savia.hefesoft.com" }),
      { wrapper: servicesWrapper(services) },
    );

    await waitFor(() => expect(result.current.scopeStatus).toBe("error"), {
      timeout: 3_000,
    });
    expect(result.current.id).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.scopeError).toBeTruthy();
    expect(result.current.scopeError).not.toContain("private upstream");
    expect(result.current.retry).toEqual(expect.any(Function));

    get.mockResolvedValueOnce({
      data: { name: "Example", kind: "commercial", id: 42 },
    });
    await act(async () => {
      await result.current.retry?.();
    });
    await waitFor(() => expect(result.current.scopeStatus).toBe("resolved"));
    expect(result.current.id).toBe(42);
  });

  it.each([null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "42"])(
    "does not expose an invalid tenant ID (%s)",
    async (id) => {
      const { services } = createServices(
        vi.fn().mockResolvedValue({
          data: { name: "Example", kind: "commercial", id },
        }),
      );
      const { result } = renderHook(
        () => useCurrentTenant({ hostname: "example.savia.hefesoft.com" }),
        { wrapper: servicesWrapper(services) },
      );

      await waitFor(() => expect(result.current.scopeStatus).toBe("error"));
      expect(result.current.id).toBeNull();
      expect(result.current.scopeError).toBeTruthy();
    },
  );

  it("blocks a previously resolved workspace after the server reports it missing", async () => {
    const workspace = { data: { name: "Example", kind: "commercial", id: 42 } };
    const { get, services } = createServices(
      vi.fn().mockResolvedValue(workspace),
    );
    services.queryClient!.setDefaultOptions({ queries: { retry: false } });
    const { result } = renderHook(
      () => useCurrentTenant({ hostname: "example.savia.hefesoft.com" }),
      { wrapper: servicesWrapper(services) },
    );
    await waitFor(() => expect(result.current.id).toBe(42));
    get.mockRejectedValueOnce(
      new ApiClientError(404, "not_found", "Workspace missing"),
    );
    await act(async () => {
      await services.queryClient!.invalidateQueries();
    });
    await waitFor(() => expect(result.current.scopeStatus).toBe("error"));
    expect(result.current.id).toBeNull();

    await act(async () => {
      await result.current.retry?.();
    });
    await waitFor(() => expect(result.current.id).toBe(42));
    expect(result.current.scopeStatus).toBe("resolved");
  });
});

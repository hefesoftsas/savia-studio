import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServices } from "@/app-services";
import { beginLogout } from "@/auth/logout-progress";
import { rotateSessionScope } from "@/auth/session-scope";
import { AppServicesProvider } from "@/features/assistant/assistant-context";
import {
  clearCachedTenantOptions,
  useTenantOptions,
} from "./savia-request-scope";

type TenantResponse = {
  data: Array<{ id: number; name: string; kind: string }>;
};

function deferredTenantRead() {
  let resolve!: (value: TenantResponse) => void;
  const promise = new Promise<TenantResponse>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function Probe() {
  const tenants = useTenantOptions(true);
  return (
    <p data-testid="tenants">
      {tenants.status}:{tenants.options.map((option) => option.name).join(",")}
    </p>
  );
}

afterEach(() => {
  cleanup();
  clearCachedTenantOptions();
  vi.restoreAllMocks();
});

beforeEach(() => {
  clearCachedTenantOptions();
});

describe("useTenantOptions caché en memoria", () => {
  it("no repite /v1/tenants al entrar y salir con la misma sesión", async () => {
    const get = vi.fn(async () => ({
      data: [
        { id: 101, name: "Norte", kind: "commercial" },
        { id: 7, name: "Plataforma", kind: "platform" },
      ],
    }));
    const services = { apiClient: { get } } as unknown as AppServices;
    const tree = (
      <AppServicesProvider services={services}>
        <Probe />
      </AppServicesProvider>
    );
    const first = render(tree);
    expect(await screen.findByTestId("tenants")).toHaveTextContent(
      "ready:Norte",
    );
    expect(get).toHaveBeenCalledTimes(1);
    first.unmount();
    // Salir y volver a entrar: reutiliza lo conservado sin refetch.
    render(tree);
    expect(await screen.findByTestId("tenants")).toHaveTextContent(
      "ready:Norte",
    );
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("hides the previous client's tenants while the new client loads", async () => {
    const firstGet = vi.fn(async () => ({
      data: [{ id: 101, name: "Norte", kind: "commercial" }],
    }));
    const firstServices = {
      apiClient: { get: firstGet },
    } as unknown as AppServices;
    const first = render(
      <AppServicesProvider services={firstServices}>
        <Probe />
      </AppServicesProvider>,
    );
    expect(await screen.findByText("ready:Norte")).toBeInTheDocument();
    expect(firstGet).toHaveBeenCalledTimes(1);
    first.unmount();

    const secondRead = deferredTenantRead();
    const secondGet = vi.fn(() => secondRead.promise);
    const secondServices = {
      apiClient: { get: secondGet },
    } as unknown as AppServices;
    render(
      <AppServicesProvider services={secondServices}>
        <Probe />
      </AppServicesProvider>,
    );
    expect(screen.getByTestId("tenants")).toHaveTextContent("loading:");
    expect(screen.queryByText(/Norte/)).not.toBeInTheDocument();
    expect(secondGet).toHaveBeenCalledTimes(1);
    secondRead.resolve({
      data: [{ id: 202, name: "Sur", kind: "commercial" }],
    });
    expect(await screen.findByText("ready:Sur")).toBeInTheDocument();
  });

  it("ignores an earlier tenant request after the same client changes session", async () => {
    const previous = deferredTenantRead();
    const current = deferredTenantRead();
    const get = vi
      .fn()
      .mockReturnValueOnce(previous.promise)
      .mockReturnValueOnce(current.promise);
    const services = { apiClient: { get } } as unknown as AppServices;
    const tree = (
      <AppServicesProvider services={services}>
        <Probe />
      </AppServicesProvider>
    );
    const first = render(tree);
    expect(get).toHaveBeenCalledTimes(1);
    act(() => rotateSessionScope("principal-change"));
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => {
      previous.resolve({
        data: [{ id: 101, name: "Norte", kind: "commercial" }],
      });
      await previous.promise;
    });
    expect(screen.getByTestId("tenants")).toHaveTextContent("loading:");
    expect(screen.queryByText(/Norte/)).not.toBeInTheDocument();
    current.resolve({
      data: [{ id: 202, name: "Sur", kind: "commercial" }],
    });
    expect(await screen.findByText("ready:Sur")).toBeInTheDocument();
    first.unmount();
    render(tree);
    expect(screen.getByTestId("tenants")).toHaveTextContent("ready:Sur");
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("hides cached tenants and does not start a read during logout", async () => {
    const get = vi.fn(async () => ({
      data: [{ id: 101, name: "Norte", kind: "commercial" }],
    }));
    const services = { apiClient: { get } } as unknown as AppServices;
    const component = render(
      <AppServicesProvider services={services}>
        <Probe />
      </AppServicesProvider>,
    );
    expect(await screen.findByText("ready:Norte")).toBeInTheDocument();

    let finishLogout!: () => void;
    try {
      act(() => {
        finishLogout = beginLogout();
        rotateSessionScope("logout");
      });
      expect(screen.getByTestId("tenants")).toHaveTextContent("idle:");
      expect(screen.queryByText(/Norte/)).not.toBeInTheDocument();
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      component.unmount();
      finishLogout();
    }
  });
});

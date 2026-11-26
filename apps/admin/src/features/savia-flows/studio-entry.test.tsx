import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import type { AppServices } from "@/app-services";
import { setStudioRuntime } from "@/features/studio-engine/runtime";
import { SaviaFlowsPage } from "./savia-flows-page";
import { StudioFlowsEntry } from "./studio-entry";
vi.mock("@/i18n/core", () => ({ useMessages: () => (key: string) => key }));
vi.mock("ra-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ra-core")>()),
  useCanAccess: () => ({ canAccess: true, isPending: false }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  setStudioRuntime({ embedded: false });
});
describe("retired Studio workflow entry", () => {
  it("opens the replacement catalog in the currently selected tenant", () => {
    setStudioRuntime({ embedded: true, tenantId: 101 });
    render(<StudioFlowsEntry />);
    expect(
      screen.getByRole("link", { name: "Open Savia Flows" }),
    ).toHaveAttribute("href", "/savia-flows?tenantId=101");
    expect(screen.queryByText("Guardar borrador")).not.toBeInTheDocument();
  });
  it("does not assume a tenant in standalone contexts", () => {
    render(<StudioFlowsEntry />);
    expect(
      screen.getByRole("link", { name: "Open Savia Flows" }),
    ).toHaveAttribute("href", "/savia-flows");
  });
  it("explains that Flows is disabled and omits the Studio link", () => {
    vi.stubEnv("VITE_SAVIA_FLOWS_DISABLED", "true");
    render(<StudioFlowsEntry />);
    expect(
      screen.getByText("Savia Flows is disabled in this environment."),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open Savia Flows" }),
    ).not.toBeInTheDocument();
  });

  it("shows the availability message before loading tenants in a branch Preview", () => {
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_SAVIA_FLOWS_DISABLED", "true");
    const get = vi.fn().mockResolvedValue([]);
    const services = { apiClient: { get } } as unknown as AppServices;
    render(
      <MemoryRouter>
        <SaviaFlowsPage services={services} />
      </MemoryRouter>,
    );
    expect(
      screen.getByText("Savia Flows is disabled in this environment."),
    ).toBeVisible();
    expect(screen.queryByTitle("Savia Flows editor")).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});

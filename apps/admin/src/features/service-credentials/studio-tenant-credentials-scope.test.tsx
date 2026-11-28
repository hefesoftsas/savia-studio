import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { AppServices } from "@/app-services";
import { notifyStudioTenantsChanged } from "@/api/tenant-workspaces-client";
import { render } from "@/features/studio-engine/test/locale-test-render";
import { StudioTenantCredentialsSection } from "./studio-tenant-credentials-section";

afterEach(cleanup);

function credentialsFixture() {
  const workspaces = [101, 102].map((tenantId) => ({
    id: String(tenantId),
    tenantId,
    label: `Workspace ${tenantId}`,
    kind: "tenant",
    apiBasePath: `/v1/studio/${tenantId}`,
  }));
  const storedKeys = new Set(["/v1/studio/101/api/settings/geocoding"]);
  const request = vi.fn(
    async (
      path: string,
      init: RequestInit | undefined,
      read: (response: Response) => Promise<Response>,
    ) => {
      if (path.endsWith("/integrations")) {
        return { body: await read(Response.json({ data: [] })) };
      }
      if (!path.endsWith("/settings/geocoding"))
        throw new Error(`Unexpected path: ${path}`);
      if (init?.method === "PUT") storedKeys.add(path);
      const configured = storedKeys.has(path);
      return {
        body: await read(
          Response.json({
            geoapifyConfigured: configured,
            geoapifyStored: configured,
          }),
        ),
      };
    },
  );
  const get = vi.fn().mockResolvedValue({ data: workspaces });
  const services = {
    apiClient: {
      get,
      requestResponseWithBody: request,
    },
  } as unknown as AppServices;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const open = (path = "/service-credentials?tenantId=101") =>
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <StudioTenantCredentialsSection services={services} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  return { get, request, workspaces, open };
}

it("clears the Geoapify draft and reads and writes the newly selected workspace", async () => {
  const { open, request } = credentialsFixture();
  open();
  const originalField = await screen.findByPlaceholderText(
    /dejar en blanco para conservar/,
  );
  expect(
    request.mock.calls.filter(
      ([path]) => path === "/v1/studio/101/api/settings/geocoding",
    ),
  ).toHaveLength(1);
  fireEvent.change(originalField, {
    target: { value: "workspace-101-fixture" },
  });
  expect(originalField).toHaveValue("workspace-101-fixture");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "102" } });

  const nextField = await screen.findByPlaceholderText(
    "Pega tu API key de Geoapify",
  );
  expect(nextField).toHaveValue("");
  expect(screen.queryByRole("button", { name: "Quitar clave" })).toBeNull();
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([path]) => path === "/v1/studio/102/api/settings/geocoding",
      ),
    ).toBe(true),
  );
  fireEvent.change(nextField, { target: { value: "workspace-102-fixture" } });
  fireEvent.click(screen.getByRole("button", { name: "Guardar clave" }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      "/v1/studio/102/api/settings/geocoding",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ geoapifyApiKey: "workspace-102-fixture" }),
      }),
      expect.any(Function),
      undefined,
    ),
  );
  expect(
    await screen.findByRole("button", { name: "Quitar clave" }),
  ).toBeVisible();
});

it("offers a retry when the workspace list fails on the credentials page", async () => {
  const { get, open } = credentialsFixture();
  get.mockRejectedValueOnce(new Error("Workspace request unavailable"));
  open("/service-credentials");

  const retry = await screen.findByRole("button", { name: "Reintentar" });
  expect(screen.queryByText(/No hay tenants disponibles/)).toBeNull();
  fireEvent.click(retry);

  expect(await screen.findByRole("combobox")).toBeVisible();
  expect(get).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
});

it("hides the credential editor when the selected workspace is removed", async () => {
  const { get, open, workspaces } = credentialsFixture();
  open();
  const field = await screen.findByPlaceholderText(
    /dejar en blanco para conservar/,
  );
  fireEvent.change(field, { target: { value: "workspace-101-fixture" } });

  get.mockResolvedValue({ data: [workspaces[1]] });
  act(() => notifyStudioTenantsChanged());

  expect(await screen.findByRole("alert")).toBeVisible();
  expect(screen.queryByText("Clave de Geoapify")).toBeNull();
  expect(screen.queryByText("Workspace 101")).toBeNull();
  expect(screen.getByRole("combobox")).toHaveValue("");
});

it("keeps the current workspace draft while retrying a failed list refresh", async () => {
  const { get, open } = credentialsFixture();
  open();
  const field = await screen.findByPlaceholderText(
    /dejar en blanco para conservar/,
  );
  fireEvent.change(field, { target: { value: "workspace-101-fixture" } });
  get.mockRejectedValueOnce(new Error("Workspace request unavailable"));

  act(() => notifyStudioTenantsChanged());
  const retry = await screen.findByRole("button", { name: "Reintentar" });
  expect(field).toHaveValue("workspace-101-fixture");
  fireEvent.click(retry);

  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull(),
  );
  expect(screen.getByPlaceholderText(/dejar en blanco para conservar/)).toBe(
    field,
  );
  expect(field).toHaveValue("workspace-101-fixture");
  expect(get).toHaveBeenCalledTimes(3);
});

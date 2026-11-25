import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { memoryStore, StoreContextProvider } from "ra-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { ApiClient } from "@/api/api-client";
import { BookingWorkspacePicker } from "./booking-workspace-picker";

afterEach(cleanup);

const organization = {
  id: 42,
  name: "Clínica del Norte",
  idSlug: "clinica-norte-2",
  isActive: true,
  kind: "commercial",
};

function renderPicker(
  get: ApiClient["get"],
  hostname = "savia.hefesoft.com",
  path = "/bookings",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <StoreContextProvider value={memoryStore({ locale: "es" })}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <BookingWorkspacePicker apiClient={{ get }} hostname={hostname} />
        </MemoryRouter>
      </QueryClientProvider>
    </StoreContextProvider>,
  );
}

it.each(["savia.hefesoft.com", "savia-preview.hefesoft.com"])(
  "opens bookings by the saved workspace slug on %s",
  async (hostname) => {
    const get = vi.fn().mockResolvedValue({
      data: [
        organization,
        { ...organization, id: 0, name: "Plataforma Savia", kind: "platform" },
        { ...organization, id: 43, name: "Inactiva", isActive: false },
        {
          ...organization,
          id: 44,
          name: "Sin URL válida",
          idSlug: "bad.example",
        },
      ],
    });
    renderPicker(get, hostname);

    expect(
      await screen.findByRole("link", { name: /Clínica del Norte/ }),
    ).toHaveAttribute("href", `https://clinica-norte-2.${hostname}/#/bookings`);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(get).toHaveBeenCalledWith("/v1/tenants", {
      signal: expect.any(AbortSignal),
    });
  },
);

it("preserves the requested tab and date when choosing a workspace", async () => {
  const hostname = "savia-preview.hefesoft.com";
  renderPicker(
    vi.fn().mockResolvedValue({ data: [organization] }),
    hostname,
    "/bookings?tab=reservations&date=2026-11-25&unrecognized=discard",
  );

  expect(
    await screen.findByRole("link", { name: /Clínica del Norte/ }),
  ).toHaveAttribute(
    "href",
    `https://clinica-norte-2.${hostname}/#/bookings?tab=reservations&date=2026-11-25`,
  );
});

it("lets users retry a failed organization lookup", async () => {
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error("Network error"))
    .mockResolvedValueOnce({ data: [organization] });
  renderPicker(get);

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "No pudimos cargar las organizaciones.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(
    await screen.findByRole("link", { name: /Clínica del Norte/ }),
  ).toBeVisible();
});

it("explains when the user has no available organizations", async () => {
  renderPicker(vi.fn().mockResolvedValue({ data: [] }));
  expect(
    await screen.findByText("No tienes organizaciones disponibles.", {
      exact: false,
    }),
  ).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});

it("does not send users from an unrecognized host to another environment", () => {
  const get = vi.fn();
  renderPicker(get, "localhost");
  expect(
    screen.getByText("Abre el espacio de tu organización para ver Citas."),
  ).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(get).not.toHaveBeenCalled();
});

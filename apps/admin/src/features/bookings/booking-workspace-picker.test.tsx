import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { memoryStore, StoreContextProvider } from "ra-core";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ApiClientError, type ApiClient } from "@/api/api-client";
import { rotateSessionScope } from "@/auth/session-scope";
import { createAdminQueryClient } from "@/queries/query-policy";
import { BookingWorkspacePicker } from "./booking-workspace-picker";

afterEach(cleanup);

const organization = {
  id: 42,
  name: "Clínica del Norte",
  idSlug: "clinica-norte-2",
  isActive: true,
  kind: "commercial",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderPicker(
  get: ApiClient["get"],
  hostname = "savia.hefesoft.com",
  path = "/bookings",
) {
  const queryClient = createAdminQueryClient();
  render(
    <StoreContextProvider value={memoryStore({ locale: "es" })}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <BookingWorkspacePicker apiClient={{ get }} hostname={hostname} />
        </MemoryRouter>
      </QueryClientProvider>
    </StoreContextProvider>,
  );
  return queryClient;
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
    "/bookings?tenantId=17&tab=reservations&date=2026-11-25&unrecognized=discard",
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

it("keeps confirmed organizations and keyboard focus after a temporary refresh failure", async () => {
  const lookup = deferred<never>();
  const get = vi
    .fn()
    .mockResolvedValueOnce({ data: [organization] })
    .mockReturnValueOnce(lookup.promise)
    .mockResolvedValueOnce({
      data: [{ ...organization, name: "Clínica actualizada" }],
    });
  const client = renderPicker(get);
  const link = await screen.findByRole("link", { name: /Clínica del Norte/ });
  link.focus();

  let refresh!: Promise<void>;
  act(() => {
    refresh = client.invalidateQueries();
  });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  expect(screen.getByRole("link", { name: /Clínica del Norte/ })).toBe(link);
  expect(await screen.findByRole("status")).toHaveTextContent("Actualizando");
  await act(async () => {
    lookup.reject(new ApiClientError(503, "UNAVAILABLE", "Private diagnostic"));
    await refresh;
  });

  await screen.findByText(/No pudimos cargar las organizaciones/);
  expect(screen.queryByRole("link", { name: /Clínica del Norte/ })).toBe(link);
  expect(link).toHaveFocus();
  expect(screen.getByRole("status")).toHaveTextContent(
    "Falló la actualización",
  );
  expect(screen.queryByText(/Private diagnostic/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(await screen.findByRole("link", { name: /Clínica actualizada/ })).toBe(
    link,
  );
  expect(screen.queryByText(/Falló la actualización/)).toBeNull();
});

it.each([401, 403])(
  "discards a confirmed organization list after a refresh receives HTTP %s",
  async (status) => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: [organization] })
      .mockRejectedValueOnce(
        new ApiClientError(status, "DENIED", "Private diagnostic"),
      );
    const client = renderPicker(get);
    await screen.findByRole("link", { name: /Clínica del Norte/ });

    await act(async () => {
      await client.invalidateQueries();
    });

    if (status === 401)
      expect(
        await screen.findByRole("link", { name: "Volver a iniciar sesión" }),
      ).toBeVisible();
    else
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "No pudimos cargar",
      );
    expect(
      screen.queryByRole("link", { name: /Clínica del Norte/ }),
    ).toBeNull();
    expect(client.getQueriesData({})).toEqual([[expect.any(Array), undefined]]);
  },
);

it("hides the previous user's organizations while the new session loads", async () => {
  const oldLookup = deferred<{
    data: Array<typeof organization>;
  }>();
  const nextLookup = deferred<{
    data: Array<typeof organization>;
  }>();
  const get = vi
    .fn()
    .mockResolvedValueOnce({ data: [organization] })
    .mockReturnValueOnce(oldLookup.promise)
    .mockReturnValueOnce(nextLookup.promise);
  const client = renderPicker(get);
  await screen.findByRole("link", { name: /Clínica del Norte/ });

  act(() => {
    void client.invalidateQueries();
  });
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
  act(() => rotateSessionScope("principal-change"));
  await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
  expect(get.mock.calls[1][1].signal.aborted).toBe(true);
  expect(screen.queryByRole("link")).toBeNull();

  await act(async () => {
    oldLookup.resolve({ data: [organization] });
    nextLookup.resolve({
      data: [
        {
          ...organization,
          id: 43,
          idSlug: "clinica-del-sur",
          name: "Clínica del Sur",
        },
      ],
    });
  });
  expect(
    await screen.findByRole("link", { name: /Clínica del Sur/ }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: /Clínica del Norte/ })).toBeNull();
});

it("offers a fresh sign-in when the organization list rejects the session", async () => {
  const get = vi
    .fn()
    .mockRejectedValue(new ApiClientError(401, "UNAUTHORIZED", "Signed out"));
  renderPicker(
    get,
    "savia-preview.hefesoft.com",
    "/bookings?tab=reservations&date=2026-11-25&ignored=1",
  );

  const link = await screen.findByRole("link", {
    name: "Volver a iniciar sesión",
  });
  const authorize = new URL(link.getAttribute("href")!);
  expect(authorize.pathname).toBe("/api/auth/admin/authorize");
  expect(authorize.searchParams.get("resume")).toBe("bookings");
  expect(authorize.searchParams.get("booking_query")).toBe(
    "tab=reservations&date=2026-11-25",
  );
  expect(screen.queryByRole("button", { name: "Reintentar" })).toBeNull();
  expect(get).toHaveBeenCalledTimes(1);
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

it.each(["127.0.0.1", "savia-preview-dev-local.test-account.workers.dev", ""])(
  "opens only authorized organizations on the current deployment at %s",
  async (hostname) => {
    renderPicker(
      vi.fn().mockResolvedValue({
        data: [
          organization,
          { ...organization, id: 11, kind: "platform", name: "Platform" },
          { ...organization, id: 43, isActive: false, name: "Inactive" },
        ],
      }),
      hostname,
      "/bookings?tenantId=11&tab=availability&date=2026-11-25&other=ignore",
    );

    expect(
      await screen.findByRole("link", { name: /Clínica del Norte/ }),
    ).toHaveAttribute(
      "href",
      "/#/bookings?tab=availability&date=2026-11-25&tenantId=42",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
  },
);

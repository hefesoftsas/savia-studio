import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import { StoreContextProvider, memoryStore, useSetLocale } from "ra-core";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { useLayoutEffect, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { BookingPage } from "./booking-page";
import { ApiClientError } from "@/api/api-client";

afterEach(cleanup);

it.each([
  [422, "Use an IANA time zone."],
  [403, "Organization access denied."],
  [500, "Internal server error"],
])("reports the server's rejection with HTTP %s", async (status, message) => {
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings,
        candidates: [{ principalId: "principal-1", displayName: "Ari" }],
        canManage: true,
        principalId: "principal-1",
        publicUrl: null,
        calendar: { provider: null, status: "not_connected" },
      },
    }),
    put: vi
      .fn()
      .mockRejectedValue(new ApiClientError(status, "CRM_SYNC_ERROR", message)),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(message);
  expect(alert).toHaveTextContent(`HTTP ${status}`);
});

it("explains missing publication requirements before submitting settings", async () => {
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings: { ...settings, services: [], professionals: [] },
        candidates: [],
        canManage: true,
        principalId: "principal-1",
        publicUrl: "https://savia.test/public/bookings/page-token",
        calendar: { provider: null, status: "not_connected" },
      },
    }),
    put: vi
      .fn()
      .mockRejectedValue(
        new ApiClientError(422, "CRM_SYNC_ERROR", "Invalid publication"),
      ),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  fireEvent.click(screen.getByLabelText("Published"));
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Enable a service and an assigned professional before publishing.",
  );
  expect(apiClient.put).not.toHaveBeenCalled();
});

it("does not offer an unpublished public page even when its token exists", async () => {
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings,
        candidates: [],
        canManage: true,
        principalId: "principal-1",
        publicUrl: "https://savia.test/public/bookings/page-token",
        calendar: { provider: null, status: "not_connected" },
      },
    }),
    put: vi.fn(),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  expect(
    screen.queryByRole("link", { name: "Open team booking page" }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole("link", { name: /page-token/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "Save enabled and published settings to open the public page.",
    ),
  ).toBeInTheDocument();
});

it("offers the legacy team agenda after published settings are saved", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: "https://savia.test/public/bookings/page-token",
    calendar: { provider: null, status: "not_connected" },
  };
  const apiClient = {
    get: vi.fn().mockResolvedValue({ data: bootstrap }),
    put: vi.fn().mockResolvedValue({
      data: {
        ...bootstrap,
        settings: { ...settings, version: 4, published: true },
      },
    }),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Review and publish" }));
  fireEvent.click(screen.getByLabelText("Published"));
  expect(
    screen.queryByRole("link", { name: "Open team booking page" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(
    await screen.findByRole("link", { name: "Open team booking page" }),
  ).toHaveAttribute("href", bootstrap.publicUrl);
});

const settings = {
  version: 3,
  enabled: true,
  published: false,
  title: "Appointments",
  description: "Visit our team",
  timeZone: "America/Bogota",
  leadMinutes: 60,
  horizonDays: 30,
  cancellationMinutes: 240,
  reminderMinutes: 60,
  services: [
    {
      id: "consult",
      name: "Consultation",
      description: "First visit",
      durationMinutes: 30,
      bufferMinutes: 5,
      enabled: true,
      professionalIds: ["professional-1"],
    },
  ],
  professionals: [
    {
      id: "professional-1",
      principalId: "principal-1",
      enabled: true,
      weekly: [{ day: 1, start: "09:00", end: "12:00" }],
      exceptions: [],
    },
  ],
};

function mount(
  apiClient: Record<string, ReturnType<typeof vi.fn>>,
  tenantId = 42,
  initialEntry = "/bookings",
  children?: ReactNode,
) {
  return render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          {children}
          <BookingPage
            services={{ apiClient } as never}
            tenantId={tenantId}
            hostname="clinic.savia-preview.hefesoft.com"
          />
        </MemoryRouter>
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
}

it.each([403, 404])(
  "lets users choose another organization if Bookings settings return HTTP %s",
  async (status) => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiClientError(status, "UNAVAILABLE", "Workspace unavailable"),
      )
      .mockResolvedValueOnce({
        data: {
          settings,
          candidates: [],
          canManage: true,
          principalId: "principal-1",
          publicUrl: null,
          calendar: { provider: null, status: "not_connected" },
        },
      })
      .mockResolvedValue({ data: [] });
    mount({ get }, 42, "/bookings?tab=reservations&date=2026-11-25&ignored=1");
    expect(
      await screen.findByRole("link", { name: "Choose another organization" }),
    ).toHaveAttribute(
      "href",
      "https://savia-preview.hefesoft.com/#/bookings?tab=reservations&date=2026-11-25",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { name: "Reservations" }),
    ).toBeVisible();
    expect(
      get.mock.calls.filter(([path]) => path === "/v1/tenants/42/booking"),
    ).toHaveLength(2);
    expect(
      screen.queryByRole("link", { name: "Choose another organization" }),
    ).not.toBeInTheDocument();
  },
);

it("offers workspace recovery when access is lost after Bookings settings load", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      data: {
        settings,
        candidates: [],
        canManage: true,
        principalId: "principal-1",
        publicUrl: null,
        calendar: { provider: null, status: "not_connected" },
      },
    })
    .mockRejectedValueOnce(
      new ApiClientError(403, "FORBIDDEN", "Reservation access denied"),
    );
  mount({ get }, 42, "/bookings?tab=reservations&date=2026-11-25");
  expect(
    await screen.findByRole("link", { name: "Choose another organization" }),
  ).toHaveAttribute(
    "href",
    "https://savia-preview.hefesoft.com/#/bookings?tab=reservations&date=2026-11-25",
  );
  expect(
    screen.queryByRole("heading", { name: "Reservations" }),
  ).not.toBeInTheDocument();
});

it.each([
  ["settings", "reservations", 1],
  ["reservations", "reservations", 2],
  ["public links", "sharing", 2],
])(
  "offers a fresh sign-in when Bookings %s rejects the session",
  async (source, tab, reads) => {
    const get = vi.fn();
    if (source !== "settings") {
      get.mockResolvedValueOnce({
        data: {
          settings,
          candidates: [],
          canManage: true,
          principalId: "principal-1",
          publicUrl: null,
          calendar: { provider: null, status: "not_connected" },
        },
      });
    }
    get.mockRejectedValue(
      new ApiClientError(401, "UNAUTHORIZED", "Signed out"),
    );
    const query = `tab=${tab}&date=2026-11-25&tenantId=42`;
    mount({ get }, 42, `/bookings?${query}&ignored=1`);

    const link = await screen.findByRole("link", { name: "Sign in again" });
    const authorize = new URL(link.getAttribute("href")!);
    expect(authorize.pathname).toBe("/api/auth/admin/authorize");
    expect(authorize.searchParams.get("resume")).toBe("bookings");
    expect(authorize.searchParams.get("booking_query")).toBe(query);
    expect(screen.queryByRole("heading", { name: "Reservations" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(get).toHaveBeenCalledTimes(reads);
  },
);

it("requires a fresh sign-in to return to booking links if deletion is unauthorized", async () => {
  const publicUrl = "https://savia.test/public/bookings/team-token";
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      data: { settings, candidates: [], canManage: true, publicUrl: null },
    })
    .mockResolvedValueOnce({
      data: {
        links: [
          {
            id: "link-1",
            scope: { kind: "team" },
            serviceId: null,
            expiresAt: null,
            revokedAt: null,
            dailyLimit: 25,
            version: 8,
            publicUrl,
          },
        ],
      },
    });
  const remove = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiClientError(401, "UNAUTHORIZED", "Signed out"),
    );
  const query = "tab=sharing&date=2026-11-25&tenantId=42";
  mount({ get, delete: remove }, 42, `/bookings?${query}`);
  fireEvent.click(await screen.findByRole("button", { name: "Delete link" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm deletion" }));

  const link = await screen.findByRole("link", { name: "Sign in again" });
  const authorize = new URL(link.getAttribute("href")!);
  expect(authorize.searchParams.get("resume")).toBe("bookings");
  expect(authorize.searchParams.get("booking_query")).toBe(query);
  expect(screen.queryByDisplayValue(publicUrl)).toBeNull();
  expect(remove).toHaveBeenCalledExactlyOnceWith(
    "/v1/tenants/42/booking/public-links/link-1",
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 8 }),
    },
  );
});

it("ignores a late session failure after leaving the booking links tab", async () => {
  const apiClient = managementClient();
  let rejectLinks!: (error: ApiClientError) => void;
  const pendingLinks = new Promise((_, reject) => {
    rejectLinks = reject;
  });
  const get = vi.fn((path: string, init?: RequestInit) =>
    path.endsWith("/public-links") ? pendingLinks : apiClient.get(path, init),
  );
  mount({ get }, 42, "/bookings?tab=sharing");
  await screen.findByText("Loading booking links…");
  const signal = get.mock.calls.find(([path]) =>
    path.endsWith("/public-links"),
  )?.[1]?.signal;
  expect(signal?.aborted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    rejectLinks(new ApiClientError(401, "UNAUTHORIZED", "Signed out"));
  });
  expect(
    screen.getByRole("heading", { name: "My Day availability" }),
  ).toBeVisible();
  expect(screen.queryByRole("link", { name: "Sign in again" })).toBeNull();
});

it.each([
  ["settings", "Save settings", ""],
  ["availability", "Save availability", ""],
  ["availability", "Choose calendar: Google", "/calendar"],
  ["availability", "Use My Day to block busy times", "/agenda"],
])(
  "offers a fresh sign-in if the session expires at %s → %s",
  async (tab, action, endpoint) => {
    const apiClient = managementClient();
    apiClient.put.mockRejectedValueOnce(
      new ApiClientError(401, "UNAUTHORIZED", "Signed out"),
    );
    const query = `tab=${tab}&date=2026-11-25&tenantId=42`;
    mount(apiClient, 42, `/bookings?${query}`);
    fireEvent.click(await screen.findByRole("button", { name: action }));

    const link = await screen.findByRole("link", { name: "Sign in again" });
    const authorize = new URL(link.getAttribute("href")!);
    expect(authorize.searchParams.get("resume")).toBe("bookings");
    expect(authorize.searchParams.get("booking_query")).toBe(query);
    expect(screen.queryByRole("button", { name: action })).toBeNull();
    expect(apiClient.put).toHaveBeenCalledExactlyOnceWith(
      `/v1/tenants/42/booking${endpoint}`,
      expect.any(Object),
    );
  },
);

it("offers an ordinary retry when Bookings settings are temporarily unavailable", async () => {
  const get = vi
    .fn()
    .mockRejectedValue(
      new ApiClientError(503, "SERVICE_UNAVAILABLE", "Unavailable"),
    );
  mount({ get });
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Booking settings could not be loaded.",
  );
  expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  expect(
    screen.queryByRole("link", { name: "Choose another organization" }),
  ).not.toBeInTheDocument();
});

it("loads booking settings and candidates, then saves the edited configuration", async () => {
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings,
        candidates: [{ principalId: "principal-1", displayName: "Ari" }],
        canManage: true,
        principalId: "principal-1",
        publicUrl:
          "https://savia.test/public/bookings/token-12345678901234567890",
        calendar: { provider: null, status: "not_connected" },
      },
    }),
    put: vi
      .fn()
      .mockResolvedValue({ data: { settings: { ...settings, version: 4 } } }),
    post: vi.fn(),
  };
  mount(apiClient);

  expect(
    await screen.findByRole("heading", { name: "Appointments" }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Team" }));
  expect(screen.getByLabelText("Professional")).toHaveValue("principal-1");
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  fireEvent.change(screen.getByLabelText("Public title"), {
    target: { value: "Savia visits" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText("Booking settings saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({ version: 3, title: "Savia visits" }),
  );
});

it("keeps unsaved booking settings when the display language changes", async () => {
  function SwitchLanguage() {
    const setLocale = useSetLocale();
    return <button onClick={() => setLocale("es")}>Spanish</button>;
  }
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings,
        candidates: [{ principalId: "principal-1", displayName: "Ari" }],
        canManage: true,
        principalId: "principal-1",
        publicUrl: null,
        calendar: { provider: null, status: "not_connected" },
      },
    }),
  };
  mount(apiClient, 42, "/bookings", <SwitchLanguage />);
  fireEvent.click(await screen.findByRole("button", { name: "Details" }));
  fireEvent.change(screen.getByLabelText("Public title"), {
    target: { value: "Unsaved agenda title" },
  });

  fireEvent.click(screen.getByRole("button", { name: "Spanish" }));
  expect(await screen.findByLabelText("Título público")).toHaveValue(
    "Unsaved agenda title",
  );
  expect(apiClient.get).toHaveBeenCalledOnce();
});

it("grants My Day busy-time access and reports the authorized calendar sources", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
    agenda: { enabled: false, sourceCount: 0 },
  };
  const apiClient = {
    get: vi.fn().mockResolvedValue({ data: bootstrap }),
    put: vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          ...bootstrap,
          settings: structuredClone(settings),
          agenda: { enabled: true, sourceCount: 3 },
        },
      })
      .mockResolvedValueOnce({
        data: { ...bootstrap, agenda: { enabled: true, sourceCount: 4 } },
      })
      .mockResolvedValueOnce({
        data: { ...bootstrap, agenda: { enabled: false, sourceCount: 0 } },
      }),
  };
  mount(apiClient);
  fireEvent.change(await screen.findByLabelText("Public title"), {
    target: { value: "My Day settings draft" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Availability" })[0]);
  await screen.findByRole("heading", { name: "My Day availability" });
  fireEvent.change(await screen.findByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  expect(
    screen.getByText(
      "Grant access to busy times in your current Google or Outlook calendar and imported or subscribed calendars. Meeting details stay private.",
    ),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Use My Day to block busy times" }),
  );
  await screen.findByText("My Day access is enabled. Calendar sources: 3.");
  expect(screen.getByLabelText("Monday start")).toHaveValue("10:00");
  expect(apiClient.put).toHaveBeenCalledWith("/v1/tenants/42/booking/agenda", {
    enabled: true,
  });
  expect(
    screen.getByRole("button", { name: "Update calendar access" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Stop using My Day" }),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "Update calendar access" }),
  );
  await screen.findByText("My Day access is enabled. Calendar sources: 4.");
  fireEvent.click(screen.getByRole("button", { name: "Stop using My Day" }));
  await screen.findByText("My Day access is off.");
  expect(apiClient.put.mock.calls).toEqual([
    ["/v1/tenants/42/booking/agenda", { enabled: true }],
    ["/v1/tenants/42/booking/agenda", { enabled: true }],
    ["/v1/tenants/42/booking/agenda", { enabled: false }],
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Booking settings" }));
  expect(await screen.findByLabelText("Public title")).toHaveValue(
    "My Day settings draft",
  );
});

it("gives a recovery action after a failed bootstrap and reports version conflicts", async () => {
  const apiClient = {
    get: vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({
        data: {
          settings,
          candidates: [{ principalId: "principal-1", displayName: "Ari" }],
          canManage: true,
          principalId: "principal-1",
          publicUrl: null,
          calendar: { provider: null, status: "not_connected" },
        },
      }),
    put: vi.fn().mockRejectedValue(
      Object.assign(new Error("stale"), {
        code: "VERSION_CONFLICT",
        status: 409,
      }),
    ),
    post: vi.fn(),
  };
  mount(apiClient);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "could not be loaded",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "changed elsewhere",
  );
});

it("aborts the previous settings request and ignores its late response after switching tenants", async () => {
  let finishFirst!: (value: unknown) => void;
  const first = new Promise((resolve) => {
    finishFirst = resolve;
  });
  const apiClient = {
    get: vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce({
        data: {
          settings: { ...settings, title: "Tenant B" },
          candidates: [],
          canManage: false,
          principalId: "principal-2",
          publicUrl: null,
          calendar: { provider: null, status: "not_connected" },
        },
      }),
    put: vi.fn(),
    post: vi.fn(),
  };
  const view = mount(apiClient, 41);
  const firstSignal = apiClient.get.mock.calls[0][1]?.signal;
  view.rerender(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <MemoryRouter>
          <BookingPage services={{ apiClient } as never} tenantId={42} />
        </MemoryRouter>
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  expect(
    await screen.findByRole("heading", { name: "Tenant B" }),
  ).toBeInTheDocument();
  expect(firstSignal?.aborted).toBe(true);
  finishFirst({
    data: {
      settings,
      candidates: [],
      canManage: true,
      principalId: "principal-1",
      publicUrl: null,
      calendar: { provider: null, status: "not_connected" },
    },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("heading", { name: "Tenant B" }),
    ).toBeInTheDocument(),
  );
  expect(apiClient.get).toHaveBeenNthCalledWith(2, "/v1/tenants/42/booking", {
    signal: expect.any(AbortSignal),
  });
  expect(apiClient.get.mock.calls[1][1].signal.aborted).toBe(false);
});

it("does not apply a pending settings save to the newly selected workspace", async () => {
  const workspace = (title: string, principalId: string) => ({
    settings: { ...settings, title },
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId,
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  });
  const previous = workspace("Previous workspace", "principal-1");
  const current = workspace("Current workspace", "principal-2");
  let finishSave!: (value: { data: typeof previous }) => void;
  const pending = new Promise<{ data: typeof previous }>((resolve) => {
    finishSave = resolve;
  });
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ data: previous })
      .mockResolvedValueOnce({ data: current }),
    put: vi.fn().mockReturnValue(pending),
  };
  const view = mount(apiClient, 41);
  await screen.findByRole("heading", { name: "Previous workspace" });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/41/booking",
    expect.any(Object),
  );

  view.rerender(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <MemoryRouter initialEntries={["/bookings"]}>
          <BookingPage services={{ apiClient } as never} tenantId={42} />
        </MemoryRouter>
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  expect(
    await screen.findByRole("heading", { name: "Current workspace" }),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Save settings" })).toBeEnabled();
  await act(async () => finishSave({ data: previous }));
  expect(
    screen.getByRole("heading", { name: "Current workspace" }),
  ).toBeVisible();
  expect(screen.queryByText("Booking settings saved.")).toBeNull();
});

it("keeps professional controls to the signed-in professional and saves usable weekly periods", async () => {
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings,
        candidates: [
          { principalId: "principal-1", displayName: "Ari" },
          { principalId: "principal-2", displayName: "Sam" },
        ],
        canManage: false,
        principalId: "principal-1",
        publicUrl: null,
        calendar: { provider: "google_calendar", status: "connected" },
      },
    }),
    put: vi.fn().mockResolvedValue({
      data: {
        settings: {
          ...settings,
          version: 4,
          professionals: [
            {
              ...settings.professionals[0],
              weekly: [{ day: 1, start: "10:00", end: "12:00" }],
            },
          ],
        },
        candidates: [{ principalId: "principal-1", displayName: "Ari" }],
        canManage: false,
        principalId: "principal-1",
        publicUrl: null,
        calendar: { provider: "google_calendar", status: "connected" },
      },
    }),
    post: vi.fn(),
  };
  mount(apiClient);
  await screen.findByText("Your availability");
  expect(screen.queryByLabelText("Professional")).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole("button", { name: "Availability" })[0]);
  await screen.findByLabelText("Monday start");
  expect(screen.getByLabelText("Monday start")).toHaveValue("09:00");
  fireEvent.change(screen.getByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/availability",
    expect.objectContaining({
      version: 3,
      weekly: [{ day: 1, start: "10:00", end: "12:00" }],
    }),
  );
  expect(screen.getByText("Google Calendar connected")).toBeInTheDocument();
});

it("shows the saved calendar provider and asks before cancelling its event", async () => {
  const reservation = {
    id: "reservation-1",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 8,
    deliveryStatus: "failed: SMTP unavailable",
    calendarProvider: "google_calendar",
    calendarStatus: "failed",
  };
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ data: bootstrap })
      .mockResolvedValueOnce({ data: [reservation] }),
    put: vi.fn(),
    post: vi.fn().mockResolvedValue({
      data: { ...reservation, status: "cancelled", version: 9 },
    }),
  };
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  expect(await screen.findByText("Casey Customer")).toBeInTheDocument();
  expect(screen.getByText("casey@example.test")).toBeInTheDocument();
  expect(screen.getByText("failed: SMTP unavailable")).toHaveClass(
    "text-destructive",
  );
  expect(screen.getByText("Could not save to Google Calendar")).toHaveClass(
    "text-destructive",
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(confirm).toHaveBeenCalledWith(
    "Cancel this reservation? It will remain in history as cancelled. Savia will request cancellation of its Google Calendar event and linked video meeting, where supported.",
  );
  expect(await screen.findByText("Reservation cancelled.")).toBeInTheDocument();
  expect(apiClient.post).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/reservations/reservation-1/cancel",
    { version: 8 },
  );
  expect(apiClient.get.mock.calls[1][0]).toMatch(
    /^\/v1\/tenants\/42\/booking\/reservations\?from=/,
  );
  expect(apiClient.get.mock.calls[1][0]).toContain("&to=");
});

it("returns to the selected agenda after a reservation action requires sign-in", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      data: {
        settings,
        candidates: [],
        canManage: true,
        publicUrl: null,
        calendar: { provider: null, status: "not_connected" },
      },
    })
    .mockResolvedValueOnce({
      data: [
        {
          id: "reservation-1",
          serviceName: "Consultation",
          professionalName: "Ari",
          startsAt: "2026-11-25T14:00:00Z",
          endsAt: "2026-11-25T14:30:00Z",
          customerName: "Casey Customer",
          customerEmail: "casey@example.test",
          status: "confirmed",
          version: 8,
          deliveryStatus: "sent",
          calendarStatus: "not_requested",
          canGenerateConference: true,
        },
      ],
    });
  const post = vi
    .fn()
    .mockRejectedValueOnce(
      new ApiClientError(401, "UNAUTHORIZED", "Signed out"),
    );
  const query = "tab=reservations&date=2026-11-25&tenantId=42";
  mount({ get, post }, 42, `/bookings?${query}`);
  fireEvent.click(
    await screen.findByRole("button", { name: "Generate video link" }),
  );

  const link = await screen.findByRole("link", { name: "Sign in again" });
  const authorize = new URL(link.getAttribute("href")!);
  expect(authorize.searchParams.get("resume")).toBe("bookings");
  expect(authorize.searchParams.get("booking_query")).toBe(query);
  expect(screen.queryByText("Casey Customer")).toBeNull();
  expect(post).toHaveBeenCalledExactlyOnceWith(
    "/v1/tenants/42/booking/reservations/reservation-1/conference",
    { version: 8 },
  );
});

it.each([
  [
    "Cancel reservation",
    "Reservation could not be cancelled. Refresh and retry.",
  ],
  [
    "Generate video link",
    "Video meeting link request failed. Check the calendar connection and retry.",
  ],
])(
  "keeps reservations and pagination visible when %s fails",
  async (action, message) => {
    const reservation = {
      id: "reservation-1",
      serviceId: "consult",
      professionalId: "professional-1",
      serviceName: "Consultation",
      professionalName: "Ari",
      startsAt: "2026-10-05T14:00:00Z",
      endsAt: "2026-10-05T14:30:00Z",
      customerName: "Casey Customer",
      customerEmail: "casey@example.test",
      status: "confirmed",
      version: 8,
      deliveryStatus: "sent",
      calendarStatus: "not_requested",
      canGenerateConference: true,
    };
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          data: { settings, candidates: [], canManage: true, publicUrl: null },
        })
        .mockResolvedValueOnce({
          data: [reservation],
          nextCursor: "next-page",
        }),
      post: vi.fn().mockRejectedValueOnce(new Error("Temporary failure")),
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(apiClient, 42, "/bookings?tab=reservations");
    fireEvent.click(await screen.findByRole("button", { name: action }));

    expect(await screen.findAllByText(message)).toHaveLength(1);
    expect(
      within(screen.getByRole("row", { name: /Casey Customer/ })).getByRole(
        "alert",
      ),
    ).toHaveTextContent(message);
    expect(screen.getByText("Casey Customer")).toBeVisible();
    expect(screen.getByRole("button", { name: action })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Load more reservations" }),
    ).toBeEnabled();
    expect(apiClient.get).toHaveBeenCalledTimes(2);
    confirm.mockRestore();
  },
);

it("keeps simultaneous reservation updates and their errors associated with each row", async () => {
  const reservation = {
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerEmail: "casey@example.test",
    status: "confirmed",
    version: 8,
    deliveryStatus: "sent",
    calendarStatus: "not_requested",
    canGenerateConference: true,
  };
  const pending = new Map<string, (reason: Error) => void>();
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({
        data: { settings, candidates: [], canManage: true, publicUrl: null },
      })
      .mockResolvedValueOnce({
        data: [
          { ...reservation, id: "first", customerName: "First customer" },
          { ...reservation, id: "second", customerName: "Second customer" },
        ],
      }),
    post: vi.fn(
      (path: string) =>
        new Promise((_resolve, reject) => pending.set(path, reject)),
    ),
  };
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  mount(apiClient, 42, "/bookings?tab=reservations");
  const first = within(
    await screen.findByRole("row", { name: /First customer/ }),
  );
  const second = within(screen.getByRole("row", { name: /Second customer/ }));
  fireEvent.click(first.getByRole("button", { name: "Cancel reservation" }));
  fireEvent.click(second.getByRole("button", { name: "Cancel reservation" }));
  expect(
    first.getByRole("button", { name: "Cancelling reservation…" }),
  ).toBeDisabled();
  expect(
    second.getByRole("button", { name: "Cancelling reservation…" }),
  ).toBeDisabled();
  expect(
    first.getByRole("button", { name: "Generate video link" }),
  ).toBeDisabled();

  await act(async () =>
    pending.get("/v1/tenants/42/booking/reservations/first/cancel")!(
      new Error("First failure"),
    ),
  );
  expect(first.getByRole("alert")).toHaveTextContent(
    "Reservation could not be cancelled.",
  );
  expect(
    first.getByRole("button", { name: "Cancel reservation" }),
  ).toBeEnabled();
  expect(
    second.getByRole("button", { name: "Cancelling reservation…" }),
  ).toBeDisabled();
  await act(async () =>
    pending.get("/v1/tenants/42/booking/reservations/second/cancel")!(
      new Error("Second failure"),
    ),
  );
  expect(second.getByRole("alert")).toHaveTextContent(
    "Reservation could not be cancelled.",
  );
  expect(first.getByRole("alert")).toHaveTextContent(
    "Reservation could not be cancelled.",
  );
  expect(apiClient.post).toHaveBeenCalledTimes(2);
  confirm.mockRestore();
});

it.each(["Cancel reservation", "Generate video link"])(
  "keeps the result of %s when an older refresh finishes last",
  async (action) => {
    const reservation = {
      id: "reservation-1",
      serviceId: "consult",
      professionalId: "professional-1",
      serviceName: "Consultation",
      professionalName: "Ari",
      startsAt: "2026-10-05T14:00:00Z",
      endsAt: "2026-10-05T14:30:00Z",
      customerName: "Casey Customer",
      customerEmail: "casey@example.test",
      status: "confirmed" as const,
      version: 8,
      deliveryStatus: "sent",
      calendarStatus: "not_requested",
      canGenerateConference: true,
    };
    const cancel = action === "Cancel reservation";
    let finishRead!: (value: unknown) => void;
    let finishWrite!: (value: unknown) => void;
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          data: { settings, candidates: [], canManage: true, publicUrl: null },
        })
        .mockResolvedValueOnce({ data: [reservation] })
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishRead = resolve;
            }),
        ),
      post: vi.fn(
        () =>
          new Promise((resolve) => {
            finishWrite = resolve;
          }),
      ),
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(apiClient, 42, "/bookings?tab=reservations");
    fireEvent.click(await screen.findByRole("button", { name: action }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(3));
    await act(async () =>
      finishWrite({
        data: cancel
          ? { ...reservation, status: "cancelled", version: 9 }
          : {
              ...reservation,
              conference: {
                provider: "google_meet",
                joinUrl: null,
                status: "pending",
              },
            },
      }),
    );
    await act(async () => finishRead({ data: [reservation] }));
    expect(screen.getByText("Casey Customer")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: action }),
    ).not.toBeInTheDocument();
    if (cancel) {
      expect(screen.getByText("Cancelled")).toBeVisible();
    } else {
      apiClient.get.mockResolvedValueOnce({
        data: [
          {
            ...reservation,
            conference: {
              provider: "google_meet",
              joinUrl: "https://meet.google.com/abc-defg-hij",
              status: "ready",
            },
          },
        ],
      });
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      expect(
        await screen.findByRole("link", { name: "Join Google Meet" }),
      ).toBeVisible();
    }
    confirm.mockRestore();
  },
);

it("shows a single error when the reservations list cannot load and retries it", async () => {
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({
        data: { settings, candidates: [], canManage: true, publicUrl: null },
      })
      .mockRejectedValueOnce(new Error("Temporary read failure"))
      .mockResolvedValueOnce({ data: [] }),
  };
  mount(apiClient, 42, "/bookings?tab=reservations");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Reservations could not be loaded.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByText("No reservations in this period."),
  ).toBeVisible();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("does not cancel a reservation when cancellation is declined", async () => {
  const reservation = {
    id: "reservation-decline",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 1,
    deliveryStatus: "sent",
    calendarProvider: "outlook",
    calendarStatus: "pending",
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          settings,
          candidates: [],
          canManage: true,
          principalId: "principal-1",
          publicUrl: null,
          calendar: { provider: null, status: "not_connected" },
        },
      })
      .mockResolvedValueOnce({ data: [reservation] }),
    put: vi.fn(),
    post: vi.fn(),
  };
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  expect(await screen.findByText("Saving to Outlook…")).toBeInTheDocument();
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel reservation" }),
  );
  expect(confirm).toHaveBeenCalledWith(
    "Cancel this reservation? It will remain in history as cancelled. Savia will request cancellation of its Outlook event and linked video meeting, where supported.",
  );
  expect(apiClient.post).not.toHaveBeenCalled();
  expect(apiClient.get).toHaveBeenCalledTimes(2);
});

it.each([
  [
    "google_calendar",
    "confirmed",
    true,
    "completed",
    "Saved in Google Calendar",
  ],
  ["outlook", "confirmed", true, "completed", "Saved in Outlook"],
  [
    "google_calendar",
    "confirmed",
    true,
    "pending",
    "Event saved in Google Calendar; synchronization pending",
  ],
  [
    "outlook",
    "confirmed",
    true,
    "failed",
    "Event saved in Outlook; synchronization failed",
  ],
  [
    "google_calendar",
    "confirmed",
    false,
    "completed",
    "No event saved to Google Calendar",
  ],
  ["outlook", "cancelled", true, "completed", "Cancelled in Outlook"],
] as const)(
  "renders %s %s reservation with event evidence %s and calendar state %s as %s",
  async (
    calendarProvider,
    status,
    calendarEventIdPresent,
    calendarStatus,
    expectedLabel,
  ) => {
    const reservation = {
      id: "reservation-calendar-state",
      serviceId: "consult",
      professionalId: "professional-1",
      serviceName: "Consultation",
      professionalName: "Ari",
      startsAt: "2026-10-05T14:00:00Z",
      endsAt: "2026-10-05T14:30:00Z",
      customerName: "Casey Customer",
      customerEmail: "casey@example.test",
      status,
      version: 1,
      deliveryStatus: "sent",
      calendarProvider,
      calendarEventIdPresent,
      calendarStatus,
    };
    const apiClient = {
      get: vi
        .fn()
        .mockResolvedValueOnce({
          data: {
            settings,
            candidates: [],
            canManage: true,
            principalId: "principal-1",
            publicUrl: null,
            calendar: { provider: null, status: "not_connected" },
          },
        })
        .mockResolvedValueOnce({ data: [reservation] }),
      put: vi.fn(),
      post: vi.fn(),
    };
    mount(apiClient);
    await screen.findByRole("heading", { name: "Appointments" });
    fireEvent.click(screen.getByRole("button", { name: "Reservations" }));

    expect(await screen.findByText(expectedLabel)).toBeInTheDocument();
    if (status === "cancelled")
      expect(
        screen.queryByText(/Saved in (Google Calendar|Outlook)/),
      ).not.toBeInTheDocument();
  },
);

it("refreshes reservation conference state for the current tenant", async () => {
  const bootstrap = {
    settings,
    candidates: [],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const reservation = {
    id: "reservation-2",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 1,
    deliveryStatus: "sent",
    calendarStatus: "created",
    conference: { provider: "google_meet", joinUrl: null, status: "pending" },
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ data: bootstrap })
      .mockResolvedValueOnce({ data: [reservation] })
      .mockResolvedValueOnce({
        data: [
          {
            ...reservation,
            conference: {
              provider: "google_meet",
              joinUrl: "https://meet.google.com/abc-defg-hij",
              status: "ready",
            },
          },
        ],
      }),
    put: vi.fn(),
    post: vi.fn(),
  };
  mount(apiClient, 42);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  expect(
    await screen.findByText(/link is being prepared/i),
  ).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("link", { name: "Join Google Meet" }),
  ).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  expect(apiClient.get.mock.calls[2][0]).toMatch(
    /^\/v1\/tenants\/42\/booking\/reservations\?from=/,
  );
});

it("generates a video link for a confirmed reservation with an eligible calendar", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const reservation = {
    id: "reservation-3",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 2,
    deliveryStatus: "sent",
    calendarStatus: "completed",
    canGenerateConference: true,
    conference: null,
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ data: bootstrap })
      .mockResolvedValueOnce({ data: [reservation] }),
    put: vi.fn(),
    post: vi.fn().mockResolvedValue({
      data: {
        ...reservation,
        calendarStatus: "pending",
        conference: {
          provider: "google_meet",
          joinUrl: null,
          status: "pending",
        },
      },
    }),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Generate video link" }),
  );
  expect(await screen.findAllByText(/link is being prepared/i)).toHaveLength(2);
  expect(apiClient.post).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/reservations/reservation-3/conference",
    { version: 2 },
  );
});

it("explains why video-link generation is disabled without an eligible calendar", async () => {
  const reservation = {
    id: "reservation-4",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 1,
    deliveryStatus: "sent",
    calendarStatus: "not_requested",
    canGenerateConference: false,
    conference: null,
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          settings,
          candidates: [],
          canManage: true,
          principalId: "principal-1",
          publicUrl: null,
          calendar: { provider: null, status: "not_connected" },
        },
      })
      .mockResolvedValueOnce({ data: [reservation] }),
    put: vi.fn(),
    post: vi.fn(),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  expect(
    await screen.findByText(
      /connect an eligible Google Calendar or Outlook calendar/i,
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Generate video link" }),
  ).toBeDisabled();
  expect(apiClient.post).not.toHaveBeenCalled();
});

it("edits multiple weekly periods with time controls and saves each interval", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: false,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const apiClient = {
    get: vi.fn().mockResolvedValue({ data: bootstrap }),
    put: vi.fn().mockResolvedValue({
      data: {
        ...bootstrap,
        settings: {
          ...settings,
          version: 4,
          professionals: [
            {
              ...settings.professionals[0],
              weekly: [
                { day: 1, start: "09:00", end: "12:00" },
                { day: 1, start: "13:00", end: "14:00" },
              ],
            },
          ],
        },
      },
    }),
    post: vi.fn(),
  };
  mount(apiClient);
  await screen.findByText("Your availability");
  fireEvent.click(screen.getAllByRole("button", { name: "Availability" })[0]);
  await screen.findByLabelText("Monday start");
  fireEvent.click(screen.getAllByRole("button", { name: "Add period" })[0]);
  fireEvent.change(screen.getByLabelText("Monday start 2"), {
    target: { value: "13:00" },
  });
  fireEvent.change(screen.getByLabelText("Monday end 2"), {
    target: { value: "14:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/availability",
    expect.objectContaining({
      version: 3,
      weekly: [
        { day: 1, start: "09:00", end: "12:00" },
        { day: 1, start: "13:00", end: "14:00" },
      ],
    }),
  );
});

function managementClient() {
  const bootstrap = {
    settings: structuredClone(settings),
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  return {
    get: vi.fn().mockResolvedValue({ data: bootstrap }),
    put: vi.fn().mockImplementation(async (_path, value) => ({
      data: { ...bootstrap, settings: { ...value, version: 4 } },
    })),
  };
}

it("blocks overlapping weekly availability and preserves the hours for correction", async () => {
  const apiClient = managementClient();
  mount(apiClient, 42, "/bookings?tab=availability");
  await screen.findByLabelText("Monday start");
  fireEvent.click(screen.getAllByRole("button", { name: "Add period" })[0]);
  fireEvent.change(screen.getByLabelText("Monday start 2"), {
    target: { value: "11:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "non-overlapping periods",
  );
  expect(apiClient.put).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Monday start 2")).toHaveValue("11:00");
  fireEvent.change(screen.getByLabelText("Monday start 2"), {
    target: { value: "12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenCalledOnce();
});

it("identifies an invalid exception date and allows correction without reloading", async () => {
  const apiClient = managementClient();
  mount(apiClient, 42, "/bookings?tab=availability");
  fireEvent.change(await screen.findByLabelText("Exception date"), {
    target: { value: "2026-11-26" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  const exception = screen.getByText("2026-11-26").parentElement!;
  fireEvent.click(
    within(exception).getByRole("button", { name: "Add period" }),
  );
  fireEvent.change(screen.getByLabelText("2026-11-26 End 1"), {
    target: { value: "08:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("2026-11-26");
  expect(apiClient.put).not.toHaveBeenCalled();
  expect(screen.getByLabelText("2026-11-26 End 1")).toHaveValue("08:00");
  fireEvent.change(screen.getByLabelText("2026-11-26 End 1"), {
    target: { value: "12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenCalledOnce();
});

it("preserves an incomplete exception period and closes the date only when explicitly removed", async () => {
  const apiClient = managementClient();
  mount(apiClient, 42, "/bookings?tab=availability");
  fireEvent.change(await screen.findByLabelText("Exception date"), {
    target: { value: "2026-11-26" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  const header = screen.getByText("2026-11-26").parentElement!;
  fireEvent.click(within(header).getByRole("button", { name: "Add period" }));
  fireEvent.change(screen.getByLabelText("2026-11-26 Start 1"), {
    target: { value: "" },
  });
  expect(screen.getByLabelText("2026-11-26 End 1")).toHaveValue("17:00");
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("2026-11-26");
  expect(apiClient.put).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("2026-11-26 Start 1"), {
    target: { value: "10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenLastCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      professionals: [
        expect.objectContaining({
          exceptions: [
            { date: "2026-11-26", periods: [{ start: "10:00", end: "17:00" }] },
          ],
        }),
      ],
    }),
  );

  const exceptions = screen.getByRole("group", { name: "Exceptions" });
  fireEvent.click(
    within(exceptions).getByRole("button", { name: "Remove period" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenLastCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      professionals: [
        expect.objectContaining({
          exceptions: [{ date: "2026-11-26", periods: [] }],
        }),
      ],
    }),
  );
});

it("shows an API rejection reason without clearing the availability draft", async () => {
  const apiClient = managementClient();
  apiClient.put.mockRejectedValueOnce(
    new ApiClientError(
      422,
      "INVALID_AVAILABILITY",
      "Use one exception per date.",
    ),
  );
  mount(apiClient, 42, "/bookings?tab=availability");
  fireEvent.change(await screen.findByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("HTTP 422");
  expect(alert).toHaveTextContent("Use one exception per date.");
  expect(screen.getByLabelText("Monday start")).toHaveValue("10:00");
});

it("saves availability without publishing an unrelated settings draft", async () => {
  const apiClient = managementClient();
  mount(apiClient);
  fireEvent.change(await screen.findByLabelText("Public title"), {
    target: { value: "Draft public title" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Hours" }));
  const monday = screen.getByLabelText("Monday start");
  fireEvent.change(monday, { target: { value: "10:00" } });
  fireEvent.change(monday, { target: { value: "09:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  fireEvent.change(await screen.findByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  const weekly = [{ day: 1, start: "10:00", end: "12:00" }];
  expect(apiClient.put).toHaveBeenNthCalledWith(
    1,
    "/v1/tenants/42/booking",
    expect.objectContaining({
      title: settings.title,
      version: 3,
      professionals: [expect.objectContaining({ weekly })],
    }),
  );

  fireEvent.click(screen.getByRole("button", { name: "Booking settings" }));
  expect(await screen.findByLabelText("Public title")).toHaveValue(
    "Draft public title",
  );
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText("Booking settings saved.");
  expect(apiClient.put).toHaveBeenNthCalledWith(
    2,
    "/v1/tenants/42/booking",
    expect.objectContaining({
      title: "Draft public title",
      version: 4,
      professionals: [expect.objectContaining({ weekly })],
    }),
  );
});

it.each(["settings", "availability"] as const)(
  "preserves weekday edits in %s when the other editor saves a different day",
  async (draftEditor) => {
    const apiClient = managementClient();
    const initial = await apiClient.get();
    initial.data.settings.professionals[0].weekly.push({
      day: 2,
      start: "09:00",
      end: "12:00",
    });
    mount(apiClient);
    await screen.findByLabelText("Public title");

    const otherEditor =
      draftEditor === "settings" ? "availability" : "settings";
    const openEditor = (editor: typeof draftEditor) => {
      fireEvent.click(
        screen.getByRole("button", {
          name: editor === "settings" ? "Booking settings" : "Availability",
        }),
      );
      if (editor === "settings")
        fireEvent.click(screen.getByRole("button", { name: "Hours" }));
    };
    const save = async (editor: typeof draftEditor) => {
      fireEvent.click(screen.getByRole("button", { name: `Save ${editor}` }));
      await screen.findByText(
        editor === "settings"
          ? "Booking settings saved."
          : "Availability saved.",
      );
    };

    openEditor(draftEditor);
    fireEvent.change(screen.getByLabelText("Monday start"), {
      target: { value: "10:00" },
    });
    openEditor(otherEditor);
    fireEvent.change(screen.getByLabelText("Tuesday Start"), {
      target: { value: "11:00" },
    });
    await save(otherEditor);

    openEditor(draftEditor);
    expect(screen.getByLabelText("Monday start")).toHaveValue("10:00");
    expect(screen.getByLabelText("Tuesday Start")).toHaveValue("11:00");
    await save(draftEditor);
    expect(apiClient.put).toHaveBeenLastCalledWith(
      "/v1/tenants/42/booking",
      expect.objectContaining({
        version: 4,
        professionals: [
          expect.objectContaining({
            weekly: expect.arrayContaining([
              { day: 1, start: "10:00", end: "12:00" },
              { day: 2, start: "11:00", end: "12:00" },
            ]),
          }),
        ],
      }),
    );
  },
);

it("retains a separate availability draft while unrelated booking settings are saved", async () => {
  const apiClient = managementClient();
  let finishSave!: () => void;
  const pending = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const originalSave = apiClient.put.getMockImplementation()!;
  apiClient.put.mockImplementationOnce(async (path, value) => {
    await pending;
    return structuredClone(await originalSave(path, value));
  });
  mount(apiClient);
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  fireEvent.change(await screen.findByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  fireEvent.change(screen.getByLabelText("Exception date"), {
    target: { value: "2026-11-26" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  fireEvent.click(screen.getByRole("button", { name: "Booking settings" }));
  fireEvent.change(screen.getByLabelText("Public title"), {
    target: { value: "Renamed agenda" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Availability" }));

  expect(screen.getByLabelText("Monday start")).toBeDisabled();
  expect(screen.getByLabelText("Exception date")).toBeDisabled();
  expect(screen.getByLabelText("Professional")).toBeDisabled();
  await act(async () => finishSave());
  await screen.findByText("Booking settings saved.");
  expect(screen.getByLabelText("Monday start")).toHaveValue("10:00");
  expect(screen.getByText("2026-11-26")).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenLastCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      version: 4,
      title: "Renamed agenda",
      professionals: [
        expect.objectContaining({
          weekly: [{ day: 1, start: "10:00", end: "12:00" }],
          exceptions: [{ date: "2026-11-26", periods: [] }],
        }),
      ],
    }),
  );
});

it("keeps edited and removed exception dates when the saved schedule changes", async () => {
  const apiClient = managementClient();
  const { data } = await apiClient.get();
  data.settings.professionals[0].exceptions = [
    { date: "2026-11-25", periods: [{ start: "10:00", end: "12:00" }] },
    { date: "2026-11-26", periods: [] },
  ];
  const refreshed = structuredClone(data);
  refreshed.settings.version = 4;
  refreshed.settings.professionals[0].exceptions.push({
    date: "2026-11-28",
    periods: [{ start: "08:00", end: "09:00" }],
  });
  apiClient.put.mockResolvedValueOnce({
    data: { ...refreshed, agenda: { enabled: true, sourceCount: 1 } },
  });
  mount(apiClient, 42, "/bookings?tab=availability");

  fireEvent.change(await screen.findByLabelText("2026-11-25 Start 1"), {
    target: { value: "11:00" },
  });
  fireEvent.click(
    within(screen.getByText("2026-11-26").parentElement!).getByRole("button", {
      name: "Remove exception",
    }),
  );
  fireEvent.change(screen.getByLabelText("Exception date"), {
    target: { value: "2026-11-27" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Use My Day to block busy times" }),
  );
  await screen.findByText("My Day access is enabled. Calendar sources: 1.");

  expect(screen.getByLabelText("2026-11-25 Start 1")).toHaveValue("11:00");
  expect(screen.queryByText("2026-11-26")).toBeNull();
  expect(screen.getByText("2026-11-27")).toBeVisible();
  expect(screen.getByLabelText("2026-11-28 Start 1")).toHaveValue("08:00");
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenLastCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      version: 4,
      professionals: [
        expect.objectContaining({
          exceptions: [
            { date: "2026-11-25", periods: [{ start: "11:00", end: "12:00" }] },
            { date: "2026-11-27", periods: [] },
            { date: "2026-11-28", periods: [{ start: "08:00", end: "09:00" }] },
          ],
        }),
      ],
    }),
  );
});

it("keeps each professional's hours and exceptions separate when switching and saving", async () => {
  const apiClient = managementClient();
  const { data } = await apiClient.get();
  data.settings.professionals.push({
    id: "professional-2",
    principalId: "principal-2",
    enabled: true,
    weekly: [{ day: 1, start: "08:00", end: "12:00" }],
    exceptions: [],
  });
  data.candidates.push({ principalId: "principal-2", displayName: "Bea" });
  mount(apiClient, 42, "/bookings?tab=availability");

  fireEvent.change(await screen.findByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  fireEvent.change(screen.getByLabelText("Exception date"), {
    target: { value: "2026-11-26" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add exception" }));
  fireEvent.change(screen.getByLabelText("Exception date"), {
    target: { value: "2026-11-27" },
  });

  fireEvent.change(screen.getByLabelText("Professional"), {
    target: { value: "professional-2" },
  });
  expect(screen.getByLabelText("Monday start")).toHaveValue("08:00");
  expect(screen.getByLabelText("Exception date")).toHaveValue("");
  expect(screen.queryByText("2026-11-26")).toBeNull();
  fireEvent.change(screen.getByLabelText("Monday start"), {
    target: { value: "11:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenLastCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      professionals: [
        expect.objectContaining({
          weekly: settings.professionals[0].weekly,
          exceptions: [],
        }),
        expect.objectContaining({
          weekly: [{ day: 1, start: "11:00", end: "12:00" }],
          exceptions: [],
        }),
      ],
    }),
  );

  fireEvent.change(screen.getByLabelText("Professional"), {
    target: { value: settings.professionals[0].id },
  });
  expect(screen.getByLabelText("Monday start")).toHaveValue("10:00");
  expect(screen.getByLabelText("Exception date")).toHaveValue("2026-11-27");
  expect(screen.getByText("2026-11-26")).toBeVisible();
  expect(screen.queryByText("Availability saved.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await screen.findByText("Availability saved.");
  expect(apiClient.put).toHaveBeenLastCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      professionals: [
        expect.objectContaining({
          weekly: [{ day: 1, start: "10:00", end: "12:00" }],
          exceptions: [{ date: "2026-11-26", periods: [] }],
        }),
        expect.objectContaining({
          weekly: [{ day: 1, start: "11:00", end: "12:00" }],
          exceptions: [],
        }),
      ],
    }),
  );
});

it("guides configuration through steps and keeps edits when going back", async () => {
  mount(managementClient());
  await screen.findByLabelText("Public title");
  expect(screen.queryByLabelText("Service name")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Public title"), {
    target: { value: "New agenda" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByLabelText("Professional")).toHaveValue("principal-1");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByLabelText("Public title")).toHaveValue("New agenda");
});

it("removes a service from the saved configuration", async () => {
  const apiClient = managementClient();
  mount(apiClient);
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Services" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove service Consultation" }),
  );
  expect(screen.queryByLabelText("Service name")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Booking settings saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({ services: [], published: false }),
  );
});

it("removes a professional and cleans service assignments", async () => {
  const apiClient = managementClient();
  mount(apiClient);
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Team" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove professional Ari" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Booking settings saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      professionals: [],
      services: [expect.objectContaining({ professionalIds: [] })],
    }),
  );
});

it("edits weekly availability inside the setup wizard", async () => {
  const apiClient = managementClient();
  mount(apiClient);
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Hours" }));
  fireEvent.change(screen.getByLabelText("Monday start"), {
    target: { value: "10:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await screen.findByText("Booking settings saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({
      professionals: [
        expect.objectContaining({
          weekly: [{ day: 1, start: "10:00", end: "12:00" }],
        }),
      ],
    }),
  );
});

it("blocks saving overlapping weekly periods and opens the hours step", async () => {
  const apiClient = managementClient();
  const data = await apiClient.get();
  data.data.settings.professionals[0].weekly.push({
    day: 1,
    start: "11:00",
    end: "14:00",
  });
  mount(apiClient);
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "non-overlapping periods",
  );
  expect(screen.getByRole("heading", { name: "Hours" })).toBeInTheDocument();
  expect(apiClient.put).not.toHaveBeenCalled();
});

it("saves deleting the last published service as an unpublished draft", async () => {
  const apiClient = managementClient();
  const data = await apiClient.get();
  data.data.settings.published = true;
  mount(apiClient);
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Services" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove service Consultation" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await screen.findByText("Booking settings saved.");
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking",
    expect.objectContaining({ published: false, services: [] }),
  );
});

it("restores a removed service when discarding unsaved changes", async () => {
  mount(managementClient());
  await screen.findByLabelText("Public title");
  fireEvent.click(screen.getByRole("button", { name: "Services" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove service Consultation" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByLabelText("Service name")).toHaveValue("Consultation");
});

it("uses the saved time zone for reservations when settings have an unsaved time zone", async () => {
  const apiClient = {
    get: vi.fn(async (path: string) => ({
      data: path.includes("/reservations?")
        ? []
        : {
            settings: { ...settings, timeZone: "America/New_York" },
            candidates: [],
            canManage: true,
            publicUrl: null,
          },
    })),
  };
  mount(apiClient, 42, "/bookings?date=2025-03-09");
  const timeZone = await screen.findByLabelText("IANA time zone");
  fireEvent.change(timeZone, { target: { value: "UTC" } });
  expect(timeZone).toHaveValue("UTC");
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));

  await screen.findByText("No reservations in this period.");
  const path = apiClient.get.mock.calls.find(([path]) =>
    path.includes("/reservations?"),
  )![0];
  const query = new URL(path, "https://example.test").searchParams;
  expect(query.get("from")).toBe("2025-03-09T05:00:00.000Z");
  expect(query.get("to")).toBe("2025-03-10T04:00:00.000Z");
});

it("opens authenticated reservations for the appointment date from My Day", async () => {
  const apiClient = {
    get: vi.fn(async (path: string) => ({
      data: path.includes("/reservations?")
        ? []
        : {
            settings: { ...settings, timeZone: "America/New_York" },
            candidates: [],
            canManage: true,
            principalId: "principal-1",
            publicUrl: null,
            calendar: { provider: null, status: "not_connected" },
          },
    })),
  };
  mount(apiClient, 42, "/bookings?tab=reservations&date=2025-03-09");
  await screen.findByText("No reservations in this period.");
  await waitFor(() =>
    expect(apiClient.get).toHaveBeenCalledWith(
      expect.stringContaining("/reservations?"),
      { signal: expect.any(AbortSignal) },
    ),
  );
  expect(screen.getByRole("button", { name: "Reservations" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  const path = apiClient.get.mock.calls.find(([path]) =>
    path.includes("/reservations?"),
  )![0];
  const query = new URL(path, "https://example.test").searchParams;
  expect(query.get("from")).toBe("2025-03-09T05:00:00.000Z");
  expect(query.get("to")).toBe("2025-03-10T04:00:00.000Z");
  expect(screen.getByText("Reservations for March 9, 2025")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Show upcoming reservations" }),
  );
  await waitFor(() =>
    expect(
      apiClient.get.mock.calls.filter(([path]) =>
        path.includes("/reservations?"),
      ).length,
    ).toBe(2),
  );
  expect(
    screen.queryByText("Reservations for March 9, 2025"),
  ).not.toBeInTheDocument();
});

it("keeps the selected tab in the URL and restores the date when navigating back", async () => {
  const apiClient = {
    get: vi.fn(async (path: string) => ({
      data: path.includes("/reservations?")
        ? []
        : { settings, candidates: [], canManage: true, publicUrl: null },
    })),
  };
  function Navigation() {
    const location = useLocation();
    const navigate = useNavigate();
    return (
      <>
        <div data-testid="booking-search">{location.search}</div>
        <button type="button" onClick={() => navigate(-1)}>
          Go back
        </button>
      </>
    );
  }
  mount(
    apiClient,
    42,
    "/bookings?tab=reservations&date=2025-03-09",
    <Navigation />,
  );
  expect(
    await screen.findByText("Reservations for March 9, 2025"),
  ).toBeVisible();

  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  expect(screen.getByTestId("booking-search")).toHaveTextContent(
    "?tab=availability&date=2025-03-09",
  );
  expect(screen.getByRole("button", { name: "Availability" })).toHaveAttribute(
    "aria-current",
    "page",
  );

  fireEvent.click(screen.getByRole("button", { name: "Go back" }));
  expect(screen.getByRole("button", { name: "Reservations" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(
    await screen.findByText("Reservations for March 9, 2025"),
  ).toBeVisible();
  expect(
    apiClient.get.mock.calls.filter(
      ([path]) => path === "/v1/tenants/42/booking",
    ),
  ).toHaveLength(1);
});

it("cancels a pending reservations request when leaving the tab", async () => {
  let finish!: (value: { data: [] }) => void;
  const pending = new Promise<{ data: [] }>((resolve) => {
    finish = resolve;
  });
  const apiClient = {
    get: vi.fn(async (path: string, _init?: RequestInit) =>
      path.includes("/reservations?")
        ? pending
        : {
            data: {
              settings,
              candidates: [],
              canManage: true,
              publicUrl: null,
            },
          },
    ),
  };
  mount(apiClient, 42, "/bookings?tab=reservations");
  await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(2));
  const signal = apiClient.get.mock.calls[1][1]?.signal;
  expect(signal?.aborted).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => finish({ data: [] }));
  expect(
    screen.queryByText("No reservations in this period."),
  ).not.toBeInTheDocument();
});

it("never shows the previous date's reservations or cursor under a new date", async () => {
  const first = {
    id: "reservation-1",
    version: 1,
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2025-03-09T12:00:00.000Z",
    endsAt: "2025-03-09T12:30:00.000Z",
    customerName: "First customer",
    customerEmail: "first@example.test",
    status: "cancelled",
    deliveryStatus: "skipped",
    calendarStatus: "not_connected",
  };
  let nextDateAttempts = 0;
  const apiClient = {
    get: vi.fn(async (path: string) => {
      if (!path.includes("/reservations?"))
        return {
          data: { settings, candidates: [], canManage: true, publicUrl: null },
        };
      const from = new URL(path, "https://example.test").searchParams.get(
        "from",
      );
      if (!from?.startsWith("2025-03-10"))
        return { data: [first], nextCursor: "first-date-page-2" };
      if (nextDateAttempts++ === 0) throw new Error("Temporary failure");
      return {
        data: [
          {
            ...first,
            id: "reservation-2",
            startsAt: "2025-03-10T12:00:00.000Z",
            endsAt: "2025-03-10T12:30:00.000Z",
            customerName: "Second customer",
          },
        ],
      };
    }),
  };
  const firstCommit = vi.fn();
  function Navigation() {
    const { search } = useLocation();
    const navigate = useNavigate();
    useLayoutEffect(() => {
      if (new URLSearchParams(search).get("date") === "2025-03-10")
        firstCommit(
          screen.queryByText("First customer"),
          screen.queryByRole("button", { name: "Load more reservations" }),
        );
    }, [search]);
    return (
      <button
        type="button"
        onClick={() => navigate("/bookings?tab=reservations&date=2025-03-10")}
      >
        Next date
      </button>
    );
  }
  mount(
    apiClient,
    42,
    "/bookings?tab=reservations&date=2025-03-09",
    <Navigation />,
  );
  expect(await screen.findByText("First customer")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next date" }));

  expect(firstCommit).toHaveBeenCalledWith(null, null);
  expect(
    await screen.findByText("Reservations could not be loaded."),
  ).toBeVisible();
  expect(screen.queryByText("First customer")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("Second customer")).toBeVisible();
});

it("loads additional reservations without changing the original date range", async () => {
  let pageAttempts = 0;
  const reservation = {
    id: "reservation-1",
    version: 8,
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2025-03-09T12:00:00.000Z",
    endsAt: "2025-03-09T12:30:00.000Z",
    customerName: "First customer",
    customerEmail: "first@example.test",
    status: "cancelled",
    deliveryStatus: "skipped",
    calendarStatus: "not_connected",
  };
  const apiClient = {
    get: vi.fn(async (path: string) => {
      if (!path.includes("/reservations?"))
        return {
          data: { settings, candidates: [], canManage: true, publicUrl: null },
        };
      const query = new URL(path, "https://example.test").searchParams;
      if (query.has("cursor") && pageAttempts++ === 0)
        throw new Error("Temporary page failure");
      return query.has("cursor")
        ? {
            data: [
              {
                ...reservation,
                version: 7,
                customerName: "Stale first customer",
                status: "confirmed",
              },
              {
                ...reservation,
                id: "reservation-2",
                customerName: "Second customer",
              },
            ],
          }
        : { data: [reservation], nextCursor: "page-2" };
    }),
  };
  mount(apiClient, 42, "/bookings?tab=reservations&date=2025-03-09");
  expect(await screen.findByText("First customer")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Load more reservations" }),
  );
  expect(
    await screen.findByText("More reservations could not be loaded."),
  ).toBeVisible();
  expect(screen.getByText("First customer")).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "Load more reservations" }),
  );
  expect(await screen.findByText("Second customer")).toBeVisible();
  expect(screen.getByText("First customer")).toBeVisible();
  expect(screen.queryByText("Stale first customer")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Load more reservations" }),
  ).not.toBeInTheDocument();
  const [first, failed, second] = apiClient.get.mock.calls
    .map(([path]) => path)
    .filter((path) => path.includes("/reservations?"))
    .map((path) => new URL(path, "https://example.test").searchParams);
  expect(second.get("cursor")).toBe("page-2");
  expect(failed.toString()).toBe(second.toString());
  second.delete("cursor");
  expect(second.toString()).toBe(first.toString());
});

it("ignores an invalid appointment date without sending an invalid range", async () => {
  const apiClient = {
    get: vi.fn(async (path: string) => ({
      data: path.includes("/reservations?")
        ? []
        : {
            settings,
            candidates: [],
            canManage: true,
            principalId: "principal-1",
            publicUrl: null,
            calendar: { provider: null, status: "not_connected" },
          },
    })),
  };
  mount(apiClient, 42, "/bookings?tab=reservations&date=2025-02-30");
  await screen.findByText("No reservations in this period.");
  await waitFor(() =>
    expect(apiClient.get).toHaveBeenCalledWith(
      expect.stringContaining("/reservations?"),
      { signal: expect.any(AbortSignal) },
    ),
  );
  const path = apiClient.get.mock.calls.find(([path]) =>
    path.includes("/reservations?"),
  )![0];
  const query = new URL(path, "https://example.test").searchParams;
  expect(Number.isFinite(Date.parse(query.get("from")!))).toBe(true);
  expect(query.get("from")).not.toBe("2025-03-02T00:00:00.000Z");
});

it("uses the shared route loading layout while booking settings are fetched", () => {
  mount({ get: vi.fn(() => new Promise(() => {})), put: vi.fn() });
  expect(screen.getByRole("status")).toHaveTextContent(
    "Loading booking settings…",
  );
  expect(
    screen.getByRole("status").querySelector('[data-slot="skeleton"]'),
  ).toBeInTheDocument();
});

it("selects Zoom for an eligible reservation without using the calendar provider as the meeting provider", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const reservation = {
    id: "reservation-3",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 2,
    deliveryStatus: "sent",
    calendarStatus: "completed",
    canGenerateConference: true,
    availableConferenceProviders: ["auto", "zoom"],
    conference: null,
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ data: bootstrap })
      .mockResolvedValueOnce({ data: [reservation] }),
    put: vi.fn(),
    post: vi.fn().mockResolvedValue({
      data: {
        ...reservation,
        calendarStatus: "pending",
        conference: {
          provider: "zoom",
          joinUrl: null,
          status: "pending",
        },
      },
    }),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  fireEvent.change(await screen.findByLabelText("Video call platform"), {
    target: { value: "zoom" },
  });
  fireEvent.click(
    await screen.findByRole("button", { name: "Generate video link" }),
  );
  expect(await screen.findAllByText(/link is being prepared/i)).toHaveLength(2);
  expect(apiClient.post).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/reservations/reservation-3/conference",
    { version: 2, provider: "zoom" },
  );
});

it("grants the professional's Zoom account for new appointments", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: {
      provider: "google_calendar",
      status: "connected",
      conferenceProvider: "auto",
    },
  };
  const apiClient = {
    get: vi.fn().mockResolvedValue({ data: bootstrap }),
    put: vi.fn().mockResolvedValue({
      data: {
        ...bootstrap,
        calendar: { ...bootstrap.calendar, conferenceProvider: "zoom" },
      },
    }),
  };
  mount(apiClient);
  fireEvent.change(await screen.findByLabelText("Public title"), {
    target: { value: "Calendar settings draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Use Zoom for appointments" }),
  );
  expect(
    await screen.findByText("Zoom authorized for appointments"),
  ).toBeInTheDocument();
  expect(apiClient.put).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/calendar",
    { provider: "google_calendar", conferenceProvider: "zoom" },
  );
  fireEvent.click(screen.getByRole("button", { name: "Booking settings" }));
  expect(await screen.findByLabelText("Public title")).toHaveValue(
    "Calendar settings draft",
  );
});

it("offers Zoom when native calendar conferencing is unsupported", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const reservation = {
    id: "reservation-3",
    serviceId: "consult",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey Customer",
    customerEmail: "casey@example.test",
    status: "confirmed" as const,
    version: 2,
    deliveryStatus: "sent",
    calendarStatus: "completed",
    canGenerateConference: true,
    availableConferenceProviders: ["auto", "zoom"],
    conference: { provider: null, joinUrl: null, status: "unsupported" },
  };
  const apiClient = {
    get: vi
      .fn()
      .mockResolvedValueOnce({ data: bootstrap })
      .mockResolvedValueOnce({ data: [reservation] }),
    put: vi.fn(),
    post: vi.fn().mockResolvedValue({
      data: {
        ...reservation,
        calendarStatus: "pending",
        conference: {
          provider: "zoom",
          joinUrl: null,
          status: "pending",
        },
      },
    }),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Reservations" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Generate video link" }),
  );
  expect(await screen.findAllByText(/link is being prepared/i)).toHaveLength(2);
  expect(apiClient.post).toHaveBeenCalledWith(
    "/v1/tenants/42/booking/reservations/reservation-3/conference",
    { version: 2, provider: "zoom" },
  );
});

it("does not offer granting a disconnected Zoom account", async () => {
  const apiClient = {
    get: vi.fn().mockResolvedValue({
      data: {
        settings,
        candidates: [],
        canManage: true,
        principalId: "principal-1",
        publicUrl: null,
        calendar: {
          provider: "google_calendar",
          status: "connected",
          zoomStatus: "not_connected",
        },
      },
    }),
    put: vi.fn(),
  };
  mount(apiClient);
  await screen.findByRole("heading", { name: "Appointments" });
  fireEvent.click(screen.getByRole("button", { name: "Availability" }));
  expect(
    await screen.findByRole("button", { name: "Use Zoom for appointments" }),
  ).toBeDisabled();
});

it("saves Jitsi as the tenant default conference provider", async () => {
  const bootstrap = {
    settings,
    candidates: [{ principalId: "principal-1", displayName: "Ari" }],
    canManage: true,
    principalId: "principal-1",
    publicUrl: null,
    calendar: { provider: null, status: "not_connected" },
  };
  const apiClient = {
    get: vi.fn().mockResolvedValue({ data: bootstrap }),
    put: vi.fn().mockResolvedValue({
      data: {
        ...bootstrap,
        settings: { ...settings, conferenceProvider: "jitsi", version: 4 },
      },
    }),
  };
  mount(apiClient);
  const provider = await screen.findByLabelText("Video meeting provider");
  expect(provider).toHaveValue("automatic");
  fireEvent.change(provider, { target: { value: "jitsi" } });
  fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
  await waitFor(() =>
    expect(apiClient.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ conferenceProvider: "jitsi" }),
    ),
  );
});

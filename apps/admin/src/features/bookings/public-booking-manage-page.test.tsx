import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import { StoreContextProvider, memoryStore, useSetLocale } from "ra-core";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicBookingManagePage } from "./public-booking-manage-page";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
});

const manageToken = "manage-token-1234567890123456";
const managePath = `/api/public/bookings/manage/${manageToken}`;

function confirmedReservation(overrides: Record<string, unknown> = {}) {
  return {
    id: "reservation-1",
    serviceId: "service-1",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey",
    customerEmail: "casey@example.test",
    status: "confirmed",
    version: 7,
    deliveryStatus: "sent",
    calendarStatus: "not_configured",
    ...overrides,
  };
}

function manageData(
  reservation = confirmedReservation(),
  overrides: Record<string, unknown> = {},
) {
  return {
    reservation,
    publicUrl: "https://savia.test/public/bookings/page-token-1234567890123456",
    timeZone: "America/Bogota",
    cancellationMinutes: 120,
    horizonDays: 90,
    leadMinutes: 0,
    canReschedule: true,
    ...overrides,
  };
}

function availabilityData(startsAt = "2026-10-06T15:00:00Z") {
  return {
    displayTimeZone: "America/Bogota",
    businessTimeZone: "America/Bogota",
    days: [
      {
        date: "2026-10-06",
        slots: [
          {
            startsAt,
            endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
          },
        ],
      },
    ],
  };
}

function renderManagePage(token = manageToken, children?: ReactNode) {
  return render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        {children}
        <PublicBookingManagePage token={token} />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
}

it("recovers from an initial connection error on the same management link", async () => {
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Network request failed"))
    .mockResolvedValueOnce(Response.json({ data: manageData() }));
  vi.stubGlobal("fetch", fetcher);

  renderManagePage();
  expect(await screen.findByRole("alert")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(
    await screen.findByRole("button", { name: "Reschedule" }),
  ).toBeEnabled();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    managePath,
    managePath,
  ]);
});

it("suspends manual retries when the management link opens during a rate limit", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": new Date(Date.now() + 30_000).toUTCString() },
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: manageData() }));
  vi.stubGlobal("fetch", fetcher);

  await act(async () => {
    renderManagePage();
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Too many booking requests. Try again after",
  );
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toBeDisabled();
  act(() => vi.advanceTimersByTime(29_999));
  fireEvent.click(retry);
  expect(fetcher).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1));
  expect(retry).toBeEnabled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(retry);
  });
  expect(screen.getByRole("button", { name: "Reschedule" })).toBeEnabled();
  expect(fetcher.mock.calls.map(([path]) => path)).toEqual([
    managePath,
    managePath,
  ]);
});

it.each([
  { status: 404, cancelled: false },
  { status: 409, cancelled: true },
])(
  "refreshes the appointment when rescheduling availability returns $status",
  async ({ status, cancelled }) => {
    let reads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === `${managePath}/availability`)
        return new Response(null, { status });
      if (path !== managePath) throw new Error(`Unexpected path ${path}`);
      const data =
        ++reads === 1
          ? manageData()
          : manageData(
              confirmedReservation({
                version: 8,
                status: cancelled ? "cancelled" : "confirmed",
              }),
              { canReschedule: false },
            );
      return Response.json({ data });
    });
    vi.stubGlobal("fetch", fetcher);

    renderManagePage();
    fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
    await screen.findByText(
      cancelled
        ? "Cancelled"
        : "To change this appointment, contact the booking business.",
    );
    expect(reads).toBe(2);
    expect(
      screen.queryByRole("heading", { name: "Choose a new time" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    if (!cancelled)
      expect(
        screen.getByRole("button", { name: "Cancel reservation" }),
      ).toBeEnabled();
  },
);

it("distinguishes the existing and replacement appointments in a repeated local hour", async () => {
  vi.setSystemTime(new Date("2026-11-01T04:05:00Z"));
  const reservation = confirmedReservation({
    startsAt: "2026-11-01T05:30:00Z",
    endsAt: "2026-11-01T06:00:00Z",
  });
  const timeZone = "America/New_York";
  const data = manageData(reservation, { timeZone, cancellationMinutes: 30 });
  const availability = {
    displayTimeZone: timeZone,
    businessTimeZone: "America/Bogota",
    days: [
      {
        date: "2026-11-01",
        slots: [
          {
            startsAt: "2026-11-01T06:30:00Z",
            endsAt: "2026-11-01T07:00:00Z",
          },
        ],
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        data: String(input).includes("/availability?") ? availability : data,
      }),
    ),
  );

  renderManagePage();
  fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
  fireEvent.click(await screen.findByRole("button", { name: "1:30 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(screen.getByText(/Current appointment:.*1:30 AM EDT/)).toBeVisible();
  expect(screen.getByText(/1:30 AM EST/)).toBeVisible();
});

it("offers the first replacement day and excludes the current instant across offset formats", async () => {
  const reservation = confirmedReservation({
    startsAt: "2026-10-05T09:00:00-05:00",
  });
  const availability = availabilityData();
  availability.days.unshift({
    date: "2026-10-05",
    slots: [
      { startsAt: "2026-10-05T14:00:00Z", endsAt: "2026-10-05T14:30:00Z" },
    ],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json({
        data: String(input).includes("/availability?")
          ? availability
          : manageData(reservation),
      }),
    ),
  );
  renderManagePage();
  fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
  expect(await screen.findByRole("button", { name: "10:00 AM" })).toBeEnabled();
  expect(
    screen.getByRole("button", { name: /Monday, October 5/ }),
  ).toBeDisabled();
  expect(screen.queryByRole("button", { name: "9:00 AM" })).toBeNull();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
});

it("preserves the selected reschedule time when the language changes", async () => {
  function SwitchLanguage() {
    const setLocale = useSetLocale();
    return <button onClick={() => setLocale("es")}>Spanish</button>;
  }
  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path.endsWith("/availability"))
        return Response.json({ data: availabilityData() });
      if (path.endsWith("/reschedule")) {
        const { startsAt, version } = JSON.parse(String(init?.body));
        expect(startsAt).toBe("2026-10-06T15:00:00Z");
        expect(version).toBe(7);
        return Response.json({
          data: confirmedReservation({
            startsAt,
            endsAt: "2026-10-06T15:30:00Z",
            version: 8,
          }),
        });
      }
      return Response.json({ data: manageData() });
    },
  );
  vi.stubGlobal("fetch", fetcher);
  renderManagePage(manageToken, <SwitchLanguage />);
  fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
  fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Review your change" });
  fireEvent.click(screen.getByRole("button", { name: "Spanish" }));

  expect(
    await screen.findByRole("heading", { name: "Revisa el cambio" }),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Confirmar el cambio" }));
  expect(await screen.findByText("Tu cita se actualizó.")).toBeVisible();
  expect(
    fetcher.mock.calls.filter(([path]) => path === managePath),
  ).toHaveLength(1);
  expect(
    fetcher.mock.calls.some(([path]) => String(path).endsWith("/reschedule")),
  ).toBe(true);
});

it("keeps an in-flight cancellation scoped to the original management link", async () => {
  const nextToken = "other-management-token-1234567890";
  let finish!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path.endsWith("/cancel")) return pending;
      return Response.json({
        data: manageData(
          path.endsWith(nextToken)
            ? confirmedReservation({
                id: "reservation-2",
                customerName: "Another guest",
                customerEmail: "another@example.test",
              })
            : confirmedReservation(),
        ),
      });
    }),
  );
  const { rerender } = renderManagePage();
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel reservation" }),
  );

  rerender(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingManagePage token={nextToken} />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  expect(
    await screen.findByText("Another guest · another@example.test"),
  ).toBeVisible();
  await act(async () =>
    finish(
      Response.json({
        data: confirmedReservation({ status: "cancelled", version: 8 }),
      }),
    ),
  );
  expect(
    screen.getByText("Another guest · another@example.test"),
  ).toBeVisible();
  expect(screen.getByText("Confirmed")).toBeVisible();
});

it("hides the previous reservation when its public management link is revoked", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === `/api/public/bookings/manage/${manageToken}`)
        return Response.json({ data: manageData() });
      return Response.json(
        { error: { message: "This link has expired." } },
        { status: 410 },
      );
    }),
  );

  const page = renderManagePage();
  expect(
    await screen.findByRole("heading", {
      name: "Manage or cancel this appointment",
    }),
  ).toBeInTheDocument();
  page.rerender(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingManagePage token="revoked-manage-token-123456789" />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );

  expect(await screen.findByRole("alert")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(
    screen.queryByRole("heading", {
      name: "Manage or cancel this appointment",
    }),
  ).not.toBeInTheDocument();
});

it("uses private inline availability, requires review, and keeps the reservation revision", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const reservation = {
    id: "reservation-1",
    serviceId: "service-1",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey",
    customerEmail: "casey@example.test",
    status: "confirmed",
    version: 7,
    deliveryStatus: "sent",
    calendarStatus: "not_configured",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      calls.push({
        path:
          new URL(String(input), "https://savia.test").pathname +
          new URL(String(input), "https://savia.test").search,
        init,
      });
      if (path === "/api/public/bookings/manage/manage-token-1234567890123456")
        return Response.json({
          data: {
            reservation,
            publicUrl:
              "https://savia.test/public/bookings/page-token-1234567890123456",
            timeZone: "America/Bogota",
            cancellationMinutes: 120,
            horizonDays: 90,
            leadMinutes: 0,
            canReschedule: true,
          },
        });
      if (
        path ===
        "/api/public/bookings/manage/manage-token-1234567890123456/availability"
      )
        return Response.json({
          data: {
            displayTimeZone: "America/Bogota",
            businessTimeZone: "America/Bogota",
            days: [
              {
                date: "2026-10-06",
                slots: [
                  {
                    startsAt: "2026-10-06T15:00:00Z",
                    endsAt: "2026-10-06T15:30:00Z",
                  },
                ],
              },
            ],
          },
        });
      if (path.endsWith("/reschedule"))
        return Response.json({
          data: {
            ...reservation,
            startsAt: "2026-10-06T15:00:00Z",
            endsAt: "2026-10-06T15:30:00Z",
            version: 8,
          },
        });
      throw new Error(`Unexpected public path ${path}`);
    }),
  );
  render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingManagePage token="manage-token-1234567890123456" />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  expect(await screen.findByText("Consultation · Ari")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
  expect(
    screen.queryByRole("button", { name: "Reschedule" }),
  ).not.toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "10:00 AM" }),
  ).toBeInTheDocument();
  expect(screen.queryByLabelText("Date")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Available time")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /Tuesday, October 6/ }));
  fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  const reviewHeading = await screen.findByRole("heading", {
    name: "Review your change",
  });
  expect(reviewHeading).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "Confirm reschedule" }));
  await screen.findByText("Confirmed");
  expect(
    calls.some((call) =>
      call.path.startsWith(
        "/api/public/bookings/manage/manage-token-1234567890123456/availability?",
      ),
    ),
  ).toBe(true);
  expect(
    calls.some((call) => call.path.includes("/public/bookings/page-token")),
  ).toBe(false);
  const update = calls.find(
    (call) =>
      call.path ===
      "/api/public/bookings/manage/manage-token-1234567890123456/reschedule",
  );
  expect(update?.init?.body).toBe(
    JSON.stringify({ version: 7, startsAt: "2026-10-06T15:00:00Z" }),
  );
});

it("cancels only the linked reservation using its current revision", async () => {
  const requests: Array<{ path: string; body?: string }> = [];
  const reservation = {
    id: "reservation-1",
    serviceId: "service-1",
    professionalId: "professional-1",
    serviceName: "Consultation",
    professionalName: "Ari",
    startsAt: "2026-10-05T14:00:00Z",
    endsAt: "2026-10-05T14:30:00Z",
    customerName: "Casey",
    customerEmail: "casey@example.test",
    status: "confirmed",
    version: 4,
    deliveryStatus: "sent",
    calendarStatus: "not_configured",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      requests.push({ path, body: init?.body as string | undefined });
      if (path.endsWith("/manage/manage-token-1234567890123456"))
        return Response.json({
          data: {
            reservation,
            publicUrl:
              "https://savia.test/public/bookings/page-token-1234567890123456",
            timeZone: "America/Bogota",
            cancellationMinutes: 120,
          },
        });
      if (path.endsWith("/cancel"))
        return Response.json({
          data: { ...reservation, status: "cancelled", version: 5 },
        });
      throw new Error(`Unexpected public path ${path}`);
    }),
  );
  render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingManagePage token="manage-token-1234567890123456" />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  await screen.findByText("Confirmed");
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(await screen.findByText("Cancelled")).toBeInTheDocument();
  expect(requests).toContainEqual({
    path: "/api/public/bookings/manage/manage-token-1234567890123456/cancel",
    body: JSON.stringify({ version: 4 }),
  });
});

it.each([
  {
    name: "a version conflict",
    code: "VERSION_CONFLICT",
    message: "That time is no longer available. Choose another available time.",
  },
  {
    name: "a conflict with no JSON body",
    code: null,
    message: "That time is no longer available. Choose another available time.",
  },
  {
    name: "a meeting conflict",
    code: "BOOKING_TIME_CONFLICT",
    message:
      "That time conflicts with another meeting or appointment. Choose another available time.",
  },
])(
  "refreshes the private booking revision and slots after $name",
  async ({ code, message }) => {
    const requests: Array<{ path: string; body?: string }> = [];
    let manageReads = 0;
    let reschedulePosts = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://savia.test");
        requests.push({
          path: url.pathname + url.search,
          body: init?.body as string | undefined,
        });
        if (url.pathname === managePath) {
          manageReads += 1;
          return Response.json({
            data: manageData(
              confirmedReservation({ version: manageReads === 1 ? 7 : 8 }),
            ),
          });
        }
        if (url.pathname === `${managePath}/availability`)
          return Response.json({ data: availabilityData() });
        if (url.pathname === `${managePath}/reschedule`) {
          reschedulePosts += 1;
          if (reschedulePosts === 1)
            return code
              ? Response.json(
                  { error: { code, message: "Revision changed" } },
                  { status: 409 },
                )
              : new Response("Conflict", { status: 409 });
          return Response.json({
            data: confirmedReservation({
              startsAt: "2026-10-06T15:00:00Z",
              endsAt: "2026-10-06T15:30:00Z",
              version: 9,
            }),
          });
        }
        throw new Error(`Unexpected management path ${url.pathname}`);
      }),
    );
    renderManagePage();

    await screen.findByText("Confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    await screen.findByRole("button", { name: "10:00 AM" });
    fireEvent.click(screen.getByRole("button", { name: /Tuesday, October 6/ }));
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm reschedule" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    await screen.findByRole("heading", { name: "Choose a new time" });
    await screen.findByRole("button", { name: "10:00 AM" });
    fireEvent.click(screen.getByRole("button", { name: /Tuesday, October 6/ }));
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm reschedule" }),
    );

    await screen.findByRole("heading", { name: "Updated appointment" });
    const updates = requests.filter(
      (request) => request.path === `${managePath}/reschedule`,
    );
    expect(
      updates.map((request) => JSON.parse(request.body ?? "{}").version),
    ).toEqual([7, 8]);
    expect(
      requests.filter((request) =>
        request.path.startsWith(`${managePath}/availability?`),
      ),
    ).toHaveLength(2);
    expect(
      requests.some((request) => request.path.includes("page-token")),
    ).toBe(false);
  },
);

it.each([
  { status: 409, committed: true },
  { status: 503, committed: true },
  { status: undefined, committed: true },
  { status: undefined, committed: false },
  { status: 503, committed: false, moved: true },
  { status: 409, committed: false, moved: true },
])(
  "rechecks rescheduling (status: $status, committed: $committed, moved: $moved)",
  async ({ status, committed, moved }) => {
    const postedVersions: number[] = [];
    let manageReads = 0;
    const newTime = {
      startsAt: "2026-10-06T15:00:00Z",
      endsAt: "2026-10-06T15:30:00Z",
    };
    const otherTime = {
      startsAt: "2026-10-07T16:00:00Z",
      endsAt: "2026-10-07T16:30:00Z",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "https://savia.test");
        if (url.pathname === managePath) {
          manageReads += 1;
          const reservation =
            manageReads === 1
              ? confirmedReservation()
              : confirmedReservation({
                  ...(committed ? newTime : moved ? otherTime : {}),
                  version: 8,
                });
          return Response.json({ data: manageData(reservation) });
        }
        if (url.pathname === `${managePath}/availability`)
          return Response.json({ data: availabilityData() });
        if (url.pathname === `${managePath}/reschedule`) {
          postedVersions.push(JSON.parse(String(init?.body)).version);
          if (postedVersions.length > 1) {
            return Response.json({
              data: confirmedReservation({ ...newTime, version: 9 }),
            });
          }
          if (status === undefined) throw new TypeError("Connection closed");
          return Response.json(
            { error: { message: "Reschedule response failed" } },
            { status },
          );
        }
        throw new Error(`Unexpected management path ${url.pathname}`);
      }),
    );
    renderManagePage();

    await screen.findByText("Confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    await screen.findByRole("button", { name: "10:00 AM" });
    fireEvent.click(screen.getByRole("button", { name: /Tuesday, October 6/ }));
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm reschedule" }),
    );

    if (moved) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "This appointment was rescheduled. Review the updated time before making another change.",
      );
      expect(screen.getByText(/Oct 7, 2026, 11:00 AM/)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Confirm reschedule" }),
      ).toBeNull();
      expect(screen.getByRole("button", { name: "Reschedule" })).toBeEnabled();
      expect(postedVersions).toEqual([7]);
      return;
    }
    if (!committed) {
      await screen.findByText(
        "This booking could not be rescheduled. Refresh the times and retry.",
      );
      expect(
        screen.getByRole("heading", { name: "Review your change" }),
      ).toBeInTheDocument();
      expect(postedVersions).toEqual([7]);
      fireEvent.click(
        screen.getByRole("button", { name: "Confirm reschedule" }),
      );
    }

    expect(
      await screen.findByRole("heading", { name: "Updated appointment" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Your appointment has been updated."),
    ).toBeInTheDocument();
    expect(postedVersions).toEqual(committed ? [7] : [7, 8]);
  },
);

it.each(["cancelled", "unchanged", "moved"])(
  "rechecks an uncertain cancellation before allowing a retry (%s)",
  async (outcome) => {
    let reads = 0;
    const postedVersions: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), "https://savia.test").pathname;
        if (path === `${managePath}/availability`)
          return Response.json({ data: availabilityData() });
        if (path === `${managePath}/cancel`) {
          postedVersions.push(JSON.parse(String(init?.body)).version);
          if (postedVersions.length === 1)
            throw new TypeError("Connection closed");
          return Response.json({
            data: confirmedReservation({ status: "cancelled", version: 9 }),
          });
        }
        reads += 1;
        return Response.json({
          data: manageData(
            reads === 1
              ? confirmedReservation()
              : confirmedReservation({
                  version: 8,
                  status: outcome === "cancelled" ? "cancelled" : "confirmed",
                  ...(outcome === "moved"
                    ? {
                        startsAt: "2026-10-07T16:00:00Z",
                        endsAt: "2026-10-07T16:30:00Z",
                      }
                    : {}),
                }),
          ),
        });
      }),
    );
    renderManagePage();
    if (outcome === "moved") {
      fireEvent.click(
        await screen.findByRole("button", { name: "Reschedule" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      expect(
        screen.getByRole("button", { name: "Confirm reschedule" }),
      ).toBeEnabled();
    }
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel reservation" }),
    );

    if (outcome === "cancelled") {
      expect(await screen.findByText("Cancelled")).toBeVisible();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(postedVersions).toEqual([7]);
    } else {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        outcome === "moved"
          ? "This appointment was rescheduled. Review the updated time before making another change."
          : "This booking could not be cancelled",
      );
      if (outcome === "moved") {
        expect(screen.getByText(/Oct 7, 2026, 11:00 AM/)).toBeVisible();
        expect(
          screen.queryByRole("button", { name: "Confirm reschedule" }),
        ).toBeNull();
      }
      expect(postedVersions).toEqual([7]);
      fireEvent.click(
        screen.getByRole("button", { name: "Cancel reservation" }),
      );
      expect(await screen.findByText("Cancelled")).toBeVisible();
      expect(postedVersions).toEqual([7, 8]);
    }
    expect(reads).toBe(2);
  },
);

it.each(["cancel", "reschedule"])(
  "waits for Retry-After before offering another %s request",
  async (action) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const requestedSlot = "2026-10-06T15:00:00Z";
    const writes: unknown[] = [];
    const request = vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input, "https://savia.test").pathname;
      if (path === managePath) return Response.json({ data: manageData() });
      if (path === `${managePath}/availability`)
        return Response.json({ data: availabilityData(requestedSlot) });
      if (path !== `${managePath}/${action}`)
        throw new Error(`Unexpected management path ${path}`);
      writes.push(JSON.parse(String(init?.body)));
      if (writes.length === 1)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      return Response.json({
        data: confirmedReservation(
          action === "cancel"
            ? { status: "cancelled", version: 8 }
            : {
                startsAt: requestedSlot,
                endsAt: "2026-10-06T15:30:00Z",
                version: 8,
              },
        ),
      });
    });
    vi.stubGlobal("fetch", request);
    await act(async () => {
      renderManagePage();
    });
    if (action === "reschedule") {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
      });
      fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
    const name =
      action === "cancel" ? "Cancel reservation" : "Confirm reschedule";
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Too many booking requests. Try again after",
    );
    expect(
      screen.getByRole("button", { name: "Cancel reservation" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(
      request.mock.calls.filter(([path]) => path === managePath),
    ).toHaveLength(1);
    act(() => vi.advanceTimersByTime(29_999));
    fireEvent.click(screen.getByRole("button", { name }));
    expect(writes).toHaveLength(1);

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("button", { name })).toBeEnabled();
    expect(writes).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name }));
    });
    const expectedWrite = {
      version: 7,
      ...(action === "reschedule" ? { startsAt: requestedSlot } : {}),
    };
    expect(writes).toEqual([expectedWrite, expectedWrite]);
    expect(
      screen.getByText(
        action === "cancel"
          ? "Cancelled"
          : "Your appointment has been updated.",
      ),
    ).toBeVisible();
  },
);

it.each(["cancel", "reschedule"])(
  "requires a successful appointment refresh before allowing changes after an unverified %s",
  async (action) => {
    const changed =
      action === "cancel"
        ? confirmedReservation({ status: "cancelled", version: 8 })
        : confirmedReservation({
            startsAt: "2026-10-06T15:00:00Z",
            endsAt: "2026-10-06T15:30:00Z",
            version: 8,
          });
    let reads = 0;
    const request = vi.fn(async (path: string) => {
      if (path.startsWith(`${managePath}/availability?`))
        return Response.json({ data: availabilityData() });
      if (path === `${managePath}/${action}`)
        return new Response(null, { status: 503 });
      reads += 1;
      if (reads === 2 || reads === 3)
        return new Response(null, { status: 503 });
      return Response.json({
        data: manageData(reads === 1 ? confirmedReservation() : changed),
      });
    });
    vi.stubGlobal("fetch", request);
    renderManagePage();
    if (action === "reschedule") {
      fireEvent.click(
        await screen.findByRole("button", { name: "Reschedule" }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
    fireEvent.click(
      await screen.findByRole("button", {
        name: action === "cancel" ? "Cancel reservation" : "Confirm reschedule",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not verify the change.",
    );
    const cancel = screen.getByRole("button", { name: "Cancel reservation" });
    expect(cancel).toBeDisabled();
    const refresh = screen.getByRole("button", { name: "Refresh appointment" });
    fireEvent.click(refresh);
    expect(
      await screen.findByText(
        "The appointment could not be refreshed. Try again.",
      ),
    ).toBeVisible();
    expect(cancel).toBeDisabled();
    fireEvent.click(refresh);
    if (action === "cancel") {
      expect(await screen.findByText("Cancelled")).toBeVisible();
    } else {
      expect(await screen.findByText(/Oct 6, 2026, 10:00 AM/)).toBeVisible();
      expect(cancel).toBeEnabled();
    }
    expect(
      request.mock.calls.filter(([path]) => path === `${managePath}/${action}`),
    ).toHaveLength(1);
  },
);

it.each([
  { action: "refresh", status: 404, button: "Refresh appointment" },
  { action: "cancel", status: 410, button: "Cancel reservation" },
  { action: "reschedule", status: 404, button: "Confirm reschedule" },
])(
  "hides appointment details when a current read after $action returns $status",
  async ({ action, status, button }) => {
    let reads = 0;
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === `${managePath}/availability`)
        return Response.json({ data: availabilityData() });
      if (path === `${managePath}/${action}`)
        return new Response(null, { status: 503 });
      if (path !== managePath)
        throw new Error(`Unexpected management path ${path}`);
      if (++reads > 1) return new Response(null, { status });
      return Response.json({
        data: manageData(
          confirmedReservation({
            conference: {
              provider: "google_meet",
              joinUrl: null,
              status: "pending",
            },
          }),
        ),
      });
    });
    vi.stubGlobal("fetch", request);
    renderManagePage();
    expect(await screen.findByText("Casey · casey@example.test")).toBeVisible();
    if (action === "reschedule") {
      fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
      fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    }
    fireEvent.click(screen.getByRole("button", { name: button }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This booking link could not be loaded. Ask the booking owner for help.",
    );
    expect(screen.queryByText("Casey · casey@example.test")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Cancel reservation" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(reads).toBe(2);
  },
);

it("honors consecutive read limits while verifying an uncertain cancellation", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  const request = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ data: manageData() }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
    )
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "10" } }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: manageData(
          confirmedReservation({ status: "cancelled", version: 8 }),
        ),
      }),
    );
  vi.stubGlobal("fetch", request);

  await act(async () => {
    renderManagePage();
  });
  const cancel = screen.getByRole("button", { name: "Cancel reservation" });
  await act(async () => {
    fireEvent.click(cancel);
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Too many booking requests. Try again after",
  );
  const refresh = screen.getByRole("button", { name: "Refresh appointment" });
  expect(refresh).toBeDisabled();
  fireEvent.click(refresh);
  expect(request).toHaveBeenCalledTimes(3);
  act(() => vi.advanceTimersByTime(30_000));
  expect(cancel).toBeDisabled();
  expect(refresh).toBeEnabled();
  expect(request).toHaveBeenCalledTimes(3);
  await act(async () => {
    fireEvent.click(refresh);
  });
  expect(refresh).toBeDisabled();
  act(() => vi.advanceTimersByTime(10_000));
  expect(refresh).toBeEnabled();
  expect(cancel).toBeDisabled();
  await act(async () => {
    fireEvent.click(refresh);
  });
  expect(screen.getByText("Cancelled")).toBeVisible();
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    managePath,
    `${managePath}/cancel`,
    managePath,
    managePath,
    managePath,
  ]);
});

it.each(["appointment", "availability"])(
  "pauses both management reads when %s returns a retry deadline",
  async (limited) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
    const data = manageData(
      confirmedReservation({
        conference: {
          provider: "google_meet",
          joinUrl: null,
          status: "pending",
        },
      }),
    );
    let reads = 0;
    const request = vi.fn(async (input: string) => {
      const path = new URL(input, "https://savia.test").pathname;
      const availability = path === `${managePath}/availability`;
      if (
        (availability && limited === "availability" && reads === 1) ||
        (!availability && limited === "appointment" && reads === 1)
      ) {
        reads += 1;
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      }
      reads += 1;
      return Response.json({ data: availability ? availabilityData() : data });
    });
    vi.stubGlobal("fetch", request);
    await act(async () => {
      renderManagePage();
    });

    const refresh = screen.getByRole("button", { name: "Refresh appointment" });
    if (limited === "appointment") {
      await act(async () => {
        fireEvent.click(refresh);
      });
    }
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    });

    const retry = screen.getByRole("button", { name: "Retry" });
    expect(refresh).toBeDisabled();
    expect(retry).toBeDisabled();
    fireEvent.click(refresh);
    fireEvent.click(retry);
    expect(request).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(30_000));
    expect(refresh).toBeEnabled();
    expect(retry).toBeEnabled();
    expect(request).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.click(retry);
    });
    expect(screen.getByRole("button", { name: "10:00 AM" })).toBeEnabled();
    expect(request).toHaveBeenCalledTimes(3);
  },
);

it("uses a read limit received while a cancellation is still pending", async () => {
  let respondToCalendar!: (response: Response) => void;
  let respondToCancellation!: (response: Response) => void;
  const pendingCalendar = new Promise<Response>((resolve) => {
    respondToCalendar = resolve;
  });
  const pendingCancellation = new Promise<Response>((resolve) => {
    respondToCancellation = resolve;
  });
  const request = vi.fn(async (input: string) => {
    const path = new URL(input, "https://savia.test").pathname;
    if (path === `${managePath}/availability`) return pendingCalendar;
    if (path === `${managePath}/cancel`) return pendingCancellation;
    return Response.json({ data: manageData() });
  });
  vi.stubGlobal("fetch", request);
  renderManagePage();
  fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  await act(async () => {
    respondToCalendar(
      new Response(null, { status: 429, headers: { "Retry-After": "30" } }),
    );
  });
  await act(async () => {
    respondToCancellation(new Response(null, { status: 503 }));
  });

  expect(
    request.mock.calls.map(
      ([path]) => new URL(path, "https://savia.test").pathname,
    ),
  ).toEqual([managePath, `${managePath}/availability`, `${managePath}/cancel`]);
  expect(
    screen.getByRole("button", { name: "Refresh appointment" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Cancel reservation" }),
  ).toBeDisabled();
});

it("leaves the appointment unchanged when a reviewed change is backed out", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://savia.test");
      requests.push(url.pathname);
      if (url.pathname === managePath)
        return Response.json({ data: manageData() });
      if (url.pathname === `${managePath}/availability`)
        return Response.json({ data: availabilityData() });
      throw new Error(`Unexpected management path ${url.pathname}`);
    }),
  );
  renderManagePage();

  await screen.findByText("Confirmed");
  fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
  await screen.findByRole("button", { name: "10:00 AM" });
  fireEvent.click(screen.getByRole("button", { name: /Tuesday, October 6/ }));
  fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: "Review your change" });
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  await screen.findByRole("heading", { name: "Choose a new time" });
  fireEvent.click(screen.getByRole("button", { name: "Stop rescheduling" }));

  expect(screen.getByText(/Oct 5, 2026, 9:00 AM/)).toBeInTheDocument();
  expect(requests).not.toContain(`${managePath}/reschedule`);
});

it("keeps cancellation available when rescheduling is not permitted", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === managePath)
        return Response.json({
          data: manageData(confirmedReservation(), { canReschedule: false }),
        });
      if (path.endsWith("/cancel"))
        return Response.json({
          data: confirmedReservation({ status: "cancelled", version: 8 }),
        });
      throw new Error(`Unexpected management path ${path}`);
    }),
  );
  renderManagePage();

  await screen.findByText("Confirmed");
  expect(
    screen.queryByRole("button", { name: "Reschedule" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText(
      "To change this appointment, contact the booking business.",
    ),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Cancel reservation" }),
  ).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(await screen.findByText("Cancelled")).toBeInTheDocument();
});

it.each([
  {
    reason: "the professional becomes unavailable",
    status: 404,
    refreshed: () =>
      manageData(confirmedReservation(), { canReschedule: false }),
    cancelState: "enabled",
  },
  {
    reason: "permission is revoked",
    refreshed: () =>
      manageData(confirmedReservation(), { canReschedule: false }),
    cancelState: "enabled",
  },
  {
    reason: "the cancellation cutoff has passed",
    refreshed: () =>
      manageData(confirmedReservation(), { cancellationMinutes: 100_000 }),
    cancelState: "disabled",
  },
  {
    reason: "the reservation has already been cancelled",
    refreshed: () => manageData(confirmedReservation({ status: "cancelled" })),
    cancelState: "hidden",
  },
])(
  "closes rescheduling after a conflict when $reason",
  async ({ refreshed, cancelState, status = 409 }) => {
    const requests: string[] = [];
    let manageReads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), "https://savia.test");
        requests.push(url.pathname);
        if (url.pathname === managePath) {
          manageReads += 1;
          return Response.json({
            data: manageReads === 1 ? manageData() : refreshed(),
          });
        }
        if (url.pathname === `${managePath}/availability`)
          return Response.json({ data: availabilityData() });
        if (url.pathname === `${managePath}/reschedule`)
          return Response.json(
            { error: { message: "Revision changed" } },
            { status },
          );
        throw new Error(`Unexpected management path ${url.pathname}`);
      }),
    );
    renderManagePage();

    await screen.findByText("Confirmed");
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
    await screen.findByRole("button", { name: "10:00 AM" });
    fireEvent.click(screen.getByRole("button", { name: /Tuesday, October 6/ }));
    fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirm reschedule" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "To change this appointment, contact the booking business.",
    );
    expect(
      screen.queryByRole("heading", { name: "Choose a new time" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reschedule" }),
    ).not.toBeInTheDocument();
    if (cancelState === "enabled")
      expect(
        screen.getByRole("button", { name: "Cancel reservation" }),
      ).toBeEnabled();
    else if (cancelState === "disabled")
      expect(
        screen.getByRole("button", { name: "Cancel reservation" }),
      ).toBeDisabled();
    else
      expect(
        screen.queryByRole("button", { name: "Cancel reservation" }),
      ).not.toBeInTheDocument();
    expect(
      requests.filter((path) => path === `${managePath}/availability`),
    ).toHaveLength(1);
  },
);

it("does not render the public booking link when bootstrap has no public URL", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === managePath)
        return Response.json({
          data: manageData(confirmedReservation(), { publicUrl: null }),
        });
      throw new Error(`Unexpected management path ${path}`);
    }),
  );
  renderManagePage();

  await screen.findByText("Confirmed");
  expect(
    screen.queryByText("Book another appointment"),
  ).not.toBeInTheDocument();
});

it("refreshes a pending conference link from the private management endpoint", async () => {
  let reads = 0;
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === managePath) {
        reads += 1;
        const reservation = confirmedReservation({
          conference:
            reads === 1
              ? { provider: "google_meet", joinUrl: null, status: "pending" }
              : {
                  provider: "google_meet",
                  joinUrl: "https://meet.google.com/abc-defg-hij",
                  status: "ready",
                },
        });
        return Response.json({ data: manageData(reservation) });
      }
      throw new Error(`Unexpected management path ${path}`);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  renderManagePage();

  expect(
    await screen.findByText(/link is being prepared/i),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh appointment" }));

  expect(
    await screen.findByRole("link", { name: "Join Google Meet" }),
  ).toHaveAttribute("href", "https://meet.google.com/abc-defg-hij");
  expect(reads).toBe(2);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][1]?.credentials).toBe("omit");
});

it.each([200, 404])("ignores stale refreshes (%s)", async (status) => {
  let refreshReads = 0;
  let resolveRefresh!: (response: Response) => void;
  const delayedRefresh = new Promise<Response>((resolve) => {
    resolveRefresh = resolve;
  });
  const staleReservation = confirmedReservation({
    conference: { provider: "google_meet", joinUrl: null, status: "pending" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), "https://savia.test").pathname;
      if (path === managePath) {
        refreshReads += 1;
        return refreshReads === 1
          ? Response.json({ data: manageData(staleReservation) })
          : delayedRefresh;
      }
      if (path === `${managePath}/cancel`)
        return Response.json({
          data: {
            ...staleReservation,
            status: "cancelled",
            version: staleReservation.version + 1,
          },
        });
      throw new Error(`Unexpected management path ${path}`);
    }),
  );
  renderManagePage();

  expect(
    await screen.findByText(/link is being prepared/i),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Refresh appointment" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel reservation" }));
  expect(await screen.findByText("Cancelled")).toBeInTheDocument();

  await act(async () => {
    resolveRefresh(
      status === 200
        ? Response.json({ data: manageData(staleReservation) })
        : new Response(null, { status }),
    );
    await delayedRefresh;
  });

  expect(screen.getByText("Cancelled")).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Cancel reservation" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Join Google Meet" })).toBeNull();
});

it.each(["conference ready", "rescheduled elsewhere", "cancelled elsewhere"])(
  "shows a reschedule confirmation only while it is current after refresh: %s",
  async (outcome) => {
    const updatedBooking = confirmedReservation({
      startsAt: "2026-10-06T15:00:00Z",
      endsAt: "2026-10-06T15:30:00Z",
      version: 8,
      conference: { provider: "google_meet", joinUrl: null, status: "pending" },
    });
    const refreshedBooking = {
      ...updatedBooking,
      version: 9,
      ...(outcome === "rescheduled elsewhere"
        ? {
            startsAt: "2026-10-07T16:00:00Z",
            endsAt: "2026-10-07T16:30:00Z",
          }
        : {}),
      status: outcome === "cancelled elsewhere" ? "cancelled" : "confirmed",
      conference: {
        provider: "google_meet",
        joinUrl: "https://meet.google.com/abc-defg-hij",
        status: "ready",
      },
    };
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "https://savia.test").pathname;
        if (path === managePath) {
          reads += 1;
          return Response.json({
            data: manageData(
              reads === 1 ? confirmedReservation() : refreshedBooking,
            ),
          });
        }
        if (path === `${managePath}/availability`)
          return Response.json({ data: availabilityData() });
        if (path === `${managePath}/reschedule`)
          return Response.json({ data: updatedBooking });
        throw new Error(`Unexpected management path ${path}`);
      }),
    );
    renderManagePage();
    fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "America/New_York" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "11:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm reschedule" }));

    const confirmation = await screen.findByRole("heading", {
      name: "Updated appointment",
    });
    expect(screen.getByText(/11:00 AM EDT/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh appointment" }),
    );

    if (outcome === "cancelled elsewhere") {
      await screen.findByText("Cancelled");
    } else {
      await screen.findByRole("link", { name: "Join Google Meet" });
    }
    if (outcome === "conference ready") {
      expect(confirmation).toBeInTheDocument();
      expect(screen.getByText(/11:00 AM EDT/)).toBeInTheDocument();
    } else {
      expect(confirmation).not.toBeInTheDocument();
      expect(screen.queryByText(/11:00 AM EDT/)).not.toBeInTheDocument();
    }
  },
);

it("closes the review and disables cancellation as soon as the booking deadline passes", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-05T11:59:50Z"));
  const fetchBooking = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://savia.test").pathname;
    if (path === managePath) return Response.json({ data: manageData() });
    if (path === `${managePath}/availability`)
      return Response.json({ data: availabilityData() });
    throw new Error(`Unexpected management path ${path}`);
  });
  vi.stubGlobal("fetch", fetchBooking);
  await act(async () => {
    renderManagePage();
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Reschedule" }));
  });
  fireEvent.click(screen.getByRole("button", { name: "10:00 AM" }));
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  expect(
    screen.getByRole("button", { name: "Confirm reschedule" }),
  ).toBeEnabled();

  act(() => vi.advanceTimersByTime(10_000));
  expect(
    screen.getByRole("button", { name: "Confirm reschedule" }),
  ).toBeEnabled();
  act(() => vi.advanceTimersByTime(1));

  expect(
    screen.queryByRole("button", { name: "Confirm reschedule" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Cancel reservation" }),
  ).toBeDisabled();
  expect(
    screen.getByText("The cancellation and rescheduling window has closed."),
  ).toBeInTheDocument();
  expect(fetchBooking).toHaveBeenCalledTimes(2);
});

it.each(["conference ready", "appointment moved", "rescheduling disabled"])(
  "rechecks an open reschedule review when refreshing the appointment: %s",
  async (outcome) => {
    const original = confirmedReservation({
      conference: { provider: "google_meet", joinUrl: null, status: "pending" },
    });
    const refreshed = confirmedReservation({
      version: 8,
      ...(outcome === "appointment moved"
        ? {
            startsAt: "2026-10-07T16:00:00Z",
            endsAt: "2026-10-07T16:30:00Z",
          }
        : {}),
      conference: {
        provider: "google_meet",
        joinUrl: "https://meet.google.com/abc-defg-hij",
        status: "ready",
      },
    });
    let reads = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = new URL(String(input), "https://savia.test").pathname;
        if (path === managePath) {
          reads += 1;
          return Response.json({
            data:
              reads === 1
                ? manageData(original)
                : manageData(refreshed, {
                    canReschedule: outcome !== "rescheduling disabled",
                  }),
          });
        }
        if (path === `${managePath}/availability`)
          return Response.json({ data: availabilityData() });
        throw new Error(`Unexpected management path ${path}`);
      }),
    );
    renderManagePage();
    fireEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
    fireEvent.click(await screen.findByRole("button", { name: "10:00 AM" }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const confirm = screen.getByRole("button", { name: "Confirm reschedule" });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh appointment" }),
    );
    await screen.findByRole("link", { name: "Join Google Meet" });

    if (outcome === "conference ready") {
      expect(confirm).toBeEnabled();
    } else {
      expect(confirm).not.toBeInTheDocument();
    }
    if (outcome === "appointment moved") {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This appointment was rescheduled. Review the updated time before making another change.",
      );
      expect(screen.getByText(/Oct 7, 2026, 11:00 AM/)).toBeVisible();
      expect(screen.getByRole("button", { name: "Reschedule" })).toBeEnabled();
    }
  },
);

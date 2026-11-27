import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import { StoreContextProvider, memoryStore } from "ra-core";
import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PublicBookingAvailability } from "./public-booking-availability";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
});

it("shows an inline month and the selected day's explicit time buttons together", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        data: {
          displayTimeZone: "America/Bogota",
          businessTimeZone: "America/Bogota",
          days: [
            {
              date: "2026-10-05",
              slots: [
                {
                  startsAt: "2026-10-05T14:00:00Z",
                  endsAt: "2026-10-05T14:30:00Z",
                },
              ],
            },
          ],
        },
      }),
    ),
  );
  const onChange = vi.fn();
  render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <PublicBookingAvailability
          token="personal-token"
          catalog={{
            id: "page-id",
            timeZone: "America/Bogota",
            horizonDays: 30,
            leadMinutes: 0,
          }}
          serviceId="consult"
          professionalId="pro-1"
          displayTimeZone="America/Bogota"
          onTimeZoneChange={vi.fn()}
          value={undefined}
          onChange={onChange}
        />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );

  expect(
    screen.getByRole("heading", { name: "Choose a day and time" }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole("button", { name: "9:00 AM" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Monday, October 5" }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("group", { name: "Available times for October 5, 2026" }),
  ).toBeInTheDocument();
  expect(screen.getByRole("grid")).toBeInTheDocument();
  expect(document.querySelector('input[type="date"]')).toBeNull();
  expect(
    document.querySelector("select:not([aria-label='Time zone'])"),
  ).toBeNull();
  await waitFor(() => expect(onChange).not.toHaveBeenCalled());
});

it.each([
  {
    name: "includes the last bookable date after the spring clock change",
    now: "2026-03-07T04:45:00Z",
    initialZone: "America/New_York",
    nextZone: undefined,
    from: "2026-03-06",
    to: "2026-03-09",
  },
  {
    name: "opens the available month when the display zone crosses a month boundary",
    now: "2026-10-01T04:00:00Z",
    initialZone: "America/Los_Angeles",
    nextZone: "Asia/Tokyo",
    from: "2026-10-01",
    to: "2026-10-03",
  },
])("$name", async ({ now, initialZone, nextZone, from, to }) => {
  vi.setSystemTime(new Date(now));
  const loadAvailability = vi.fn(async (_url: string) =>
    Response.json({ data: { days: [] } }),
  );
  vi.stubGlobal("fetch", loadAvailability);
  function Calendar() {
    const [zone, setZone] = useState(initialZone);
    return (
      <PublicBookingAvailability
        token="personal-token"
        catalog={{
          id: "page-id",
          timeZone: initialZone,
          horizonDays: 2,
          leadMinutes: 0,
        }}
        serviceId="consult"
        professionalId="pro-1"
        displayTimeZone={zone}
        onTimeZoneChange={setZone}
        value={undefined}
        onChange={vi.fn()}
      />
    );
  }
  render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <Calendar />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  await waitFor(() => expect(loadAvailability).toHaveBeenCalledTimes(1));
  if (nextZone) {
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: nextZone },
    });
  }
  await waitFor(() => {
    const latestUrl = new URL(
      loadAvailability.mock.lastCall![0],
      "https://booking.test",
    );
    expect(latestUrl.searchParams.get("displayTimeZone")).toBe(
      nextZone ?? initialZone,
    );
    expect(latestUrl.searchParams.get("from")).toBe(from);
    expect(latestUrl.searchParams.get("to")).toBe(to);
  });
});

it.each(["offline", "rate-limited"])(
  "keeps the selection pending when availability cannot be verified (%s)",
  async (failure) => {
    const retryAt = new Date("2026-10-03T12:01:00Z");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (failure === "rate-limited")
          return new Response(null, {
            status: 429,
            headers: { "Retry-After": retryAt.toUTCString() },
          });
        throw new Error("offline");
      }),
    );
    const onChange = vi.fn();
    const onReadyChange = vi.fn();
    render(
      <StoreContextProvider value={memoryStore({ locale: "en" })}>
        <AppLocaleProvider>
          <PublicBookingAvailability
            token="personal-token"
            catalog={{
              id: "page-id",
              timeZone: "America/Bogota",
              horizonDays: 30,
              leadMinutes: 0,
            }}
            serviceId="consult"
            professionalId="pro-1"
            displayTimeZone="America/Bogota"
            onTimeZoneChange={vi.fn()}
            value={{
              professionalId: "pro-1",
              serviceId: "consult",
              displayTimeZone: "America/Bogota",
              slot: {
                startsAt: "2026-10-05T14:00:00Z",
                endsAt: "2026-10-05T14:30:00Z",
              },
            }}
            onChange={onChange}
            onReadyChange={onReadyChange}
          />
        </AppLocaleProvider>
      </StoreContextProvider>,
    );
    const alert = await screen.findByRole("alert");
    if (failure === "rate-limited") {
      expect(alert).toHaveTextContent("Too many booking requests.");
      expect(alert).toHaveTextContent(
        new Intl.DateTimeFormat("en-US", {
          dateStyle: "short",
          timeStyle: "medium",
        }).format(retryAt),
      );
    } else {
      expect(alert).toHaveTextContent("Available times could not be loaded");
    }
    expect(onReadyChange).toHaveBeenCalledWith(false);
    expect(onReadyChange).not.toHaveBeenCalledWith(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByText("No available times")).not.toBeInTheDocument();
  },
);

it("keeps the calendar's latest month and zone without requesting them before Retry-After", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-03T12:00:00Z"));
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(null, {
        status: 429,
        headers: { "Retry-After": new Date(Date.now() + 30_000).toUTCString() },
      }),
    )
    .mockResolvedValue(Response.json({ data: { days: [] } }));
  vi.stubGlobal("fetch", request);
  const onChange = vi.fn();
  function Calendar() {
    const [zone, setZone] = useState("America/Bogota");
    return (
      <PublicBookingAvailability
        token="personal-token"
        catalog={{
          id: "page-id",
          timeZone: "America/Bogota",
          horizonDays: 90,
          leadMinutes: 0,
        }}
        serviceId="consult"
        professionalId="pro-1"
        displayTimeZone={zone}
        onTimeZoneChange={setZone}
        value={undefined}
        onChange={onChange}
      />
    );
  }
  await act(async () => {
    render(
      <StoreContextProvider value={memoryStore({ locale: "en" })}>
        <AppLocaleProvider>
          <Calendar />
        </AppLocaleProvider>
      </StoreContextProvider>,
    );
  });
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  fireEvent.change(screen.getByLabelText("Time zone"), {
    target: { value: "Asia/Tokyo" },
  });
  expect(screen.getByText("November 2026")).toBeVisible();
  act(() => vi.advanceTimersByTime(29_999));
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(request).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  });
  expect(request).toHaveBeenCalledTimes(2);
  const query = new URL(request.mock.lastCall![0], "https://booking.test")
    .searchParams;
  expect(query.get("from")).toBe("2026-11-01");
  expect(query.get("to")).toBe("2026-11-30");
  expect(query.get("displayTimeZone")).toBe("Asia/Tokyo");
});

it("verifies a preselected time once per zone and keeps its UTC identity", async () => {
  const loadAvailability = vi.fn(async () =>
    Response.json({
      data: {
        displayTimeZone: "America/New_York",
        businessTimeZone: "America/Bogota",
        days: [
          {
            date: "2026-10-05",
            slots: [
              {
                startsAt: "2026-10-05T14:00:00Z",
                endsAt: "2026-10-05T14:30:00Z",
              },
            ],
          },
        ],
      },
    }),
  );
  vi.stubGlobal("fetch", loadAvailability);
  const onChange = vi.fn();
  const onTimeZoneChange = vi.fn();
  function ControlledAvailability() {
    const [zone, setZone] = useState("America/Bogota");
    return (
      <PublicBookingAvailability
        token="personal-token"
        catalog={{
          id: "page-id",
          timeZone: "America/Bogota",
          horizonDays: 30,
          leadMinutes: 0,
        }}
        serviceId="consult"
        professionalId="pro-1"
        displayTimeZone={zone}
        onTimeZoneChange={(nextZone) => {
          onTimeZoneChange(nextZone);
          setZone(nextZone);
        }}
        value={{
          professionalId: "pro-1",
          serviceId: "consult",
          displayTimeZone: "America/Bogota",
          slot: {
            startsAt: "2026-10-05T14:00:00Z",
            endsAt: "2026-10-05T14:30:00Z",
          },
        }}
        onChange={onChange}
      />
    );
  }
  render(
    <StoreContextProvider value={memoryStore({ locale: "en" })}>
      <AppLocaleProvider>
        <ControlledAvailability />
      </AppLocaleProvider>
    </StoreContextProvider>,
  );
  await screen.findByRole("button", { name: "9:00 AM" });
  expect(loadAvailability).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Time zone"), {
    target: { value: "America/New_York" },
  });
  expect(onTimeZoneChange).toHaveBeenCalledWith("America/New_York");
  await waitFor(() =>
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        displayTimeZone: "America/New_York",
        slot: expect.objectContaining({ startsAt: "2026-10-05T14:00:00Z" }),
      }),
    ),
  );
  expect(loadAvailability).toHaveBeenCalledTimes(2);
});

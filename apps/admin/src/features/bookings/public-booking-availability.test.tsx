import { AppLocaleProvider } from "@/i18n/app-locale-provider";
import { StoreContextProvider, memoryStore } from "ra-core";
import { useState } from "react";
import {
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

it("keeps the selection pending when availability cannot be verified", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
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
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Available times could not be loaded",
  );
  expect(onReadyChange).toHaveBeenCalledWith(false);
  expect(onReadyChange).not.toHaveBeenCalledWith(true);
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.queryByText("No available times")).not.toBeInTheDocument();
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

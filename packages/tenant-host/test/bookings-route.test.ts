import { expect, it } from "vitest";
import {
  bookingQueryFromOAuthState,
  normalizeBookingRouteQuery,
  readBookingRouteQuery,
} from "../src/bookings-route";

it("carries a validated same-origin organization in a Bookings destination", () => {
  const query = "tenantId=42&tab=availability&date=2026-11-25&ignored=1";
  expect(readBookingRouteQuery(new URLSearchParams(query)).tenantId).toBe(42);
  expect(bookingQueryFromOAuthState(`transaction.bookings?${query}`)).toBe(
    "tab=availability&date=2026-11-25&tenantId=42",
  );
  expect(normalizeBookingRouteQuery(query, { includeTenantId: false })).toBe(
    "tab=availability&date=2026-11-25",
  );
});

it.each([
  "tenantId=0",
  "tenantId=-1",
  "tenantId=1.5",
  "tenantId=1e2",
  "tenantId=9007199254740992",
  "tenantId=42&tenantId=43",
])(
  "discards an invalid or ambiguous Bookings organization when %s",
  (query) => {
    expect(
      readBookingRouteQuery(new URLSearchParams(query)).tenantId,
    ).toBeNull();
    expect(normalizeBookingRouteQuery(`tab=reservations&${query}`)).toBe(
      "tab=reservations",
    );
  },
);

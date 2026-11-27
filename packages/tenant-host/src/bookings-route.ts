export const bookingTabs = [
  "settings",
  "availability",
  "reservations",
  "sharing",
] as const;
export type BookingTab = (typeof bookingTabs)[number];

export function readBookingRouteQuery(query: URLSearchParams) {
  const requestedTab = query.get("tab");
  const requestedDate = query.get("date");
  const tab = bookingTabs.find((value) => value === requestedTab);
  const parsed =
    requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
      ? Date.parse(requestedDate)
      : NaN;
  const date =
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === requestedDate
      ? requestedDate
      : null;
  const tenantIds = query.getAll("tenantId");
  const requestedTenantId =
    tenantIds.length === 1 && /^[1-9]\d*$/.test(tenantIds[0])
      ? Number(tenantIds[0])
      : NaN;
  const tenantId = Number.isSafeInteger(requestedTenantId)
    ? requestedTenantId
    : null;
  return { tab, date, tenantId };
}

export function normalizeBookingRouteQuery(
  query: string,
  { includeTenantId = true } = {},
): string {
  const { tab, date, tenantId } = readBookingRouteQuery(
    new URLSearchParams(query),
  );
  const normalized = new URLSearchParams();
  if (tab) normalized.set("tab", tab);
  if (date) normalized.set("date", date);
  if (includeTenantId && tenantId !== null)
    normalized.set("tenantId", String(tenantId));
  return normalized.toString();
}

/** Read only the Bookings destination. The OAuth state still needs server validation. */
export function bookingQueryFromOAuthState(
  state: string | null,
): string | undefined {
  const bookingState = /^[A-Za-z0-9_-]+\.bookings(?:\?(.*))?$/.exec(
    state ?? "",
  );
  return bookingState
    ? normalizeBookingRouteQuery(bookingState[1] ?? "")
    : undefined;
}

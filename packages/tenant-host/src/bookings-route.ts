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
  return { tab, date };
}

export function normalizeBookingRouteQuery(query: string): string {
  const { tab, date } = readBookingRouteQuery(new URLSearchParams(query));
  const normalized = new URLSearchParams();
  if (tab) normalized.set("tab", tab);
  if (date) normalized.set("date", date);
  return normalized.toString();
}

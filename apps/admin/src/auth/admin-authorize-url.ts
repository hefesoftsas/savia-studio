import { isAllowedTenantOrigin } from "@savia/tenant-host";
import { normalizeBookingRouteQuery } from "@savia/tenant-host/bookings-route";

export function adminAuthorizeUrl(
  apiUrl: string,
  currentUrl: string,
  bookingQuery?: string,
): string {
  const authorize = new URL("/api/auth/admin/authorize", apiUrl);
  const current = new URL(currentUrl);
  const bookings = /^#\/bookings\/*(?:\?(.*))?$/i.exec(current.hash);
  const login = /^#\/login(?:\?(.*))?$/i.exec(current.hash);
  const recovery = new URLSearchParams(login?.[1]);
  if (
    bookings ||
    bookingQuery !== undefined ||
    recovery.get("resume") === "bookings"
  ) {
    if (isAllowedTenantOrigin(current.origin))
      authorize.searchParams.set("return_to", current.origin);
    authorize.searchParams.set("resume", "bookings");
    const query = normalizeBookingRouteQuery(
      bookingQuery ?? bookings?.[1] ?? recovery.toString(),
    );
    if (query) authorize.searchParams.set("booking_query", query);
  }
  return authorize.href;
}

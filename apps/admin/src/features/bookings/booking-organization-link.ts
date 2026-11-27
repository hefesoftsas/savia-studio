import {
  buildTenantHostname,
  KNOWN_CANONICAL_HOSTS,
  normalizeCanonicalHost,
  parseTenantSlugFromHostname,
} from "@savia/tenant-host";
import {
  normalizeBookingRouteQuery,
  readBookingRouteQuery,
} from "@savia/tenant-host/bookings-route";

export function isBookingPlatformHost(hostname: string): boolean {
  return KNOWN_CANONICAL_HOSTS.includes(hostname);
}

export function bookingOrganizationPickerHref(
  hostname: string,
  search: string,
) {
  const host = normalizeCanonicalHost(hostname);
  const slug = parseTenantSlugFromHostname(host);
  const platformHost =
    slug &&
    KNOWN_CANONICAL_HOSTS.find(
      (candidate) => buildTenantHostname(slug, candidate) === host,
    );
  const query = normalizeBookingRouteQuery(search, { includeTenantId: false });
  const path = `/#/bookings${query ? `?${query}` : ""}`;
  if (platformHost) return `https://${platformHost}${path}`;
  if (
    !isBookingPlatformHost(host) &&
    readBookingRouteQuery(new URLSearchParams(search)).tenantId !== null
  )
    return path;
}

import {
  buildTenantHostname,
  KNOWN_CANONICAL_HOSTS,
  normalizeCanonicalHost,
  parseTenantSlugFromHostname,
} from "@savia/tenant-host";
import { normalizeBookingRouteQuery } from "@savia/tenant-host/bookings-route";

export function bookingOrganizationPickerHref(
  hostname: string,
  search: string,
) {
  const host = normalizeCanonicalHost(hostname);
  const slug = parseTenantSlugFromHostname(host);
  if (!slug) return undefined;
  const platformHost = KNOWN_CANONICAL_HOSTS.find(
    (candidate) => buildTenantHostname(slug, candidate) === host,
  );
  if (!platformHost) return undefined;
  const query = normalizeBookingRouteQuery(search);
  return `https://${platformHost}/#/bookings${query ? `?${query}` : ""}`;
}

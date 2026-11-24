import { isAllowedTenantOrigin } from "@savia/tenant-host";

export function adminAuthorizeUrl(apiUrl: string, currentUrl: string): string {
  const authorize = new URL("/api/auth/admin/authorize", apiUrl);
  const current = new URL(currentUrl);
  if (current.hash === "#/bookings" && isAllowedTenantOrigin(current.origin)) {
    authorize.searchParams.set("return_to", current.origin);
    authorize.searchParams.set("resume", "bookings");
  }
  return authorize.href;
}

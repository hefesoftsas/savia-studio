import { isAllowedTenantOrigin } from "@savia/tenant-host";
import {
  adminResumeQueryParam,
  readAdminResume,
  type AdminResume,
} from "@savia/tenant-host/admin-resume";

export function adminResumeForPath(
  pathname: unknown,
  search?: unknown,
): AdminResume | undefined {
  const match =
    typeof pathname === "string"
      ? /^\/(bookings|studio|crm)\/*$/i.exec(pathname)
      : null;
  if (!match) return undefined;
  const path = match[1].toLowerCase();
  return readAdminResume(path === "crm" ? "studio" : path, search);
}

export function adminAuthorizeUrl(
  apiUrl: string,
  currentUrl: string,
  destination?: AdminResume,
): string {
  const authorize = new URL("/api/auth/admin/authorize", apiUrl);
  const current = new URL(currentUrl);
  const fragment = /^#(\/[^?]*)(?:\?(.*))?$/.exec(current.hash);
  const recovery = /^\/login\/*$/i.test(fragment?.[1] ?? "")
    ? new URLSearchParams(fragment?.[2])
    : undefined;
  const resume =
    (destination && readAdminResume(destination.route, destination.query)) ??
    adminResumeForPath(fragment?.[1], fragment?.[2]) ??
    readAdminResume(recovery?.get("resume"), recovery?.toString());
  if (resume) {
    if (isAllowedTenantOrigin(current.origin))
      authorize.searchParams.set("return_to", current.origin);
    authorize.searchParams.set("resume", resume.route);
    if (resume.query)
      authorize.searchParams.set(
        adminResumeQueryParam[resume.route],
        resume.query,
      );
  }
  return authorize.href;
}

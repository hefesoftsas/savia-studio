import { normalizeBookingRouteQuery } from "./bookings-route";

export type AdminResumeRoute = "bookings" | "studio";
export type AdminResume = { route: AdminResumeRoute; query: string };

export const adminResumeQueryParam = {
  bookings: "booking_query",
  studio: "studio_query",
} as const satisfies Record<AdminResumeRoute, string>;

const studioViews = new Set([
  "admin",
  "admin-screen",
  "audit",
  "collection-sources",
  "create",
  "designer",
  "edit",
  "import-spreadsheet",
  "integrations",
  "new-object",
  "operations",
  "records",
  "relations",
  "remove-screen",
  "request-page-generator",
  "screen-audit",
  "screen-lookups",
  "screen-public-link",
  "screen-relations",
  "screen-settings",
  "screens",
  "service-credentials",
]);

const studioTabs: Record<string, readonly string[]> = {
  admin: ["screens", "extensions", "packages"],
  "admin-screen": ["screens", "extensions", "packages"],
  "collection-sources": ["vincular", "vinculadas", "sources", "integrations"],
  operations: ["tasks", "import", "automations", "workflows", "reports"],
  screens: ["menu", "screens", "table"],
};

function normalizeStudioRouteQuery(query: string): string {
  const input = new URLSearchParams(query);
  const single = (key: string) => {
    const values = input.getAll(key);
    return values.length === 1 ? values[0] : "";
  };
  const rawTenantId = single("tenantId");
  const tenantId = /^\d{1,16}$/.test(rawTenantId) ? Number(rawTenantId) : NaN;
  const object = single("object");
  const requestedView = single("view");
  const view = studioViews.has(requestedView) ? requestedView : "";
  const tab = single("tab");
  const record = single("record");
  const configure = single("configure");
  const normalized = new URLSearchParams();
  if (Number.isSafeInteger(tenantId))
    normalized.set("tenantId", String(tenantId));
  if (/^[a-z][a-z0-9_]{0,47}$/.test(object)) normalized.set("object", object);
  if (view) normalized.set("view", view);
  if (studioTabs[view]?.includes(tab)) normalized.set("tab", tab);
  if (configure === "form" && (!requestedView || view === "records"))
    normalized.set("configure", "form");
  if (
    normalized.has("tenantId") &&
    normalized.has("object") &&
    (!requestedView || view === "records" || view === "edit") &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(record)
  )
    normalized.set("record", record);
  return normalized.toString();
}

export function isAdminResumeRoute(value: unknown): value is AdminResumeRoute {
  return value === "bookings" || value === "studio";
}

export function readAdminResume(
  route: unknown,
  query?: unknown,
): AdminResume | undefined {
  if (!isAdminResumeRoute(route)) return undefined;
  const raw = typeof query === "string" ? query : "";
  return {
    route,
    query:
      route === "bookings"
        ? normalizeBookingRouteQuery(raw)
        : normalizeStudioRouteQuery(raw),
  };
}

/** Navigation hints only. The callback still requires the server transaction. */
export function readAdminOAuthState(state: string | null) {
  const match = /^[A-Za-z0-9_-]+\.(bookings|studio)(?:\?(.*))?$/.exec(
    state ?? "",
  );
  if (!match) return undefined;
  const resume = readAdminResume(match[1], match[2]);
  if (!resume) return undefined;
  const origins = new URLSearchParams(match[2]).getAll("return_to");
  return {
    ...resume,
    returnOrigin: origins.length === 1 ? origins[0] : undefined,
  };
}

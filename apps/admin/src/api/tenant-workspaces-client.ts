import type { ApiClient } from "./api-client";
import { getSessionReadsPaused } from "@/auth/logout-progress";
import { getSessionGeneration } from "@/auth/session-scope";

export type TenantWorkspace = {
  id: string;
  tenantId: number;
  label: string;
  kind: "platform" | "tenant";
  apiBasePath: string;
};

type WorkspaceCatalog = {
  generation: number;
  pending?: Promise<TenantWorkspace[]>;
  cached?: { data: TenantWorkspace[]; timestamp: number };
};

let catalogs = new WeakMap<ApiClient, WorkspaceCatalog>();

export const STUDIO_TENANTS_CHANGED = "savia-studio-tenants-changed";

export function notifyStudioTenantsChanged(): void {
  window.dispatchEvent(new Event(STUDIO_TENANTS_CHANGED));
}

export function invalidateTenantWorkspaces(): void {
  catalogs = new WeakMap();
}

if (typeof window !== "undefined") {
  window.addEventListener(STUDIO_TENANTS_CHANGED, invalidateTenantWorkspaces);
}

export async function fetchTenantWorkspaces(
  client: ApiClient,
): Promise<TenantWorkspace[]> {
  if (getSessionReadsPaused())
    throw new DOMException("Workspace reads are paused.", "AbortError");
  const generation = getSessionGeneration();
  const previous = catalogs.get(client);
  const catalog =
    previous?.generation === generation ? previous : { generation };
  catalogs.set(client, catalog);
  if (catalog.cached && Date.now() - catalog.cached.timestamp < 30_000) {
    return catalog.cached.data;
  }
  if (catalog.pending) return catalog.pending;

  catalog.pending = client
    .get<{ data: TenantWorkspace[] }>("/v1/tenant-workspaces")
    .then(({ data }) => {
      if (
        getSessionReadsPaused() ||
        getSessionGeneration() !== generation ||
        catalogs.get(client) !== catalog
      )
        throw new DOMException("The workspace catalog changed.", "AbortError");
      catalog.cached = { data, timestamp: Date.now() };
      return data;
    })
    .finally(() => {
      catalog.pending = undefined;
    });
  return catalog.pending;
}

import type { ApiClient } from "@/api/api-client";
import { fetchTenantWorkspaces } from "@/api/tenant-workspaces-client";
import {
  isHubspotCollection,
  matchTenantApiBasePath,
  studioCollectionCount,
} from "@/features/studio/studio-navigation";
import type { MyDayWidget } from "@savia/studio-shared/my-day-widgets";
import type {
  WidgetCollection,
  WidgetCollectionSchema,
  WidgetTenant,
  WidgetRecord,
  WidgetRecordsPage,
  WidgetSummaryGroup,
} from "./types";

export type ObjectsResponse = {
  data: Array<{
    name?: unknown;
    label?: unknown;
    count?: unknown;
    hidden?: unknown;
    config?: {
      fields?: Record<string, { type?: unknown; label?: unknown }>;
      studio?: {
        screen?: { hidden?: unknown };
        requestPage?: unknown;
        business?: unknown;
        collection?: {
          kind?: unknown;
          sourceId?: unknown;
          capabilities?: { sort?: unknown };
        };
      };
    };
  }>;
};

type RecordsResponse = {
  data: WidgetRecord[];
  total?: number;
  nextCursor?: string | null;
  hasNext?: boolean | null;
  pageInfo?: { hasNextPage?: boolean };
};

function normalizeWidgetRecords(
  response: RecordsResponse | null,
): WidgetRecordsPage {
  if (!Array.isArray(response?.data)) {
    throw new Error("Studio API did not return a record page");
  }
  const hasMoreRecords =
    response.pageInfo?.hasNextPage === true ||
    response.hasNext === true ||
    Boolean(response.nextCursor);
  const minimumTotal = response.data.length + (hasMoreRecords ? 1 : 0);
  const total =
    typeof response.total === "number" &&
    Number.isSafeInteger(response.total) &&
    response.total >= minimumTotal
      ? response.total
      : undefined;
  return {
    data: response.data,
    ...(total !== undefined ? { total } : {}),
  };
}

type SummaryResponse = {
  data: Array<{ value?: unknown; count?: unknown; amount?: unknown }>;
  total?: number;
};

function isVisibleObject(row: ObjectsResponse["data"][number]): boolean {
  if (typeof row.name !== "string" || !row.name) return false;
  if (row.hidden === true) return false;
  if (row.config?.studio?.screen?.hidden === true) return false;
  if (row.config?.studio?.requestPage) return false;
  return true;
}

function objectLabel(row: ObjectsResponse["data"][number]): string {
  return typeof row.label === "string" && row.label
    ? row.label
    : String(row.name);
}

export function normalizeCollections(
  apiBasePath: string,
  response: ObjectsResponse,
): WidgetCollection[] {
  return response.data
    .filter(isVisibleObject)
    .map((row) => {
      const count = studioCollectionCount(row.config?.studio, row.count);
      return {
        apiBasePath,
        name: String(row.name),
        label: objectLabel(row),
        ...(count !== undefined ? { count } : {}),
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label, "es"));
}

export function normalizeSchema(
  apiBasePath: string,
  response: ObjectsResponse,
  collection: string,
): WidgetCollectionSchema | undefined {
  const row = response.data.find((candidate) => candidate.name === collection);
  if (!row || !isVisibleObject(row)) return undefined;
  const source = row.config?.studio?.collection;
  const hubspot = isHubspotCollection(source);
  const listOnly = Boolean(source?.kind) && !hubspot;
  const fields = Object.entries(row.config?.fields ?? {})
    .filter(
      (entry): entry is [string, { type?: unknown; label?: unknown }] =>
        typeof entry[1]?.type === "string",
    )
    .map(([name, field]) => ({
      name,
      label:
        typeof field.label === "string" && field.label ? field.label : name,
      type: String(field.type),
    }));
  return {
    apiBasePath,
    name: collection,
    label: objectLabel(row),
    fields,
    ...(hubspot ? { hubspot: true } : {}),
    ...(source?.kind === "crm" || source?.capabilities?.sort === false
      ? { sortSupported: false }
      : {}),
    ...(listOnly ? { summarySupported: false } : {}),
  };
}

function recordsPath(widget: MyDayWidget): string {
  if (!("apiBasePath" in widget) || !("collection" in widget)) {
    throw new Error("System widgets have no records endpoint");
  }
  return `${widget.apiBasePath}/api/records/${encodeURIComponent(widget.collection)}`;
}

export async function listWidgetTenants(
  apiClient: ApiClient,
): Promise<WidgetTenant[]> {
  return await fetchTenantWorkspaces(apiClient);
}

export async function listWidgetCollections(
  apiClient: ApiClient,
  apiBasePath: string,
): Promise<WidgetCollection[]> {
  const response = await apiClient.get<ObjectsResponse>(
    `${apiBasePath}/api/objects`,
  );
  return normalizeCollections(apiBasePath, response);
}

export async function describeWidgetCollection(
  apiClient: ApiClient,
  apiBasePath: string,
  collection: string,
  options?: { signal?: AbortSignal },
): Promise<WidgetCollectionSchema | undefined> {
  const response = await apiClient.get<ObjectsResponse>(
    `${apiBasePath}/api/objects`,
    options,
  );
  return normalizeSchema(apiBasePath, response, collection);
}

export async function listWidgetRecords(
  apiClient: ApiClient,
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>,
  options?: { signal?: AbortSignal; sortSupported?: boolean },
): Promise<WidgetRecordsPage> {
  const limit = widget.config?.limit ?? 5;
  const parameters = new URLSearchParams({
    page: "1",
    perPage: String(limit),
  });
  if (options?.sortSupported !== false) {
    parameters.set("sort", widget.config?.sort ?? "updated_at");
    parameters.set("order", widget.config?.order ?? "DESC");
  }
  const response = await apiClient.get<RecordsResponse>(
    `${recordsPath(widget)}?${parameters}`,
    { signal: options?.signal },
  );
  return normalizeWidgetRecords(response);
}
export async function loadWidgetSummary(
  apiClient: ApiClient,
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>,
  groupField?: string,
  options?: { signal?: AbortSignal },
): Promise<{ total?: number; groups?: WidgetSummaryGroup[] }> {
  const parameters = new URLSearchParams();
  if (groupField) parameters.set("group", groupField);
  if (groupField && widget.config?.amountField)
    parameters.set("amountField", widget.config.amountField);
  const response = await apiClient.get<SummaryResponse>(
    `${recordsPath(widget)}/summary${parameters.size ? `?${parameters}` : ""}`,
    { signal: options?.signal },
  );
  const total = response?.total;
  if (!Array.isArray(response?.data)) return { total };
  const groups: WidgetSummaryGroup[] = [];
  const requiresAmount = Boolean(groupField && widget.config?.amountField);
  for (const row of response.data) {
    if (
      !row ||
      typeof row.count !== "number" ||
      !Number.isSafeInteger(row.count) ||
      row.count < 0 ||
      (requiresAmount &&
        (typeof row.amount !== "number" || !Number.isFinite(row.amount)))
    )
      return { total };
    groups.push({
      value: row.value == null ? "—" : String(row.value),
      count: row.count,
      amount:
        typeof row.amount === "number" && Number.isFinite(row.amount)
          ? row.amount
          : 0,
    });
  }
  return { total, groups };
}

export async function summarizeWidgetRecords(
  apiClient: ApiClient,
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>,
  groupField: string,
  options?: { signal?: AbortSignal },
): Promise<WidgetSummaryGroup[]> {
  const { groups } = await loadWidgetSummary(
    apiClient,
    widget,
    groupField,
    options,
  );
  if (!groups) throw new Error("Collection summary groups are unavailable");
  return groups;
}

export function widgetDeepLink(widget: MyDayWidget): string {
  if (!("apiBasePath" in widget) || !("collection" in widget)) return "/my-day";
  const search = new URLSearchParams();
  const tenantId = matchTenantApiBasePath(widget.apiBasePath);
  if (tenantId !== undefined) search.set("tenantId", tenantId);
  search.set("object", widget.collection);
  // Fase 1: canónica #/studio; #/crm sigue como alias legacy.
  return `/studio?${search.toString()}`;
}

/**
 * Fetches a review window for action widgets: oldest first by the date
 * field so overdue items surface without paging through everything.
 */
export async function listWidgetRecordsForReview(
  apiClient: ApiClient,
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>,
  dateField: string,
  options?: { signal?: AbortSignal },
): Promise<WidgetRecordsPage> {
  const parameters = new URLSearchParams({
    page: "1",
    perPage: "50",
    sort: dateField,
    order: "ASC",
  });
  const response = await apiClient.get<RecordsResponse>(
    `${recordsPath(widget)}?${parameters}`,
    { signal: options?.signal },
  );
  return normalizeWidgetRecords(response);
}

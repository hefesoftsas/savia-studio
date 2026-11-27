import type { DataProvider, GetListParams, GetListResult } from "ra-core";
import type { StudioRecord } from "@savia/studio-shared/metadata";
import { REQUEST_TIMEOUT_MS, withRequestTimeout } from "@/api/request-timeout";
import { readResponseBodyWithInactivityTimeout } from "@/api/response-body-timeout";
import { problemMessage, responseMediaType } from "@/api/response-media-type";
import { getSessionReadsPaused } from "@/auth/logout-progress";
import { getSessionGeneration } from "@/auth/session-scope";
import { recordDeletionPath, recordPath } from "./record-path";
import { retryDeadline } from "@/api/retry-after";
import {
  getStudioRuntime,
  type StudioRuntime,
  type StudioTransport,
} from "./runtime";

function readStudioBody<T>(
  response: Response,
  read: (input: Response) => Promise<T>,
  callerSignal?: AbortSignal | null,
  useDeadline = true,
): Promise<T> {
  const body = response.body;
  if (!body) return read(response);
  const readStream = (signal?: AbortSignal) => {
    const stream = body.pipeThrough(new TransformStream(), { signal });
    return read(new Response(stream, { headers: response.headers }));
  };
  return useDeadline
    ? withRequestTimeout(readStream, REQUEST_TIMEOUT_MS, callerSignal)
    : readStream(callerSignal ?? undefined);
}

export async function apiFetch<T>(
  url: string,
  options?: RequestInit & { responseType?: "blob" },
  transport = studioFetch,
): Promise<T> {
  const { responseType, ...init } = options ?? {};
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await transport(url, {
    ...init,
    headers,
  });
  if (response.status === 204 || response.status === 205) return undefined as T;
  const mediaType = responseMediaType(response);
  if (!response.ok) {
    const retryAt = retryDeadline(response);
    const failure = await readStudioBody(
      response,
      (input) => input.json(),
      init.signal,
    ).catch((error) => {
      if (init.signal?.aborted) throw error;
      return undefined;
    });
    throw Object.assign(
      new Error(
        typeof failure?.error === "string"
          ? failure.error
          : (failure?.error?.message ??
              (mediaType === "application/problem+json"
                ? problemMessage(failure)
                : undefined) ??
              `Error ${response.status}`),
      ),
      {
        status: response.status,
        retryAt,
        code:
          typeof failure?.error?.code === "string"
            ? failure.error.code
            : typeof failure?.code === "string"
              ? failure.code
              : undefined,
        detail: failure,
      },
    );
  }
  if (responseType === "blob")
    return readResponseBodyWithInactivityTimeout(
      response,
      (input) => input.blob() as Promise<T>,
      init.signal,
    );
  if (mediaType === "text/html") {
    void response.body?.cancel().catch(() => undefined);
    throw Object.assign(
      new Error(
        "Studio recibió una página web en lugar de los datos solicitados.",
      ),
      { status: response.status, code: "UNEXPECTED_HTML_RESPONSE" },
    );
  }
  return readStudioBody(
    response,
    (input) => input.json() as Promise<T>,
    init.signal,
  );
}

/** Plugin writes succeed only after the backend commits and returns a version. */
export function pluginApiFetch<T>(
  url: string,
  options?: RequestInit & { responseType?: "blob" },
): Promise<T> {
  const runtime = getStudioRuntime();
  if (runtime.localWorkspace && !runtime.pluginTransport) {
    return Promise.reject(
      new Error("The plugin backend transport is unavailable."),
    );
  }
  return apiFetch<T>(url, options, runtime.pluginTransport ?? studioFetch);
}

export const pluginApi = <T = unknown>(
  url: string,
  method = "GET",
  data?: unknown,
  options?: RequestInit & { responseType?: "blob" },
) =>
  pluginApiFetch<T>("/api" + url, {
    ...options,
    method,
    ...(data === undefined
      ? {}
      : {
          body: data instanceof FormData ? data : JSON.stringify(data),
        }),
  });
function studioRequest(transport?: StudioTransport) {
  return <T = any>(
    url: string,
    method = "GET",
    data?: unknown,
    options?: RequestInit & { responseType?: "blob" },
  ) =>
    apiFetch<T>(
      "/api" + url,
      {
        ...options,
        method,
        ...(data !== undefined
          ? { body: data instanceof FormData ? data : JSON.stringify(data) }
          : {}),
      },
      transport,
    );
}

export const api = studioRequest();

/** Complete a submitted operation against its original tenant and session. */
export function createStudioRequest(runtime = getStudioRuntime()) {
  const sessionGeneration = runtime.sessionGeneration ?? getSessionGeneration();
  return studioRequest(async (url, init) => {
    const sessionChanged = new DOMException(
      "The Studio session changed.",
      "AbortError",
    );
    if (getSessionReadsPaused() || sessionGeneration !== getSessionGeneration())
      throw sessionChanged;
    if (typeof window === "undefined") return studioFetch(url, init, runtime);

    const controller = new AbortController();
    const abort = () => controller.abort(sessionChanged);
    window.addEventListener("savia:principal-changed", abort);
    try {
      return await studioFetch(
        url,
        {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([init.signal, controller.signal])
            : controller.signal,
        },
        runtime,
      );
    } finally {
      window.removeEventListener("savia:principal-changed", abort);
    }
  });
}
// Ephemeral navigation hints only. Records and exact totals remain backend-owned.
let pageCursors = new WeakMap<
  Function,
  Map<string, { cursor: string; expires: number }>
>();
if (typeof window !== "undefined") {
  for (const event of ["savia:principal-changed", "savia:session-cleared"])
    window.addEventListener(event, () => {
      pageCursors = new WeakMap();
    });
}
const list = async (
  resource: string,
  params: GetListParams,
  runtime = getStudioRuntime(),
  request = api,
) => {
  const signal: AbortSignal | undefined = params.signal;
  signal?.throwIfAborted();
  const query = new URLSearchParams({
    page: String(params.pagination?.page ?? 1),
    perPage: String(params.pagination?.perPage ?? 25),
    ...(params.filter?.__collectionSort === false
      ? {}
      : {
          sort: params.sort?.field ?? "updated_at",
          order: params.sort?.order ?? "DESC",
        }),
    ...(params.filter?.__collectionSearch === false
      ? {}
      : {
          q: params.filter?.q ?? "",
          ...(params.filter?.searchField
            ? { searchField: params.filter.searchField }
            : {}),
        }),
    ...(params.filter?.__collectionFilter !== false && params.filter?.stage
      ? { stage: params.filter.stage }
      : {}),
    ...(params.filter?.__collectionFilter !== false && params.filter?.filters
      ? { filters: params.filter.filters }
      : {}),
    ...(params.filter?.trash ? { trash: params.filter.trash } : {}),
  });
  const transport = runtime.transport ?? studioFetch;
  let cursors = pageCursors.get(transport);
  if (!cursors) {
    cursors = new Map();
    pageCursors.set(transport, cursors);
  }
  const page = Number(query.get("page"));
  const scopeQuery = new URLSearchParams(query);
  scopeQuery.delete("page");
  const scope = JSON.stringify([
    runtime.tenantId,
    runtime.apiBasePath,
    resource,
    scopeQuery.toString(),
  ]);
  const key = (number: number) => scope + ":" + number;
  const hint = page > 1 ? cursors.get(key(page)) : undefined;
  if (hint && hint.expires > Date.now()) query.set("cursor", hint.cursor);
  const fetchPage = () =>
    request("/records/" + resource + "?" + query.toString(), "GET", undefined, {
      signal,
    });
  let result;
  try {
    result = await fetchPage();
  } catch (error) {
    signal?.throwIfAborted();
    if (!query.has("cursor") || (error as { status?: number }).status !== 422)
      throw error;
    cursors.delete(key(page));
    query.delete("cursor");
    result = await fetchPage();
  }
  signal?.throwIfAborted();
  // Clear later positions when the first page refreshes after edits or filtering.
  if (page === 1)
    for (const cachedKey of cursors.keys())
      if (cachedKey.startsWith(scope + ":")) cursors.delete(cachedKey);
  if (typeof result.nextCursor === "string") {
    cursors.set(key(page + 1), {
      cursor: result.nextCursor,
      expires: Date.now() + 60000,
    });
    while (cursors.size > 128) cursors.delete(cursors.keys().next().value!);
  } else cursors.delete(key(page + 1));
  return result;
};

export async function listRecordIds(
  resource: string,
  params: Pick<GetListParams, "sort" | "filter" | "signal">,
  runtime: StudioRuntime,
) {
  const request = createStudioRequest(runtime);
  const ids = new Set<string>();
  // This page size is accepted by both Studio storage and external sources.
  const perPage = 100;
  let total: number | undefined;
  for (let page = 1; ; page++) {
    const result: GetListResult<StudioRecord> = await list(
      resource,
      { ...params, pagination: { page, perPage } },
      runtime,
      request,
    );
    if (result.meta?.pageLimitReached) return null;
    if (result.total !== undefined) {
      if (
        !Number.isSafeInteger(result.total) ||
        result.total < 0 ||
        (total !== undefined && total !== result.total)
      )
        return null;
      total = result.total;
    }
    for (const { id } of result.data) {
      if (typeof id !== "string" || !id || ids.has(id)) return null;
      ids.add(id);
    }
    const hasNext =
      result.pageInfo?.hasNextPage ??
      (total === undefined ? result.data.length === perPage : ids.size < total);
    if (!hasNext)
      return total === undefined || ids.size === total ? [...ids] : null;
    if (!result.data.length || (total !== undefined && ids.size >= total))
      return null;
  }
}

export const dataProvider: DataProvider = {
  supportAbortSignal: true,
  getList: (resource, params) => list(resource, params),
  getOne: (resource, params) =>
    api(recordPath(resource, params.id), "GET", undefined, {
      signal: params.signal,
    }),
  getMany: async (resource, params) => ({
    data: await Promise.all(
      params.ids.map((id) =>
        api(recordPath(resource, id), "GET", undefined, {
          signal: params.signal,
        }).then((r) => r.data),
      ),
    ),
  }),
  getManyReference: (resource, params) => list(resource, params),
  create: (resource, params) =>
    api(`/records/${resource}`, "POST", params.data),
  update: (resource, params) =>
    api(recordPath(resource, params.id), "PATCH", {
      ...params.data,
      _version: params.previousData?._version ?? params.data._version,
    }),
  delete: (resource, params) =>
    api(
      recordDeletionPath(resource, params.id, params.previousData?._version),
      "DELETE",
    ),
  updateMany: async (resource, params) => {
    if (!params.meta?.versions)
      throw new Error(
        "La edición masiva requiere las versiones de los registros seleccionados.",
      );
    const result = await api(`/records/${resource}/bulk`, "POST", {
      action: "update",
      records: params.ids.map((id) => ({
        id,
        version: params.meta.versions[id],
      })),
      data: params.data,
    });
    if (result.data.some((row: any) => !row.ok))
      throw new Error(
        result.data
          .filter((row: any) => !row.ok)
          .map((row: any) => row.error)
          .join(" "),
      );
    return { data: params.ids };
  },
  deleteMany: async (resource, params) => {
    if (!params.meta?.versions)
      throw new Error(
        "La eliminación masiva requiere las versiones de los registros seleccionados.",
      );
    const result = await api(`/records/${resource}/bulk`, "POST", {
      action: "delete",
      records: params.ids.map((id) => ({
        id,
        version: params.meta.versions[id],
      })),
    });
    if (result.data.some((row: any) => !row.ok))
      throw new Error(
        result.data
          .filter((row: any) => !row.ok)
          .map((row: any) => row.error)
          .join(" "),
      );
    return { data: params.ids };
  },
};

export function studioFetch(
  url: string,
  init?: RequestInit,
  runtime = getStudioRuntime(),
): Promise<Response> {
  if (runtime.transport) return runtime.transport(url, init);
  if (runtime.embedded)
    return Promise.resolve(
      Response.json({ error: "Abre el CRM desde Savia." }, { status: 401 }),
    );
  return fetch(url, init);
}

export async function downloadCrm(
  url: string,
  name: string,
  expectedType?: "text/csv",
  {
    useBodyDeadline = true,
    signal: callerSignal,
  }: { useBodyDeadline?: boolean; signal?: AbortSignal } = {},
): Promise<boolean> {
  const runtime = getStudioRuntime();
  const generation = runtime.sessionGeneration ?? getSessionGeneration();
  const controller = new AbortController();
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;
  const isCurrent = () =>
    !signal.aborted &&
    !getSessionReadsPaused() &&
    generation === getSessionGeneration();
  if (!isCurrent()) return false;

  const abort = () => controller.abort();
  const stopMonitoringSession = () => {
    window.removeEventListener("savia:principal-changed", abort);
    window.removeEventListener("savia:session-cleared", abort);
  };
  window.addEventListener("savia:principal-changed", abort);
  window.addEventListener("savia:session-cleared", abort);
  signal.addEventListener("abort", stopMonitoringSession, { once: true });
  try {
    const response = await studioFetch(
      url,
      {
        signal,
        ...(expectedType ? { headers: { Accept: expectedType } } : {}),
      },
      runtime,
    );
    if (!isCurrent()) {
      void response.body?.cancel().catch(() => undefined);
      return false;
    }
    const mediaType = responseMediaType(response);
    if (!response.ok) {
      const retryAt = retryDeadline(response);
      const failure = await readStudioBody(
        response,
        (input) => input.json(),
        signal,
      ).catch(() => undefined);
      const message =
        typeof failure?.error === "string"
          ? failure.error
          : failure?.error?.message;
      throw Object.assign(
        new Error(
          typeof message === "string" && message.trim()
            ? message
            : ((mediaType === "application/problem+json"
                ? problemMessage(failure)
                : undefined) ?? "No se pudo descargar el archivo."),
        ),
        { status: response.status, retryAt },
      );
    }
    if (expectedType && mediaType !== expectedType) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("No se recibió un archivo CSV válido.");
    }
    const file = await readStudioBody(
      response,
      (input) => input.blob(),
      signal,
      Boolean(expectedType && useBodyDeadline),
    );
    if (!isCurrent()) return false;
    if (expectedType && !file.size)
      throw new Error("No se recibió un archivo CSV válido.");
    const blob = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = blob;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(blob), 1000);
    return true;
  } catch (error) {
    if (!isCurrent()) return false;
    throw error;
  } finally {
    signal.removeEventListener("abort", stopMonitoringSession);
    stopMonitoringSession();
  }
}

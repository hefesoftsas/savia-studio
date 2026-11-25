import type { DataProvider } from "ra-core";
import { REQUEST_TIMEOUT_MS, withRequestTimeout } from "@/api/request-timeout";
import { problemMessage, responseMediaType } from "@/api/response-media-type";
import { recordPath } from "./record-path";
import { retryDeadline } from "@/api/retry-after";
import { getStudioRuntime } from "./runtime";

function readStudioBody<T>(
  response: Response,
  read: (input: Response) => Promise<T>,
  callerSignal?: AbortSignal | null,
): Promise<T> {
  const body = response.body;
  if (!body) return read(response);
  return withRequestTimeout(
    (signal) => {
      const stream = body.pipeThrough(new TransformStream(), { signal });
      return read(new Response(stream, { headers: response.headers }));
    },
    REQUEST_TIMEOUT_MS,
    callerSignal,
  );
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
  if (responseType === "blob") return (await response.blob()) as T;
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
export const api = <T = any>(
  url: string,
  method = "GET",
  data?: unknown,
  options?: RequestInit & { responseType?: "blob" },
) =>
  apiFetch<T>("/api" + url, {
    ...options,
    method,
    ...(data !== undefined
      ? { body: data instanceof FormData ? data : JSON.stringify(data) }
      : {}),
  });
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
const list = async (resource: string, params: any) => {
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
  const runtime = getStudioRuntime();
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
  const fetchPage = () => api("/records/" + resource + "?" + query.toString());
  let result;
  try {
    result = await fetchPage();
  } catch (error) {
    if (!query.has("cursor") || (error as { status?: number }).status !== 422)
      throw error;
    cursors.delete(key(page));
    query.delete("cursor");
    result = await fetchPage();
  }
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
export const dataProvider: DataProvider = {
  getList: list,
  getOne: (resource, params) => api(recordPath(resource, params.id)),
  getMany: async (resource, params) => ({
    data: await Promise.all(
      params.ids.map((id) => api(recordPath(resource, id)).then((r) => r.data)),
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
      `${recordPath(resource, params.id)}?version=${params.previousData?._version}`,
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
): Promise<Response> {
  const runtime = getStudioRuntime();
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
) {
  const response = await studioFetch(
    url,
    expectedType ? { headers: { Accept: expectedType } } : undefined,
  );
  const mediaType = responseMediaType(response);
  if (!response.ok) {
    const retryAt = retryDeadline(response);
    const failure = await readStudioBody(response, (input) =>
      input.json(),
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
  const file = expectedType
    ? await readStudioBody(response, (input) => input.blob())
    : await response.blob();
  if (expectedType && !file.size)
    throw new Error("No se recibió un archivo CSV válido.");
  const blob = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = blob;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(blob), 1000);
}

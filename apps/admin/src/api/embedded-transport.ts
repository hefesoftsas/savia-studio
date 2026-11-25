import type { ApiClient } from "./api-client";
import { RequestTimeoutError } from "./request-timeout";
import {
  isJsonMediaType,
  problemMessage,
  responseMediaType,
} from "./response-media-type";

const LONG_EXTENSION_REQUEST_PATH =
  /^\/api\/extensions\/[a-z0-9.-]+\/(?:document-analysis|actions\/[a-z0-9._-]+)$/;
const HUBSPOT_INSTALL_PATH = "/api/crm-workspace/install";
const LONG_EMBEDDED_REQUEST_TIMEOUT_MS = 90_000;

/** Validate the route without interpreting URL query values as path segments. */
export function embeddedApiPathname(path: string): string | undefined {
  if (!path.startsWith("/api/") || /[\r\n]/.test(path)) return;
  let pathname = path.split("?", 1)[0];
  try {
    for (let i = 0; i < 4; i++) pathname = decodeURIComponent(pathname);
  } catch {
    return;
  }
  if (pathname.includes("..") || /[\\\r\n]/.test(pathname)) return;
  return pathname;
}

function normalizeEmbeddedError(response: Response, json: unknown): Response {
  const mediaType = responseMediaType(response);
  const body =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};
  const error = body.error;
  const details =
    error && typeof error === "object"
      ? (error as Record<string, unknown>)
      : undefined;
  const message = typeof error === "string" ? error : details?.message;
  const retryAfter = response.headers.get("Retry-After");
  return Response.json(
    {
      ...body,
      ...(typeof details?.code === "string" ? { code: details.code } : {}),
      ...(typeof details?.fileId === "string" &&
      /^[0-9a-f-]{36}$/i.test(details.fileId)
        ? { fileId: details.fileId }
        : {}),
      error:
        typeof message === "string" && message.trim()
          ? message
          : ((mediaType === "application/problem+json"
              ? problemMessage(body)
              : undefined) ?? "No se pudo completar la operación."),
    },
    {
      status: response.status,
      headers: retryAfter ? { "Retry-After": retryAfter } : undefined,
    },
  );
}

export function createEmbeddedTransport(client: ApiClient, prefix: string) {
  return async (path: string, init: RequestInit = {}): Promise<Response> => {
    const pathname = embeddedApiPathname(path);
    if (!pathname)
      return Response.json({ error: "Ruta no permitida." }, { status: 400 });
    let receivedError: Response | undefined;
    try {
      const { body } = await client.requestResponseWithBody(
        prefix + path,
        init,
        async (response) => {
          if (
            response.ok ||
            response.status === 304 ||
            !isJsonMediaType(responseMediaType(response))
          )
            return response;
          receivedError = response;
          const json: unknown = await response.json().catch(() => undefined);
          return normalizeEmbeddedError(response, json);
        },
        (init.method ?? "GET").toUpperCase() === "POST" &&
          (pathname === HUBSPOT_INSTALL_PATH ||
            LONG_EXTENSION_REQUEST_PATH.test(pathname))
          ? LONG_EMBEDDED_REQUEST_TIMEOUT_MS
          : undefined,
      );
      return body;
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if ((error as { name?: string })?.name === "AbortError") throw error;
      if (error instanceof RequestTimeoutError && receivedError)
        return normalizeEmbeddedError(receivedError, undefined);
      return Response.json(
        { error: "No se pudo conectar con Savia. Reintenta." },
        { status: 503 },
      );
    }
  };
}

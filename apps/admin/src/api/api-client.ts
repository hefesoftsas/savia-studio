import {
  REQUEST_TIMEOUT_MS,
  RequestTimeoutError,
  withRequestTimeout,
} from "./request-timeout";
import {
  isJsonMediaType,
  problemMessage,
  responseMediaType,
} from "./response-media-type";
import { retryDeadline } from "./retry-after";

export type AccessTokenSource = {
  getAccessToken(): Promise<string | null>;
};

export type ApiClientOptions = {
  baseUrl: string;
  tokenSource: AccessTokenSource;
  fetcher?: typeof fetch;
};

type ApiErrorEnvelope = {
  error?: string | { code?: string; message?: string };
};

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

function requestUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

async function responseBody(
  response: Response,
  mediaType: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return null;
  if (response.ok && response.body && mediaType === "text/html") {
    void response.body.cancel().catch(() => undefined);
    throw new ApiClientError(
      response.status,
      "UNEXPECTED_HTML_RESPONSE",
      "The API returned a web page instead of data.",
    );
  }
  if (!isJsonMediaType(mediaType)) return null;
  try {
    return await response.json();
  } catch (error) {
    if (response.ok || signal.aborted) throw error;
    return null;
  }
}

function jsonHeaders(headers?: HeadersInit): Headers {
  const result = new Headers(headers);
  if (!result.has("Content-Type"))
    result.set("Content-Type", "application/json");
  return result;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly tokenSource: AccessTokenSource;
  private readonly fetcher: typeof fetch;

  constructor({ baseUrl, tokenSource, fetcher }: ApiClientOptions) {
    this.baseUrl = baseUrl;
    this.tokenSource = tokenSource;
    this.fetcher = fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  async get<T>(path: string, init?: RequestInit): Promise<T> {
    return this.request<T>(path, { ...init, method: "GET" });
  }

  async post<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: jsonHeaders(init?.headers),
    });
  }

  async postForm<T>(
    path: string,
    body: FormData,
    init?: RequestInit,
  ): Promise<T> {
    const headers = new Headers(init?.headers);
    headers.delete("Content-Type");
    return this.request<T>(path, {
      ...init,
      method: "POST",
      body,
      headers,
    });
  }

  async patch<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: "PATCH",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: jsonHeaders(init?.headers),
    });
  }

  async put<T>(path: string, body?: unknown, init?: RequestInit): Promise<T> {
    return this.request<T>(path, {
      ...init,
      method: "PUT",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: jsonHeaders(init?.headers),
    });
  }

  async delete(path: string, init?: RequestInit): Promise<void> {
    await this.request<undefined>(path, { ...init, method: "DELETE" });
  }

  async requestResponse(
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<Response> {
    const { response } = await this.requestResponseWithBody(
      path,
      init,
      async (result) => result,
      timeoutMs,
    );
    return response;
  }

  /** Keeps the request timeout active while consuming the response body. */
  async requestResponseWithBody<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ response: Response; body: T }> {
    const token = await this.getAccessToken(init.signal);
    return withRequestTimeout(
      async (signal) => {
        const response = await this.fetchResponse(path, init, signal, token);
        const body = await consume(response);
        return { response, body };
      },
      timeoutMs,
      init.signal,
    );
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    let rejectedResponse:
      { status: number; statusText: string; retryAt?: number } | undefined;
    try {
      const token = await this.getAccessToken(init.signal);
      return await withRequestTimeout(
        async (signal) => {
          const response = await this.fetchResponse(path, init, signal, token);
          const mediaType = responseMediaType(response);
          const retryAt = retryDeadline(response);
          if (!response.ok)
            rejectedResponse = {
              status: response.status,
              statusText: response.statusText,
              retryAt,
            };
          const body = await responseBody(response, mediaType, signal);
          if (!response.ok) {
            const envelope = body as ApiErrorEnvelope | null;
            const serverError = envelope?.error;
            throw new ApiClientError(
              response.status,
              serverError && typeof serverError === "object"
                ? (serverError.code ?? `HTTP_${response.status}`)
                : `HTTP_${response.status}`,
              typeof serverError === "string"
                ? serverError
                : (serverError?.message ??
                    (mediaType === "application/problem+json"
                      ? problemMessage(body)
                      : undefined) ??
                    (response.statusText || "Request failed")),
              body,
              retryAt,
            );
          }
          return body as T;
        },
        timeoutMs,
        init.signal,
      );
    } catch (error) {
      if (error instanceof RequestTimeoutError) {
        if (rejectedResponse) {
          const { status, statusText, retryAt } = rejectedResponse;
          throw new ApiClientError(
            status,
            `HTTP_${status}`,
            statusText || "Request failed",
            null,
            retryAt,
          );
        }
        throw new ApiClientError(0, "REQUEST_TIMEOUT", error.message, {
          timeoutMs: error.timeoutMs,
        });
      }
      throw error;
    }
  }

  private async fetchResponse(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
    token: string | null,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    if (!headers.has("Accept")) headers.set("Accept", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);

    return this.fetcher(requestUrl(this.baseUrl, path), {
      ...init,
      signal,
      credentials: init.credentials ?? "include",
      headers,
    });
  }

  private getAccessToken(signal?: AbortSignal | null): Promise<string | null> {
    return withRequestTimeout(
      () => this.tokenSource.getAccessToken(),
      REQUEST_TIMEOUT_MS,
      signal,
    );
  }
}

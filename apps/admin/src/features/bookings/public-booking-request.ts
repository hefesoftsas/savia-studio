import { withRequestTimeout } from "@/api/request-timeout";
import { retryDeadline } from "@/api/retry-after";

export type PublicBookingApiError = Error & {
  code?: string;
  status?: number;
  retryAt?: number;
};

export function canRetryPublicBookingLoad(error: unknown) {
  const status = (error as PublicBookingApiError | undefined)?.status;
  return (
    status === undefined || status === 408 || status === 429 || status >= 500
  );
}

export async function publicBookingRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  return withRequestTimeout(
    async (signal) => {
      const response = await fetch(path, {
        ...init,
        headers,
        credentials: "omit",
        signal,
      });
      const body = (await response.json().catch(() => undefined)) as
        | { data?: T; error?: string | { code?: string; message?: string } }
        | undefined;
      if (!response.ok) {
        const error = body?.error;
        throw Object.assign(
          new Error(
            (typeof error === "string" ? error : error?.message) ||
              "Request failed",
          ),
          {
            status: response.status,
            retryAt: retryDeadline(response),
            code: typeof error === "object" ? error?.code : undefined,
          },
        );
      }
      if (body?.data == null)
        throw new Error("Booking response is missing data");
      return body.data;
    },
    undefined,
    init?.signal,
  );
}

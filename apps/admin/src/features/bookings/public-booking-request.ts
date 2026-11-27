import { RequestTimeoutError, withRequestTimeout } from "@/api/request-timeout";
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
  let rejectedResponse: { status: number; retryAt?: number } | undefined;
  const request = withRequestTimeout(
    async (signal) => {
      const response = await fetch(path, {
        ...init,
        headers,
        credentials: "omit",
        signal,
      });
      if (!response.ok)
        rejectedResponse = {
          status: response.status,
          retryAt: retryDeadline(response),
        };
      const body = (await response.json().catch(() => undefined)) as
        | { data?: T; error?: string | { code?: string; message?: string } }
        | undefined;
      if (rejectedResponse) {
        const error = body?.error;
        throw Object.assign(
          new Error(
            (typeof error === "string" ? error : error?.message) ||
              "Request failed",
          ),
          rejectedResponse,
          { code: typeof error === "object" ? error?.code : undefined },
        );
      }
      if (body?.data == null)
        throw new Error("Booking response is missing data");
      return body.data;
    },
    undefined,
    init?.signal,
  );
  try {
    return await request;
  } catch (error) {
    if (error instanceof RequestTimeoutError && rejectedResponse)
      throw Object.assign(
        new Error("Request failed", { cause: error }),
        rejectedResponse,
      );
    throw error;
  }
}

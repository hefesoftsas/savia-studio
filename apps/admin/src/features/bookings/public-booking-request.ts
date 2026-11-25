export type PublicBookingApiError = Error & { code?: string; status?: number };

export async function publicBookingRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "omit" });
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
        code: typeof error === "object" ? error?.code : undefined,
      },
    );
  }
  if (body?.data == null) throw new Error("Booking response is missing data");
  return body.data;
}

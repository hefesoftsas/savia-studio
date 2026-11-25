export function retryDeadline(response: Response): number | undefined {
  if (response.status !== 429) return;
  const retryAfter = response.headers.get("Retry-After")?.trim();
  if (!retryAfter) return;
  const now = Date.now();
  const deadline = /^\d+$/.test(retryAfter)
    ? new Date(now + Number(retryAfter) * 1000).getTime()
    : Date.parse(retryAfter);
  if (deadline > now) return deadline;
}

export function formatRetryTime(
  error: unknown,
  locale: string,
): string | undefined {
  if (!error || typeof error !== "object") return;
  const { status, retryAt } = error as { status?: number; retryAt?: number };
  if (status !== 429 || typeof retryAt !== "number") return;
  const date = new Date(retryAt);
  if (!Number.isFinite(date.getTime())) return;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

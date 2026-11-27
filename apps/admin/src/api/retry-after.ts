export { retryDeadline } from "@savia/studio-shared/retry-after";

export function retryDeadlineFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return;
  const { status, retryAt } = error as { status?: number; retryAt?: number };
  if (status !== 429 || typeof retryAt !== "number") return;
  if (Number.isFinite(new Date(retryAt).getTime())) return retryAt;
}

export function formatRetryTime(
  error: unknown,
  locale: string,
): string | undefined {
  const retryAt = retryDeadlineFromError(error);
  if (retryAt === undefined) return;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(retryAt);
}

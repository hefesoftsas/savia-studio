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

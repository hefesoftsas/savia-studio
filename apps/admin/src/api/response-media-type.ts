export function responseMediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

export function isJsonMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    (mediaType.startsWith("application/") && mediaType.endsWith("+json"))
  );
}

export function problemMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return;
  const { detail, title } = body as { detail?: unknown; title?: unknown };
  if (typeof detail === "string" && detail.trim()) return detail;
  if (typeof title === "string" && title.trim()) return title;
}

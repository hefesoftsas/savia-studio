export function recordPath(collection: string, id: string | number) {
  return `/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
}

export function recordDeletionPath(
  collection: string,
  id: string | number,
  version?: number,
) {
  return `${recordPath(collection, id)}?version=${encodeURIComponent(version ?? "local")}`;
}

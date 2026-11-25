export function recordPath(collection: string, id: string | number) {
  return `/records/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`;
}

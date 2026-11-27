export function daneLookupRequest(city: string, department?: string): Request {
  const url = new URL("https://savia-request.internal/api/lookups/dane");
  url.searchParams.set("city", city);
  if (department !== undefined) url.searchParams.set("department", department);
  return new Request(url, {
    headers: { "content-type": "application/json" },
  });
}

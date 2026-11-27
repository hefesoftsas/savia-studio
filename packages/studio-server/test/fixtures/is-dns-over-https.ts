export function isDnsOverHttpsRequest(input: RequestInfo | URL): boolean {
  try {
    const url =
      input instanceof URL
        ? input
        : new URL(input instanceof Request ? input.url : input);
    return (
      url.origin === "https://cloudflare-dns.com" &&
      url.pathname === "/dns-query"
    );
  } catch {
    return false;
  }
}

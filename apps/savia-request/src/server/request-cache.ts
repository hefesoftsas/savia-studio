import { scopeTenant } from "./tenant";

export type RequestCachePolicy = {
  enabled: boolean;
  ttlSeconds: number;
  scope: "public" | "tenant" | "connection";
};

export type RequestCacheContext = {
  tenant: string;
  revision: string;
  connectionId?: string;
  requestStartedAt?: number;
  validateResponse?: (response: Response) => boolean | Promise<boolean>;
};

type CacheEnvironment = { DB?: D1Database };
type CacheFetcher = (request: Request<any, any>) => Promise<Response>;
type CacheAddress = {
  key: string;
  purgeKey: string | null;
  generation: string;
};
type CacheRow = {
  state: "loading" | "ready";
  response_status: number | null;
  response_status_text: string | null;
  response_headers: string | null;
  response_body: string | null;
  retrieved_at: string | null;
  expires_at: string | null;
  lease_until: string | null;
};
type Snapshot = {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
  retrievedAt: string;
};
type FetchResult =
  | {
      kind: "cached";
      snapshot: Snapshot;
      source: "miss" | "coalesced";
    }
  | { kind: "bypass"; response: Response };

const MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_BODY_BYTES = 1_048_576;
const MAX_HEADER_JSON_BYTES = 16_384;
const LEASE_MS = 35_000;
const MAX_RECLAIM_ATTEMPTS = 3;
const localFlights = new WeakMap<
  D1Database,
  Map<string, Promise<FetchResult>>
>();
let cleanupCounter = 0;

const sensitiveName =
  /token|api.?key|password|passwd|secret|auth|credential|session|cookie|signature|(^|[_-])key([_-]|$)|^key$/i;

export function validateRequestCachePolicy(
  policy: unknown,
): policy is RequestCachePolicy {
  if (!policy || typeof policy !== "object") return false;
  const { enabled, ttlSeconds, scope } = policy as Partial<RequestCachePolicy>;
  return (
    typeof enabled === "boolean" &&
    typeof ttlSeconds === "number" &&
    Number.isInteger(ttlSeconds) &&
    ttlSeconds > 0 &&
    ttlSeconds <= MAX_TTL_SECONDS &&
    (scope === "public" || scope === "tenant" || scope === "connection")
  );
}

export async function cacheRequest(
  env: CacheEnvironment,
  request: Request,
  policy: RequestCachePolicy | undefined,
  context: RequestCacheContext,
  fetcher: CacheFetcher = (input) => fetch(input as RequestInfo),
): Promise<Response> {
  const startedAt = Date.now();
  const report = (response: Response, cacheStatus: string) => {
    const age =
      cacheStatus === "hit" || cacheStatus === "coalesced"
        ? Number(response.headers.get("x-savia-cache-age-ms"))
        : Number.NaN;
    console.log(
      JSON.stringify({
        event: "savia_request_cache",
        scope: policy?.scope ?? "none",
        cache_status: cacheStatus,
        duration_ms: Math.max(0, Date.now() - startedAt),
        cache_age_ms: Number.isFinite(age) ? age : null,
      }),
    );
    return response;
  };
  const bypass = () => {
    return fetchWithoutCache(request, fetcher).then((response) =>
      report(trace(response, "bypass"), "bypass"),
    );
  };
  if (
    !validateRequestCachePolicy(policy) ||
    !policy.enabled ||
    !["GET", "HEAD"].includes(request.method.toUpperCase()) ||
    !context.revision.trim() ||
    (policy.scope !== "public" && !context.tenant.trim()) ||
    (policy.scope === "connection" && !context.connectionId?.trim()) ||
    (policy.scope === "public" && hasSensitivePublicInput(request)) ||
    !env.DB
  )
    return bypass();

  const database = env.DB;
  if (++cleanupCounter % 64 === 0)
    await cleanupExpired(database, new Date().toISOString()).catch(() => {});
  let address: CacheAddress;
  try {
    const tenant =
      policy.scope === "public" ? null : scopeTenant(context.tenant);
    const purgeKey = tenant === null ? null : tenantPurgeKey(tenant);
    const generation = await cacheGeneration(database, purgeKey);
    if (isStaleGeneration(generation, context.requestStartedAt ?? startedAt))
      return bypass();
    address = {
      key: await requestCacheKey(request, policy, context, tenant, generation),
      purgeKey,
      generation,
    };
  } catch {
    return bypass();
  }
  const { key } = address;

  try {
    const row = await readRow(database, key);
    const hit = snapshotFromRow(row);
    if (hit) return report(responseFromSnapshot(hit, "hit"), "hit");
  } catch {
    return bypass();
  }

  let flights = localFlights.get(database);
  if (!flights) {
    flights = new Map();
    localFlights.set(database, flights);
  }
  const running = flights.get(key);
  if (running) {
    try {
      const result = await waitForFlight(running, request.signal);
      if (result.kind === "cached")
        return report(
          responseFromSnapshot(result.snapshot, "coalesced"),
          "coalesced",
        );
    } catch {
      if (request.signal.aborted)
        throw new DOMException("The request was aborted", "AbortError");
      const result = await fetchAndCache(
        database,
        request,
        policy,
        context,
        address,
        fetcher,
      );
      return result.kind === "cached"
        ? report(
            responseFromSnapshot(result.snapshot, result.source),
            result.source,
          )
        : report(trace(result.response, "bypass"), "bypass");
    }
    // An oversized, private, failed, or semantically invalid response cannot
    // be shared as a cache body. Keep each caller's original upstream result.
    return bypass();
  }

  const flight = fetchAndCache(
    database,
    request,
    policy,
    context,
    address,
    fetcher,
  );
  flights.set(key, flight);
  try {
    const result = await flight;
    return result.kind === "cached"
      ? report(
          responseFromSnapshot(result.snapshot, result.source),
          result.source,
        )
      : report(trace(result.response, "bypass"), "bypass");
  } finally {
    if (flights.get(key) === flight) flights.delete(key);
  }
}

function hasSensitivePublicInput(request: Request) {
  const url = new URL(request.url);
  if (url.username || url.password) return true;
  let sensitiveQuery = false;
  url.searchParams.forEach((_value, name) => {
    if (sensitiveName.test(name)) sensitiveQuery = true;
  });
  let sensitiveHeader = false;
  request.headers.forEach((_value, name) => {
    if (sensitiveName.test(name)) sensitiveHeader = true;
  });
  return sensitiveQuery || sensitiveHeader;
}

async function requestCacheKey(
  request: Request,
  policy: RequestCachePolicy,
  context: RequestCacheContext,
  tenant: string | null,
  generation: string,
) {
  const url = new URL(request.url);
  const query: Array<[string, string]> = [];
  url.searchParams.forEach((value, key) => query.push([key, value]));
  // Sort parameter names while preserving the order of repeated values;
  // duplicate parameter order can be meaningful to an upstream API.
  query.sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0));
  url.search = "";
  for (const [key, value] of query) url.searchParams.append(key, value);
  const headers: Array<[string, string]> = [];
  request.headers.forEach((value, name) => headers.push([name, value]));
  headers.sort(([a], [b]) => a.localeCompare(b));
  const keyMaterial = JSON.stringify({
    url: url.toString(),
    method: request.method.toUpperCase(),
    headers,
    revision: context.revision,
    scope: policy.scope,
    tenant,
    connectionId: policy.scope === "connection" ? context.connectionId : null,
    ttlSeconds: policy.ttlSeconds,
    ...(generation ? { generation } : {}),
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyMaterial),
  );
  const hash = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `${tenant ?? "public"}:${hash}`;
}

async function cacheGeneration(database: D1Database, purgeKey: string | null) {
  if (!purgeKey) return "";
  return (
    (await database
      .prepare("SELECT created_at FROM savia_request_cache WHERE cache_key=?")
      .bind(purgeKey)
      .first<string>("created_at")) ?? ""
  );
}

function isStaleGeneration(generation: string, startedAt: number): boolean {
  return generation !== "" && !(Date.parse(generation) < startedAt);
}

export function tenantPurgeKey(tenant: string): string {
  return `purged:${tenant}`;
}

export async function tenantWasPurgedSince(
  database: D1Database,
  tenant: string,
  startedAt: number,
): Promise<boolean> {
  const generation = await cacheGeneration(database, tenantPurgeKey(tenant));
  return isStaleGeneration(generation, startedAt);
}

export function prepareTenantCachePurge(database: D1Database, tenant: string) {
  return [
    database
      .prepare(
        `INSERT INTO savia_request_cache(cache_key,state,created_at) VALUES(?,'ready',?)
       ON CONFLICT(cache_key) DO UPDATE SET created_at=excluded.created_at
       WHERE savia_request_cache.created_at<excluded.created_at`,
      )
      .bind(tenantPurgeKey(tenant), new Date().toISOString()),
    // Earlier versions used opaque SHA-256 keys without recoverable ownership.
    database
      .prepare(
        "DELETE FROM savia_request_cache WHERE cache_key LIKE ? OR length(cache_key)=64",
      )
      .bind(`${tenant}:%`),
  ];
}

async function readRow(database: D1Database, key: string) {
  return database
    .prepare(
      `SELECT state,response_status,response_status_text,response_headers,response_body,
              retrieved_at,expires_at,lease_until
       FROM savia_request_cache WHERE cache_key=?`,
    )
    .bind(key)
    .first<CacheRow>();
}

function snapshotFromRow(row: CacheRow | null): Snapshot | null {
  const expiresAt = row?.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  if (
    !row ||
    row.state !== "ready" ||
    !row.response_status ||
    (!row.response_status_text && row.response_status_text !== "") ||
    !row.response_headers ||
    row.response_body === null ||
    !row.retrieved_at ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  )
    return null;
  try {
    const headers = JSON.parse(row.response_headers) as Array<[string, string]>;
    if (
      !Array.isArray(headers) ||
      !headers.every(
        (header) =>
          Array.isArray(header) &&
          header.length === 2 &&
          header.every((value) => typeof value === "string"),
      )
    )
      return null;
    return {
      status: row.response_status,
      statusText: row.response_status_text,
      headers,
      body: row.response_body,
      retrievedAt: row.retrieved_at,
    };
  } catch {
    return null;
  }
}

async function fetchAndCache(
  database: D1Database,
  request: Request,
  policy: RequestCachePolicy,
  context: RequestCacheContext,
  address: CacheAddress,
  fetcher: CacheFetcher,
): Promise<FetchResult> {
  const token = crypto.randomUUID();
  const { key } = address;
  for (let attempt = 0; ; attempt++) {
    let cacheUnavailable: boolean;
    try {
      if (await claimLease(database, address, token, new Date().toISOString()))
        break;
      cacheUnavailable =
        (await cacheGeneration(database, address.purgeKey)) !==
        address.generation;
    } catch {
      cacheUnavailable = true;
    }
    if (cacheUnavailable)
      return {
        kind: "bypass",
        response: await fetchWithoutCache(request, fetcher),
      };
    if (attempt >= MAX_RECLAIM_ATTEMPTS)
      throw new DOMException(
        "Unable to safely claim this cache entry",
        "TimeoutError",
      );
    const snapshot = await waitForCache(database, key, request.signal);
    if (snapshot) return { kind: "cached", snapshot, source: "coalesced" };
  }

  let response: Response;
  try {
    response = await fetchWithoutCache(request, fetcher);
  } catch (error) {
    await releaseLease(database, key, token).catch(() => {});
    throw error;
  }
  if (!response.ok || !isCacheableResponse(response)) {
    await releaseLease(database, key, token).catch(() => {});
    return { kind: "bypass", response };
  }
  const headers: Array<[string, string]> = [];
  response.headers.forEach((value, name) => {
    if (name !== "x-savia-cache" && name !== "x-savia-cache-age-ms")
      headers.push([name, value]);
  });
  if (
    new TextEncoder().encode(JSON.stringify(headers)).length >
    MAX_HEADER_JSON_BYTES
  ) {
    await releaseLease(database, key, token).catch(() => {});
    return { kind: "bypass", response };
  }
  const bytes = await boundedBody(response.clone());
  if (bytes === null) {
    await releaseLease(database, key, token).catch(() => {});
    return { kind: "bypass", response };
  }
  if (context.validateResponse) {
    try {
      const validationBody =
        bytes.length && ![204, 205, 304].includes(response.status)
          ? bytes.slice()
          : null;
      const validationResponse = new Response(validationBody, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(headers),
      });
      if (!(await context.validateResponse(validationResponse))) {
        await releaseLease(database, key, token).catch(() => {});
        return { kind: "bypass", response };
      }
    } catch {
      await releaseLease(database, key, token).catch(() => {});
      return { kind: "bypass", response };
    }
  }
  const retrievedAt = new Date().toISOString();
  const snapshot: Snapshot = {
    status: response.status,
    statusText: response.statusText,
    headers,
    body: encodeBase64(bytes),
    retrievedAt,
  };
  try {
    const expiresAt = new Date(
      Date.now() + policy.ttlSeconds * 1000,
    ).toISOString();
    await database
      .prepare(
        `UPDATE savia_request_cache
         SET state='ready',response_status=?,response_status_text=?,response_headers=?,response_body=?,
             created_at=?,retrieved_at=?,expires_at=?,lease_token=NULL,lease_until=NULL
         WHERE cache_key=? AND state='loading' AND lease_token=?`,
      )
      .bind(
        snapshot.status,
        snapshot.statusText,
        JSON.stringify(snapshot.headers),
        snapshot.body,
        retrievedAt,
        retrievedAt,
        expiresAt,
        key,
        token,
      )
      .run();
    return { kind: "cached", snapshot, source: "miss" };
  } catch {
    // The fetched response remains available to this caller and any local
    // coalesced callers; never issue a second upstream request on a write fault.
    await releaseLease(database, key, token).catch(() => {});
    return { kind: "cached", snapshot, source: "miss" };
  }
}

async function fetchWithoutCache(request: Request, fetcher: CacheFetcher) {
  if (request.signal.aborted)
    throw new DOMException("The request was aborted", "AbortError");
  return fetcher(request.clone());
}

async function claimLease(
  database: D1Database,
  address: CacheAddress,
  token: string,
  now: string,
) {
  const until = new Date(Date.now() + LEASE_MS).toISOString();
  const { key, purgeKey, generation } = address;
  const generationCheck = purgeKey
    ? "COALESCE((SELECT created_at FROM savia_request_cache WHERE cache_key=?),'')=?"
    : "1=1";
  const generationBindings = purgeKey ? [purgeKey, generation] : [];
  const [updated, inserted] = await database.batch([
    database
      .prepare(
        `UPDATE savia_request_cache SET state='loading',response_status=NULL,response_status_text=NULL,
         response_headers=NULL,response_body=NULL,retrieved_at=NULL,expires_at=NULL,
         lease_token=?,lease_until=?,created_at=?
       WHERE cache_key=? AND ${generationCheck} AND (
         (state='loading' AND lease_until<=?) OR
         (state='ready' AND (
           expires_at<=? OR expires_at IS NULL OR
           response_status IS NULL OR response_status_text IS NULL OR
           response_headers IS NULL OR
           response_body IS NULL OR retrieved_at IS NULL
         ))
       )`,
      )
      .bind(token, until, now, key, ...generationBindings, now, now),
    database
      .prepare(
        `INSERT INTO savia_request_cache(cache_key,state,created_at,lease_token,lease_until)
       SELECT ?,'loading',?,?,? WHERE ${generationCheck} ON CONFLICT(cache_key) DO NOTHING`,
      )
      .bind(key, now, token, until, ...generationBindings),
  ]);
  return updated.meta.changes === 1 || inserted.meta.changes === 1;
}

async function waitForCache(
  database: D1Database,
  key: string,
  signal: AbortSignal,
) {
  if (signal.aborted)
    throw new DOMException("The request was aborted", "AbortError");
  const stopAt = Date.now() + LEASE_MS;
  let interval = 50;
  while (Date.now() < stopAt) {
    await sleep(Math.min(interval, Math.max(1, stopAt - Date.now())), signal);
    if (signal.aborted)
      throw new DOMException("The request was aborted", "AbortError");
    let row: CacheRow | null;
    try {
      row = await readRow(database, key);
    } catch {
      if (signal.aborted)
        throw new DOMException("The request was aborted", "AbortError");
      return null;
    }
    if (signal.aborted)
      throw new DOMException("The request was aborted", "AbortError");
    const snapshot = snapshotFromRow(row);
    if (snapshot) return snapshot;
    if (!row || row.state !== "loading") return null;
    const leaseUntil = row.lease_until
      ? Date.parse(row.lease_until)
      : Number.NaN;
    if (!Number.isFinite(leaseUntil) || leaseUntil <= Date.now()) return null;
    if (Date.now() >= stopAt)
      throw new DOMException(
        "A request for this cache key is still in progress",
        "TimeoutError",
      );
    interval = Math.min(interval * 2, 500);
  }
  if (signal.aborted)
    throw new DOMException("The request was aborted", "AbortError");
  throw new DOMException(
    "A request for this cache key is still in progress",
    "TimeoutError",
  );
}

function waitForFlight<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted)
    return Promise.reject(
      new DOMException("The request was aborted", "AbortError"),
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(new DOMException("The request was aborted", "AbortError"));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    signal.addEventListener("abort", done, { once: true });
  });
}

function isCacheableResponse(response: Response) {
  const cacheControl = response.headers.get("cache-control") ?? "";
  const disallowedCacheControl = cacheControl
    .split(",")
    .some((directive) =>
      /^(?:no-store|private|no-cache)(?:\s*=|$)/i.test(directive.trim()),
    );
  return (
    !response.headers.has("set-cookie") &&
    !disallowedCacheControl &&
    response.headers.get("vary")?.trim() !== "*"
  );
}

async function boundedBody(response: Response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES)
    return null;
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function decodeBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function responseFromSnapshot(
  snapshot: Snapshot,
  status: "hit" | "miss" | "coalesced",
) {
  const headers = new Headers(snapshot.headers);
  headers.set("x-savia-cache", status);
  headers.delete("x-savia-cache-age-ms");
  if (status !== "miss")
    headers.set(
      "x-savia-cache-age-ms",
      String(Math.max(0, Date.now() - Date.parse(snapshot.retrievedAt))),
    );
  const bytes = decodeBase64(snapshot.body);
  return new Response(
    bytes.length && ![204, 205, 304].includes(snapshot.status) ? bytes : null,
    {
      status: snapshot.status,
      statusText: snapshot.statusText,
      headers,
    },
  );
}

function trace(response: Response, status: "miss" | "bypass") {
  const headers = new Headers(response.headers);
  headers.set("x-savia-cache", status);
  headers.delete("x-savia-cache-age-ms");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function releaseLease(database: D1Database, key: string, token: string) {
  await database
    .prepare(
      "DELETE FROM savia_request_cache WHERE cache_key=? AND state='loading' AND lease_token=?",
    )
    .bind(key, token)
    .run();
}

async function cleanupExpired(database: D1Database, now: string) {
  await database
    .prepare(
      `DELETE FROM savia_request_cache WHERE cache_key IN (
         SELECT cache_key FROM savia_request_cache
         WHERE (state='ready' AND expires_at<=?) OR (state='loading' AND lease_until<=?)
         ORDER BY COALESCE(expires_at,lease_until) LIMIT 100
       )`,
    )
    .bind(now, now)
    .run();
}

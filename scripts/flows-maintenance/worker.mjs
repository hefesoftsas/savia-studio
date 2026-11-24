const MAINTENANCE_URL =
  "https://savia-preview.hefesoft.com/api/public/savia-flows/maintenance";
const MAINTENANCE_PATH = "/api/public/savia-flows/maintenance";
const BACKUP_GATE_PREFIX = "/api/_internal/backup-gate/";
const BACKUP_GATE_URL_PREFIX =
  "https://savia-preview.hefesoft.com/api/_internal/backup-gate/";
const BACKUP_GATE_ACTIONS = new Set(["status", "acquire", "renew", "release"]);
const WRITE_LEASE_MODE = "preview-write-lease";
const FORWARDED_CONTROL_HEADER = "x-savia-backup-control-authorization";
const HEALTH_PATH = "/__session/health";
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_WRITE_LEASE_BODY_BYTES = 4096;

function unauthorized() {
  return new Response("Unauthorized", { status: 401 });
}

async function boundedBody(request, maximumBytes = MAX_REQUEST_BYTES) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("Request body is too large");
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new Error("Request body is too large");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      typeof env.SESSION_TOKEN !== "string" ||
      env.SESSION_TOKEN.length < 40 ||
      request.headers.get("authorization") !== `Bearer ${env.SESSION_TOKEN}`
    ) {
      return unauthorized();
    }
    if (
      request.method === "GET" &&
      url.pathname === HEALTH_PATH &&
      !url.search
    ) {
      return Response.json({ ready: true });
    }
    const backupGateAction = url.pathname.startsWith(BACKUP_GATE_PREFIX)
      ? url.pathname.slice(BACKUP_GATE_PREFIX.length)
      : "";
    if (BACKUP_GATE_ACTIONS.has(backupGateAction)) {
      if (
        env.SESSION_MODE !== WRITE_LEASE_MODE ||
        request.method !== "POST" ||
        url.search !== "" ||
        request.headers.get("content-type") !== "application/json"
      ) {
        return new Response("Not found", { status: 404 });
      }
      const controlBearer = request.headers.get(FORWARDED_CONTROL_HEADER);
      if (!/^Bearer \S{32,}$/.test(controlBearer ?? "")) return unauthorized();
      try {
        return await env.SAVIA_HOST.fetch(
          new Request(`${BACKUP_GATE_URL_PREFIX}${backupGateAction}`, {
            method: "POST",
            headers: {
              authorization: controlBearer,
              "content-type": "application/json",
            },
            body: await boundedBody(request, MAX_WRITE_LEASE_BODY_BYTES),
          }),
        );
      } catch {
        return new Response("Preview write lease forwarding failed", {
          status: 503,
        });
      }
    }
    if (
      env.SESSION_MODE === WRITE_LEASE_MODE ||
      request.method !== "POST" ||
      url.pathname !== MAINTENANCE_PATH ||
      url.search !== ""
    ) {
      return new Response("Not found", { status: 404 });
    }

    const headers = new Headers(request.headers);
    headers.delete("authorization");
    try {
      return await env.SAVIA_HOST.fetch(
        new Request(MAINTENANCE_URL, {
          method: "POST",
          headers,
          body: await boundedBody(request),
        }),
      );
    } catch {
      return new Response("Preview maintenance forwarding failed", {
        status: 503,
      });
    }
  },
};

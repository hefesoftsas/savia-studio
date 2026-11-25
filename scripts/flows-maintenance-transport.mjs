import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PUBLIC_ORIGIN,
  PREVIEW_PUBLIC_ORIGIN,
  normalizeEnvironment,
} from "../infra/pulumi/naming.mjs";

const API_PATH = "/api/public/savia-flows/maintenance";
const BACKUP_GATE_PREFIX = "/api/_internal/backup-gate/";
const BACKUP_GATE_ACTIONS = new Set(["status", "acquire", "renew", "release"]);
const SESSION_MODE = "preview-write-lease";
const FORWARDED_CONTROL_HEADER = "x-savia-backup-control-authorization";
const HEALTH_PATH = "/__session/health";
const START_TIMEOUT_MS = 90_000;
const WRITE_LEASE_START_TIMEOUT_MS = 15_000;
const MAX_WRITE_LEASE_BODY_BYTES = 4096;
const POLL_INTERVAL_MS = 500;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_MAIN = resolve(REPO_ROOT, "scripts/flows-maintenance/worker.mjs");

async function reserveLocalPort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a local maintenance port");
  }
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return address.port;
}

function validateTransportCredentials(env) {
  let environment;
  try {
    environment = normalizeEnvironment(env.SAVIA_DEPLOY_ENVIRONMENT);
  } catch {
    throw new Error("Flows maintenance transport environment is invalid");
  }
  if (!/^[a-f\d]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")) {
    throw new Error(`A valid ${environment} CLOUDFLARE_ACCOUNT_ID is required`);
  }
  if (
    typeof env.CLOUDFLARE_API_TOKEN !== "string" ||
    !env.CLOUDFLARE_API_TOKEN
  ) {
    throw new Error(
      `CLOUDFLARE_API_TOKEN is required for ${environment} maintenance`,
    );
  }
  return environment;
}

function createSessionConfig(token, environment, mode) {
  return {
    name: "savia-flows-maintenance-session",
    main: CONFIG_MAIN,
    compatibility_date: "2026-09-01",
    workers_dev: false,
    preview_urls: false,
    vars: {
      SESSION_TOKEN: token,
      ...(mode === SESSION_MODE ? { SESSION_MODE: mode } : {}),
    },
    services: [
      {
        binding: "SAVIA_HOST",
        service:
          environment === "preview"
            ? "savia-agencies-preview"
            : "savia-agencies",
      },
    ],
  };
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    child.once("exit", resolvePromise);
    child.once("error", resolvePromise);
    child.once("close", resolvePromise);
  });
}

async function stopChild(child) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
  }
  const exited = waitForExit(child);
  const graceful = await new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), 5000);
    exited.then(() => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
  if (!graceful) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // The process group may have exited between the timeout and signal.
      }
    }
    await exited;
  }
}

/** Start a private, ephemeral Wrangler session for the selected maintenance API. */
async function startPrivateTransport(
  {
    env = process.env,
    fetchImpl = fetch,
    spawnImpl = spawn,
    createTempDir = (prefix) => mkdtemp(prefix),
    removeTempDir = (path) => rm(path, { recursive: true, force: true }),
    writeConfig = writeFile,
    reservePort = reserveLocalPort,
    sleepImpl = (milliseconds) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
    now = () => Date.now(),
  } = {},
  { mode, startupTimeoutMs },
) {
  const environment = validateTransportCredentials(env);
  const publicOrigin =
    environment === "preview" ? PREVIEW_PUBLIC_ORIGIN : DEFAULT_PUBLIC_ORIGIN;
  const token = randomBytes(32).toString("base64url");
  const port = await reservePort();
  const sessionDir = await createTempDir(
    `${tmpdir()}/savia-flows-maintenance-`,
  );
  await chmod(sessionDir, 0o700);
  const configPath = `${sessionDir}/wrangler.json`;
  let child;
  let closed = false;
  try {
    await writeConfig(
      configPath,
      JSON.stringify(createSessionConfig(token, environment, mode)),
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
    await chmod(configPath, 0o600);
    child = spawnImpl(
      "pnpm",
      [
        "--dir",
        "apps/api",
        "exec",
        "wrangler",
        "dev",
        "--remote",
        "--config",
        configPath,
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "0",
        "--show-interactive-dev-session=false",
      ],
      { cwd: REPO_ROOT, detached: true, stdio: "ignore", env },
    );
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });

    const deadline = now() + startupTimeoutMs;
    let ready = false;
    while (now() < deadline && !exited) {
      try {
        const response = await fetchImpl(
          `http://127.0.0.1:${port}${HEALTH_PATH}`,
          {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(2_000),
            redirect: "error",
          },
        );
        if (response.ok) {
          const payload = await response.json();
          if (payload?.ready === true) {
            ready = true;
            break;
          }
        }
      } catch {
        // Wrangler remote session may still be starting.
      }
      await sleepImpl(POLL_INTERVAL_MS);
    }
    if (!ready || exited) {
      throw new Error("Private preview maintenance session failed to start");
    }

    return {
      async fetchImpl(url, init = {}) {
        const target = new URL(url);
        if (mode === SESSION_MODE) {
          const action = target.pathname.startsWith(BACKUP_GATE_PREFIX)
            ? target.pathname.slice(BACKUP_GATE_PREFIX.length)
            : "";
          const allowedInit = new Set([
            "method",
            "headers",
            "body",
            "signal",
            "redirect",
          ]);
          const headers = new Headers(init.headers);
          const controlBearer = headers.get("authorization");
          const contentType = headers.get("content-type");
          const allowedHeaders = new Set(["authorization", "content-type"]);
          if (
            target.origin !== PREVIEW_PUBLIC_ORIGIN ||
            target.username !== "" ||
            target.password !== "" ||
            !BACKUP_GATE_ACTIONS.has(action) ||
            target.search !== "" ||
            target.hash !== "" ||
            init.method !== "POST" ||
            typeof init.body !== "string" ||
            Buffer.byteLength(init.body, "utf8") > MAX_WRITE_LEASE_BODY_BYTES ||
            contentType !== "application/json" ||
            !/^Bearer \S{32,}$/.test(controlBearer ?? "") ||
            [...headers.keys()].some((name) => !allowedHeaders.has(name)) ||
            Object.keys(init).some((key) => !allowedInit.has(key)) ||
            (init.redirect !== undefined && init.redirect !== "error")
          ) {
            throw new Error(
              "Private Preview write lease transport rejected request",
            );
          }
          const relayHeaders = new Headers({
            authorization: `Bearer ${token}`,
            [FORWARDED_CONTROL_HEADER]: controlBearer,
            "content-type": "application/json",
          });
          return fetchImpl(`http://127.0.0.1:${port}${target.pathname}`, {
            method: "POST",
            headers: relayHeaders,
            body: init.body,
            ...(init.signal ? { signal: init.signal } : {}),
            redirect: "error",
          });
        }
        if (
          target.origin !== publicOrigin ||
          target.pathname !== API_PATH ||
          target.search !== "" ||
          target.hash !== ""
        ) {
          throw new Error("Private maintenance transport rejected destination");
        }
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        return fetchImpl(`http://127.0.0.1:${port}${API_PATH}`, {
          ...init,
          headers,
          redirect: "error",
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        try {
          await stopChild(child);
        } finally {
          await removeTempDir(sessionDir);
        }
      },
    };
  } catch (error) {
    try {
      if (child) await stopChild(child);
    } finally {
      await removeTempDir(sessionDir);
    }
    throw error;
  }
}

export async function startFlowsMaintenanceTransport(options = {}) {
  return startPrivateTransport(options, {
    mode: "flows",
    startupTimeoutMs: START_TIMEOUT_MS,
  });
}

export async function startPreviewMaintenanceTransport(options = {}) {
  const env = options.env ?? process.env;
  if (env.SAVIA_DEPLOY_ENVIRONMENT !== "preview") {
    throw new Error("Private Flows maintenance transport is preview-only");
  }
  return startFlowsMaintenanceTransport(options);
}

export async function startPreviewWriteLeaseTransport(options = {}) {
  const env = options.env ?? process.env;
  if (env.SAVIA_DEPLOY_ENVIRONMENT !== "preview") {
    throw new Error("Private Preview write lease transport is preview-only");
  }
  return startPrivateTransport(options, {
    mode: SESSION_MODE,
    startupTimeoutMs: WRITE_LEASE_START_TIMEOUT_MS,
  });
}

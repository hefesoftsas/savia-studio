import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startPreviewWriteLeaseTransport } from "../flows-maintenance-transport.mjs";
import { PREVIEW_PUBLIC_ORIGIN } from "../../infra/pulumi/naming.mjs";

const cutoff = Date.parse("2026-11-23T21:37:54.097Z");
const expectedCount = 533;
const expectedTimestamps =
  "4acfe58408732aa0dab992e6857b8533dd8cc61d531d1c2b7d776af76d815f01";
const endpoint = `${PREVIEW_PUBLIC_ORIGIN}/api/_internal/backup-gate/status`;
const statusBody = { owner: "preview-permit-cleanup", includePermits: true };

export function selectPermits(status) {
  if (
    status.owner !== null ||
    !Array.isArray(status.permits) ||
    status.active !== status.permits.length ||
    status.permits.some(
      ({ permit, createdAt }) =>
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(permit) ||
        !Number.isSafeInteger(createdAt),
    ) ||
    new Set(status.permits.map(({ permit }) => permit)).size !== status.active
  )
    throw new Error("Unexpected Preview coordinator state");

  const selected = status.permits
    .filter(({ createdAt }) => createdAt <= cutoff)
    .map(({ permit, createdAt }) => ({ permit, createdAt }))
    .sort(
      (a, b) => a.createdAt - b.createdAt || a.permit.localeCompare(b.permit),
    );
  const digest = createHash("sha256")
    .update(
      selected
        .map(
          ({ createdAt }) =>
            `${JSON.stringify(new Date(createdAt).toISOString())}\n`,
        )
        .join(""),
    )
    .digest("hex");
  if (selected.length !== expectedCount || digest !== expectedTimestamps)
    throw new Error("Preview permit inventory differs from the approved set");
  return selected;
}

export async function runCleanup({ action, archive, control, direct }) {
  const live = await control();
  const target = selectPermits(live);
  const directTarget = selectPermits(await direct("/status", statusBody));
  if (JSON.stringify(directTarget) !== JSON.stringify(target))
    throw new Error(
      "The private session does not match the serving Preview coordinator",
    );

  if (action === "archive") {
    await writeFile(archive, JSON.stringify(target), {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Archived ${target.length} matched Preview permits.`);
    return;
  }
  if (action !== "apply") throw new Error("Unsupported cleanup action");
  if (
    JSON.stringify(JSON.parse(await readFile(archive, "utf8"))) !==
    JSON.stringify(target)
  )
    throw new Error("The saved permit inventory no longer matches Preview");

  for (let offset = 0; offset < target.length; offset += 8) {
    const results = await Promise.allSettled(
      target.slice(offset, offset + 8).map(async ({ permit }) => {
        const result = await direct("/leave", { permit });
        if (result.ok !== true)
          throw new Error(
            "The coordinator did not acknowledge a permit release",
          );
      }),
    );
    if (results.some(({ status }) => status === "rejected"))
      throw new Error(
        "A permit release failed. Inspect the encrypted archive and live state before retrying.",
      );
  }
  const remaining = await control();
  const closed = new Set(target.map(({ permit }) => permit));
  if (remaining.permits.some(({ permit }) => closed.has(permit)))
    throw new Error("A selected permit is still open");
  console.log(
    `Verified ${target.length} Preview permits removed; ${remaining.active} permits remain.`,
  );
}

async function main() {
  if (process.env.SAVIA_DEPLOY_ENVIRONMENT !== "preview")
    throw new Error("Preview only");
  const [action, archive, config] = process.argv.slice(2);
  if (action === "configure") {
    const suffix = process.env.GITHUB_RUN_ID;
    if (!/^\d+$/.test(suffix ?? ""))
      throw new Error("Protected GitHub runner required");
    const name = `savia-preview-permit-repair-${suffix}`;
    const vars = { SESSION_TOKEN: randomBytes(32).toString("base64url") };
    await writeFile(
      archive,
      JSON.stringify({
        name,
        main: fileURLToPath(new URL("./worker.mjs", import.meta.url)),
        compatibility_date: "2026-09-01",
        workers_dev: false,
        preview_urls: false,
        vars,
        durable_objects: {
          bindings: [
            {
              name: "PREVIEW_GATE",
              class_name: "BackupCoordinator",
              script_name: "savia-backup-coordinator-preview",
            },
          ],
        },
      }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      config,
      JSON.stringify({
        name: `${name}-session`,
        main: fileURLToPath(new URL("./forwarder.mjs", import.meta.url)),
        compatibility_date: "2026-09-01",
        workers_dev: false,
        preview_urls: false,
        services: [{ binding: "SAVIA_REPAIR", service: name }],
      }),
      { flag: "wx", mode: 0o600 },
    );
    return;
  }

  const { vars } = JSON.parse(await readFile(config, "utf8"));
  async function read(fetchImpl, url, authorization, body) {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: `Bearer ${authorization}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(`Coordinator check failed (HTTP ${response.status})`);
    return response.json();
  }
  const direct = (path, body) =>
    read(fetch, `http://127.0.0.1:18877${path}`, vars.SESSION_TOKEN, body);
  let ready = false;
  for (let attempt = 0; attempt < 20 && !ready; attempt++) {
    try {
      await direct("/status", statusBody);
      ready = true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!ready)
    throw new Error(
      "The direct Preview coordinator session could not be verified",
    );
  const transport = await startPreviewWriteLeaseTransport();
  try {
    await runCleanup({
      action,
      archive,
      direct,
      control: () =>
        read(
          transport.fetchImpl,
          endpoint,
          process.env.SAVIA_BACKUP_CONTROL_SECRET,
          statusBody,
        ),
    });
  } finally {
    await transport.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

import { fileURLToPath } from "node:url";
import { PREVIEW_PUBLIC_ORIGIN } from "../infra/pulumi/naming.mjs";
import { startPreviewWriteLeaseTransport } from "./flows-maintenance-transport.mjs";
import { inspectBackupGateStatus } from "./inspect-production-backup-gate.mjs";

export async function inspectPreviewBackupGate({
  env = process.env,
  startTransport = startPreviewWriteLeaseTransport,
  writeOutput = (value) => process.stdout.write(value),
} = {}) {
  let transport;
  try {
    transport = await startTransport({ env });
    return await inspectBackupGateStatus({
      endpoint: `${PREVIEW_PUBLIC_ORIGIN}/api/_internal/backup-gate/status`,
      owner: "preview-backup-gate-diagnostic",
      env,
      fetchImpl: transport.fetchImpl,
      writeOutput,
    });
  } finally {
    await transport?.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  inspectPreviewBackupGate()
    .then((result) => {
      if (result.status !== "ok") process.exitCode = 1;
    })
    .catch(() => {
      process.stdout.write(
        '{"status":"error","error":"preview_inspection_failed"}\n',
      );
      process.exitCode = 1;
    });
}

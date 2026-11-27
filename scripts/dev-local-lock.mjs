import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const directory = join(tmpdir(), `savia-local-${process.getuid()}`);
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = new DatabaseSync(join(directory, "stack.sqlite"));
try {
  // A kernel-backed lock releases even if the launcher exits unexpectedly.
  lock.exec("BEGIN IMMEDIATE");
} catch (error) {
  lock.close();
  if (error.code !== "ERR_SQLITE_ERROR" || error.errcode !== 5) throw error;
  console.error(
    "A local Savia stack is already starting or running. Stop it before starting another stack.",
  );
  process.exit(1);
}

try {
  const launcher = spawn(
    "sh",
    [
      fileURLToPath(new URL("./dev-local.sh", import.meta.url)),
      "--with-local-lock",
    ],
    { detached: true, stdio: "inherit" },
  );
  let stopping = false;
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (stopping || !launcher.pid) return;
      stopping = true;
      try {
        // The shell may be waiting on a foreground build or migration.
        process.kill(-launcher.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    });
  const [code, signal] = await once(launcher, "exit");
  process.exitCode = code ?? (signal ? 128 + constants.signals[signal] : 1);
} finally {
  lock.close();
}

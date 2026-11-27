import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  prepareVscodeDownload,
  vscodeDownloadFilename,
} from "./lib/prepare-vscode-download.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vscode = join(repo, "apps/vscode");
const manifestPath = join(vscode, "extension/package.json");
const filename = await vscodeDownloadFilename(manifestPath);
const publicDirectory =
  process.env.SAVIA_ADMIN_PUBLIC_DIR || join(repo, "apps/admin/public");
const directory = await mkdtemp(join(tmpdir(), "savia-admin-vsix-"));
try {
  const stage = join(directory, "stage");
  execFileSync(
    process.execPath,
    [join(vscode, "scripts/build.mjs"), "--stage", stage],
    { stdio: "inherit" },
  );
  execFileSync(
    process.execPath,
    [
      join(vscode, "scripts/package.mjs"),
      "--stage",
      stage,
      "--out",
      join(directory, filename),
    ],
    { stdio: "inherit" },
  );
  await prepareVscodeDownload({
    manifestPath,
    artifactsDir: directory,
    downloadsDir: join(publicDirectory, "downloads"),
  });
  console.log(`Prepared /downloads/${filename} for the admin asset build.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

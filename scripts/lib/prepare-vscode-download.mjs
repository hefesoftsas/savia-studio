import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";

export function isVersionedVscodeDownload(name) {
  return /^savia-plugin-authoring-.*\.vsix(?:\.sha256)?$/.test(name);
}

export async function vscodeDownloadFilename(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    throw new Error("VS Code extension manifest has an invalid version.");
  }
  return `savia-plugin-authoring-${manifest.version}.vsix`;
}

export async function prepareVscodeDownload({
  manifestPath,
  artifactsDir,
  downloadsDir,
}) {
  const filename = await vscodeDownloadFilename(manifestPath);
  const artifact = join(artifactsDir, filename);
  const checksumFile = `${artifact}.sha256`;
  const artifactBytes = await fs.readFile(artifact);
  const expectedChecksum = createHash("sha256")
    .update(artifactBytes)
    .digest("hex");
  const recordedChecksum = (await fs.readFile(checksumFile, "utf8")).trim();
  const publishedChecksum = `${expectedChecksum} *${filename}`;

  if (
    recordedChecksum !== publishedChecksum &&
    recordedChecksum !== `${expectedChecksum} ${filename}`
  ) {
    throw new Error(`VSIX checksum is missing or invalid for ${filename}.`);
  }

  await fs.mkdir(downloadsDir, { recursive: true });
  const artifactTarget = join(downloadsDir, filename);
  const checksumTarget = `${artifactTarget}.sha256`;
  const stagingDir = await fs.mkdtemp(join(downloadsDir, ".savia-vsix-"));
  try {
    const stagedArtifact = join(stagingDir, filename);
    const stagedChecksum = `${stagedArtifact}.sha256`;
    await fs.writeFile(stagedArtifact, artifactBytes);
    await fs.writeFile(stagedChecksum, `${publishedChecksum}\n`);

    const previousArtifact = join(stagingDir, "previous.vsix");
    let hadPreviousArtifact = true;
    try {
      await fs.copyFile(artifactTarget, previousArtifact);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hadPreviousArtifact = false;
    }

    await fs.rename(stagedArtifact, artifactTarget);
    try {
      await fs.rename(stagedChecksum, checksumTarget);
    } catch (error) {
      if (hadPreviousArtifact)
        await fs.rename(previousArtifact, artifactTarget);
      else await fs.rm(artifactTarget, { force: true });
      throw error;
    }

    for (const entry of await fs.readdir(downloadsDir)) {
      if (
        entry !== filename &&
        entry !== `${filename}.sha256` &&
        isVersionedVscodeDownload(entry)
      ) {
        await fs.rm(join(downloadsDir, entry), { force: true });
      }
    }
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true });
  }
  return { filename, checksum: expectedChecksum };
}

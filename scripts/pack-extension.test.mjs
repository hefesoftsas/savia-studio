import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = fileURLToPath(
  new URL("./pack-extension.mjs", import.meta.url),
);
const sdkPackageRoot = join(workspaceRoot, "packages", "plugin-sdk");

test("empaqueta la pantalla React y un manifiesto de release verificable", () => {
  const artifactsDirectory = join(workspaceRoot, "dist", "extensions");
  mkdirSync(artifactsDirectory, { recursive: true });
  const outputDirectory = mkdtempSync(
    join(artifactsDirectory, ".savia-extension-test-"),
  );
  const extensionRoot = sdkPackageRoot;
  const directoryName = "plugin-sdk";
  const sourceDirectory = join(extensionRoot, "src");
  const temporaryFiles = [
    join(extensionRoot, "savia-extension.json"),
    join(sourceDirectory, "admin.ts"),
    join(sourceDirectory, "mcp.ts"),
    join(sourceDirectory, "screens", "policies.tsx"),
  ];
  const outputPath = join(outputDirectory, "portfolio.zip");

  try {
    assert.ok(
      temporaryFiles.every((path) => !existsSync(path)),
      "synthetic extension fixture paths must be absent before the test",
    );
    mkdirSync(join(sourceDirectory, "screens"), { recursive: true });
    writeFileSync(
      join(extensionRoot, "savia-extension.json"),
      JSON.stringify({
        format: "savia.extension",
        formatVersion: 1,
        id: "example.portfolio",
        version: "1.0.0",
        label: "Example portfolio",
        description: "A public sample extension.",
        requires: [],
        apiVersion: 1,
      }),
    );
    writeFileSync(
      join(sourceDirectory, "admin.ts"),
      'export { render } from "./screens/policies";\n',
    );
    writeFileSync(
      join(sourceDirectory, "mcp.ts"),
      "export {};\n",
    );
    writeFileSync(
      join(sourceDirectory, "screens", "policies.tsx"),
      'import React from "react";\nexport function render() { return <main>Example portfolio</main>; }\n',
    );
    writeFileSync(join(outputDirectory, "stale.txt"), "stale artifact");
    execFileSync("zip", ["-q", outputPath, "stale.txt"], {
      cwd: outputDirectory,
    });

    const output = execFileSync(
      process.execPath,
      [scriptPath, directoryName, "--output", outputPath],
      { cwd: workspaceRoot, encoding: "utf8" },
    );

    assert.match(output, /example\.portfolio@1\.0\.0/);
    assert.match(output, /SHA-256: [a-f0-9]{64}/);
    assert.equal(existsSync(outputPath), true);

    const archiveEntries = execFileSync("unzip", ["-Z1", outputPath], {
      encoding: "utf8",
    });
    assert.match(archiveEntries, /^src\/screens\/policies\.tsx$/m);
    assert.match(archiveEntries, /^savia-extension\.json$/m);
    assert.match(archiveEntries, /^release\.json$/m);
    assert.doesNotMatch(archiveEntries, /^stale\.txt$/m);

    const release = JSON.parse(
      execFileSync("unzip", ["-p", outputPath, "release.json"], {
        encoding: "utf8",
      }),
    );
    assert.equal(release.packageName, "@savia/plugin-sdk");
    assert.equal(release.manifest.id, "example.portfolio");
    assert.deepEqual(release.entryPoints, ["src/admin.ts", "src/mcp.ts"]);
    const reactSource = execFileSync(
      "unzip",
      ["-p", outputPath, "src/screens/policies.tsx"],
      { encoding: "utf8" },
    );
    assert.match(reactSource, /<main>Example portfolio<\/main>/);
    assert.equal(readFileSync(outputPath).length > 0, true);
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
    for (const path of temporaryFiles) rmSync(path, { force: true });
    rmSync(join(sourceDirectory, "screens"), { force: true, recursive: true });
  }
});

test("rechaza enlaces simbólicos antes de crear el artefacto", () => {
  const directoryName = `extension-link-test-${Date.now()}`;
  const extensionRoot = join(workspaceRoot, "packages", directoryName);
  const sourceDirectory = join(extensionRoot, "src");
  const externalFile = join(
    workspaceRoot,
    "dist",
    "extensions",
    `${directoryName}-external.txt`,
  );

  try {
    mkdirSync(sourceDirectory, { recursive: true });
    writeFileSync(
      join(extensionRoot, "savia-extension.json"),
      JSON.stringify({
        format: "savia.extension",
        formatVersion: 1,
        id: "test.symbolic-link",
        version: "1.0.0",
        label: "Test symbolic link",
        description: "Test-only extension package.",
        requires: [],
        apiVersion: 1,
      }),
    );
    writeFileSync(
      join(extensionRoot, "package.json"),
      JSON.stringify({ name: "@savia/test-symbolic-link" }),
    );
    writeFileSync(join(extensionRoot, "tsconfig.json"), "{}");
    writeFileSync(join(sourceDirectory, "index.ts"), "export {};\n");
    writeFileSync(externalFile, "must never enter the archive");
    symlinkSync(externalFile, join(sourceDirectory, "external.ts"));

    const result = spawnSync(process.execPath, [scriptPath, directoryName], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /enlaces simbólicos/);
  } finally {
    rmSync(extensionRoot, { force: true, recursive: true });
    rmSync(externalFile, { force: true });
  }
});

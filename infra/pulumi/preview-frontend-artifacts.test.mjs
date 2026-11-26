import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  restorePreviewFrontendArtifact,
  stagePreviewFrontendArtifact,
} from "./preview-frontend-artifacts.mjs";

const execFileAsync = promisify(execFile);
const env = {
  CI: "true",
  NODE_ENV: "production",
  SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL:
    "https://savia-plugin-editor-preview.example.workers.dev",
  VITE_PUBLIC_LABEL: "Preview",
  NOT_PUBLIC: "excluded",
};

async function git(root, ...args) {
  return execFileAsync("git", args, { cwd: root, encoding: "utf8" });
}

async function clearGeneratedOutputs(root) {
  await rm(join(root, "apps/admin/dist"), { recursive: true, force: true });
  await rm(join(root, "apps/admin/dist-plugin-editor"), {
    recursive: true,
    force: true,
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "savia-preview-assets-"));
  const root = join(directory, "repo");
  const artifact = join(directory, "artifact", "frontend");
  await mkdir(join(root, "apps/admin/dist"), { recursive: true });
  await mkdir(join(root, "apps/admin/dist/assets"), { recursive: true });
  await mkdir(join(root, "apps/admin/dist-plugin-editor"), {
    recursive: true,
  });
  await mkdir(join(root, "apps/admin/src"), { recursive: true });
  await writeFile(join(root, "apps/admin/src/index.ts"), "export {};\n");
  await writeFile(
    join(root, "apps/admin/dist/index.html"),
    "<main>Admin</main>\n",
  );
  await writeFile(
    join(root, "apps/admin/dist/assets/app.js"),
    "globalThis.savia = true;\n",
  );
  await mkdir(join(root, "apps/admin/dist-plugin-editor"), {
    recursive: true,
  });
  await writeFile(
    join(root, "apps/admin/dist-plugin-editor/plugin-editor.html"),
    "<main>Editor</main>\n",
  );
  await git(root, "init", "--quiet");
  await git(root, "config", "user.name", "Savia tests");
  await git(root, "config", "user.email", "savia-tests@example.invalid");
  await git(root, "add", "apps/admin/src/index.ts");
  await git(root, "commit", "--quiet", "-m", "fixture");
  const { stdout: revision } = await git(root, "rev-parse", "HEAD");
  const { stdout: tree } = await git(root, "rev-parse", "HEAD^{tree}");
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    root,
    artifact,
    directory: artifact,
    repository: "hefesoftsas/savia-studio",
    revision: revision.trim(),
    tree: tree.trim(),
    pnpmVersion: "11.24.0",
  };
}

test("Preview warmup isolates both frontend builds and stages the matching proof", async (t) => {
  const input = await fixture(t);
  const bin = join(input.root, "test-bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "pnpm"),
    `#!/bin/sh
case "$*" in
  "--version") printf '11.24.0\\n' ;;
  "--filter @savia/admin run build:assets"|"--filter @savia/admin run build:plugin-editor")
    test "$SAVIA_ADMIN_IGNORE_ENV_FILES" = true ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  const script = fileURLToPath(
    new URL("../../scripts/warm-preview-frontend.mjs", import.meta.url),
  );
  const output = join(input.root, "workflow-output");
  const warmupEnv = {
    ...process.env,
    PATH: [bin, process.env.PATH].join(delimiter),
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: input.revision,
    GITHUB_REPOSITORY: input.repository,
    GITHUB_OUTPUT: output,
    PREVIEW_PUSH_BASE: input.revision,
    PREVIEW_PLUGIN_EDITOR_ORIGIN: env.SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL,
    SAVIA_ADMIN_IGNORE_ENV_FILES: "false",
  };
  await execFileAsync(process.execPath, [script, input.artifact], {
    cwd: input.root,
    env: warmupEnv,
  });
  assert.equal(await readFile(output, "utf8"), "ready=true\n");
  await clearGeneratedOutputs(input.root);
  await restorePreviewFrontendArtifact({
    ...input,
    env: {
      ...warmupEnv,
      SAVIA_ADMIN_IGNORE_ENV_FILES: "true",
      SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL:
        warmupEnv.PREVIEW_PLUGIN_EDITOR_ORIGIN,
      VITE_PLUGIN_EDITOR_RUNTIME_URL: `${warmupEnv.PREVIEW_PLUGIN_EDITOR_ORIGIN}/plugin-editor`,
    },
  });
});

test("stages and restores the exact public Preview frontend outputs", async (t) => {
  const input = await fixture(t);
  await stagePreviewFrontendArtifact({ ...input, env });

  assert.deepEqual((await readdir(input.artifact)).sort(), [
    "admin",
    "manifest.json",
    "plugin-editor",
  ]);
  const manifest = JSON.parse(
    await readFile(join(input.artifact, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.version, 1);
  assert.equal(manifest.repository, input.repository);
  assert.equal(manifest.revision, input.revision);
  assert.equal(manifest.tree, input.tree);
  assert.equal(manifest.nodeVersion, process.version);
  assert.equal(manifest.pnpmVersion, input.pnpmVersion);
  assert.equal(typeof manifest.buildEnvironmentSha256, "string");
  assert.equal(manifest.files.length, 3);
  assert.equal(JSON.stringify(manifest).includes(env.VITE_PUBLIC_LABEL), false);
  assert.equal(JSON.stringify(manifest).includes(env.NOT_PUBLIC), false);

  await clearGeneratedOutputs(input.root);
  await restorePreviewFrontendArtifact({
    ...input,
    env: {
      VITE_PUBLIC_LABEL: "Preview",
      NOT_PUBLIC: "different ignored value",
      SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL:
        "https://savia-plugin-editor-preview.example.workers.dev",
      CI: "true",
      NODE_ENV: "production",
    },
  });

  assert.equal(
    await readFile(join(input.root, "apps/admin/dist/index.html"), "utf8"),
    "<main>Admin</main>\n",
  );
  assert.equal(
    await readFile(
      join(input.root, "apps/admin/dist-plugin-editor/plugin-editor.html"),
      "utf8",
    ),
    "<main>Editor</main>\n",
  );
});

test("rejects a mismatched release identity before installing outputs", async (t) => {
  const input = await fixture(t);
  await stagePreviewFrontendArtifact({ ...input, env });
  await clearGeneratedOutputs(input.root);

  await assert.rejects(
    restorePreviewFrontendArtifact({
      ...input,
      revision: "f".repeat(40),
      env,
    }),
    /metadata|revision|identity/i,
  );
  await assert.rejects(lstat(join(input.root, "apps/admin/dist")), {
    code: "ENOENT",
  });
});

test("rejects changed public build inputs and altered artifact files", async (t) => {
  const input = await fixture(t);
  await stagePreviewFrontendArtifact({ ...input, env });
  await clearGeneratedOutputs(input.root);
  await assert.rejects(
    restorePreviewFrontendArtifact({
      ...input,
      env: { ...env, VITE_PUBLIC_LABEL: "Other" },
    }),
    /metadata|environment|input/i,
  );
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, pnpmVersion: "11.24.1", env }),
    /metadata/i,
  );

  await writeFile(join(input.artifact, "admin/assets/app.js"), "changed\n");
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /hash|digest|integrity|changed/i,
  );
  await rm(join(input.artifact, "admin/assets"), { recursive: true });
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /match|missing|manifest/i,
  );
  await assert.rejects(lstat(join(input.root, "apps/admin/dist")), {
    code: "ENOENT",
  });
});

test("rebuilds Preview frontend assets when the Flows build setting changes", async (t) => {
  const input = await fixture(t);
  const enabled = { ...env, SAVIA_CI_FLOWS_ENABLED: "true" };
  await stagePreviewFrontendArtifact({ ...input, env: enabled });
  await clearGeneratedOutputs(input.root);

  await assert.rejects(
    restorePreviewFrontendArtifact({
      ...input,
      env: { ...env, SAVIA_CI_FLOWS_ENABLED: "false" },
    }),
    /metadata does not match/,
  );
  await assert.rejects(lstat(join(input.root, "apps/admin/dist")), {
    code: "ENOENT",
  });
  await restorePreviewFrontendArtifact({ ...input, env: enabled });
});

test("rejects an artifact compiled with a different dotenv policy", async (t) => {
  const input = await fixture(t);
  const isolated = { ...env, SAVIA_ADMIN_IGNORE_ENV_FILES: "true" };
  await stagePreviewFrontendArtifact({ ...input, env: isolated });
  await clearGeneratedOutputs(input.root);
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /metadata does not match/,
  );
  await restorePreviewFrontendArtifact({ ...input, env: isolated });
});

test("rejects symlinks and unexpected artifact files", async (t) => {
  const input = await fixture(t);
  await stagePreviewFrontendArtifact({ ...input, env });
  await clearGeneratedOutputs(input.root);
  await symlink("/etc/passwd", join(input.artifact, "admin/unexpected"));
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /symbolic|symlink|unexpected|file/i,
  );
  await rm(join(input.artifact, "admin/unexpected"));
  await writeFile(join(input.artifact, "extra.txt"), "unexpected\n");
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /unexpected|artifact|entry/i,
  );
  await rm(join(input.artifact, "extra.txt"));
  await mkdir(join(input.artifact, "admin/empty"));
  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /unexpected|directory/i,
  );
  await assert.rejects(lstat(join(input.root, "apps/admin/dist")), {
    code: "ENOENT",
  });
});

test("refuses to overwrite pre-existing generated output", async (t) => {
  const input = await fixture(t);
  await stagePreviewFrontendArtifact({ ...input, env });
  const existing = join(input.root, "apps/admin/dist");

  await assert.rejects(
    restorePreviewFrontendArtifact({ ...input, env }),
    /exist|overwrite|destination/i,
  );
  assert.equal(
    await readFile(join(existing, "index.html"), "utf8"),
    "<main>Admin</main>\n",
  );
});

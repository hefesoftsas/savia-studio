import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { promisify } from "node:util";
import { stagePreviewFrontendArtifact } from "../infra/pulumi/preview-frontend-artifacts.mjs";
import { validateDeploymentUrl } from "./configure-plugin-editor-preview.mjs";
import { needsPreviewFrontendBuild } from "./preview-code-release.mjs";

const run = promisify(execFile);
const env = process.env;
const root = process.cwd();
const directory = process.argv[2];

try {
  const git = async (args) =>
    (await run("git", args, { cwd: root })).stdout.trim();
  const revision = await git(["rev-parse", "HEAD"]);
  if (
    env.GITHUB_EVENT_NAME !== "push" ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_SHA !== revision ||
    !directory ||
    !env.GITHUB_OUTPUT
  )
    throw new Error("Exact main push required");

  const needed = await needsPreviewFrontendBuild({
    base: env.PREVIEW_PUSH_BASE,
    head: revision,
    cwd: root,
    run,
  });
  if (directory === "--plan") {
    await appendFile(env.GITHUB_OUTPUT, `needed=${needed}\n`);
  } else if (!needed) {
    await appendFile(env.GITHUB_OUTPUT, "ready=false\n");
  } else {
    const origin = validateDeploymentUrl(
      env.PREVIEW_PLUGIN_EDITOR_ORIGIN,
    ).origin;
    const buildEnv = {
      ...env,
      SAVIA_ADMIN_IGNORE_ENV_FILES: "true",
      SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL: origin,
      VITE_PLUGIN_EDITOR_RUNTIME_URL: `${origin}/plugin-editor`,
    };
    const builds = await Promise.allSettled(
      ["build:assets", "build:plugin-editor"].map((script) =>
        run("pnpm", ["--filter", "@savia/admin", "run", script], {
          cwd: root,
          env: buildEnv,
          maxBuffer: 32 * 1024 * 1024,
        }),
      ),
    );
    if (builds.some(({ status }) => status === "rejected"))
      throw new Error("Preview frontend build failed");
    await stagePreviewFrontendArtifact({
      root,
      directory,
      repository: env.GITHUB_REPOSITORY,
      revision,
      tree: await git(["rev-parse", "HEAD^{tree}"]),
      pnpmVersion: (
        await run("pnpm", ["--version"], { cwd: root })
      ).stdout.trim(),
      env: buildEnv,
    });
    await appendFile(env.GITHUB_OUTPUT, "ready=true\n");
  }
} catch {
  console.error("Unable to prebuild Preview frontend assets.");
  process.exitCode = 1;
}

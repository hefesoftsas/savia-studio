import { execFile } from "node:child_process";
import { appendFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { derivePreviewCodeScope } from "./preview-code-release.mjs";

const run = promisify(execFile);
const env = process.env;
const sha = env.APPROVED_SHA;
const repository = env.GITHUB_REPOSITORY;
const workflow = ".github/workflows/preview-frontend-warmup.yml";

async function fetchWarmFrontend() {
  if (
    !/^[a-f\d]{40}$/.test(sha ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") ||
    !env.GITHUB_OUTPUT ||
    !env.RUNNER_TEMP ||
    !env.GH_TOKEN
  )
    return;
  const cwd = process.cwd();
  if ((await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim() !== sha)
    return;
  const scope = await derivePreviewCodeScope({
    base: env.SAVIA_PREVIEW_RELEASE_BASE,
    head: sha,
    cwd,
    run,
  });
  if (scope && !scope.targets.includes("gateway")) return;

  const api = async (path) =>
    JSON.parse(
      (
        await run("gh", ["api", `repos/${repository}/actions/${path}`], {
          timeout: 5000,
        })
      ).stdout,
    );
  const { workflow_runs: runs } = await api(
    `workflows/preview-frontend-warmup.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=5`,
  );
  const candidate = runs.find(
    (entry) =>
      entry.event === "push" &&
      entry.path === workflow &&
      entry.head_branch === "main" &&
      entry.head_sha === sha &&
      entry.repository?.full_name === repository &&
      entry.head_repository?.full_name === repository,
  );
  if (
    candidate?.status !== "completed" ||
    candidate.conclusion !== "success" ||
    !Number.isSafeInteger(candidate.id) ||
    candidate.id < 1
  )
    return;

  const name = `preview-frontend-${sha}`;
  const { artifacts } = await api(
    `runs/${candidate.id}/artifacts?per_page=100`,
  );
  const matching = artifacts.filter(
    (artifact) =>
      artifact.name === name &&
      artifact.expired === false &&
      artifact.workflow_run?.id === candidate.id &&
      artifact.workflow_run?.head_sha === sha &&
      artifact.workflow_run?.head_branch === "main",
  );
  if (matching.length !== 1) return;
  const directory = await mkdtemp(
    join(env.RUNNER_TEMP, "preview-warmed-frontend-"),
  );
  await run(
    "gh",
    [
      "run",
      "download",
      String(candidate.id),
      "--repo",
      repository,
      "--name",
      name,
      "--dir",
      directory,
    ],
    { timeout: 20000 },
  );
  await appendFile(env.GITHUB_OUTPUT, `directory=${directory}\n`);
}

try {
  await fetchWarmFrontend();
} catch {
  console.log(
    "Preview frontend artifact unavailable. Release preparation will build from source.",
  );
}

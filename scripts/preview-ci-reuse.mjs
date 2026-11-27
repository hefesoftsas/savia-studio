import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const sha = /^[0-9a-f]{40}$/;
const appPath =
  /^(apps|packages)\/[\w/-]+\/(src|test)\/[\w./-]+\.(?:[cm]?[jt]sx?|css)$/;
const pulumiScriptPath = /^infra\/pulumi\/[\w-]+(?:\.test)?\.mjs$/;
const authInitializerPath =
  /^scripts\/initialize-auth-deployment(?:\.test)?\.mjs$/;
const localLauncherPath = /^scripts\/dev-local(?:\.sh|\.test\.mjs|-lock\.mjs)$/;
const docsPath = /^(?:README|docs\/[\w./-]+)\.md$/;
const reusablePaths = [
  appPath,
  pulumiScriptPath,
  authInitializerPath,
  localLauncherPath,
  docsPath,
];
const adminBuildPaths = new Set([
  "apps/admin/build/flows-plugin.ts",
  "apps/admin/build/offline-shell-assets.test.ts",
  "apps/admin/build/offline-shell-assets.ts",
  "apps/admin/build/preview-build.test.ts",
  "apps/admin/vite.config.ts",
  "apps/admin/vite.plugin-editor.config.ts",
]);
const adminBuildJobs = [
  ...Array.from(
    { length: 6 },
    (_, index) => `Admin unit tests (shard ${index + 1}/6)`,
  ),
  "Type-check (Core & Apps)",
];

export function previewMergeProofName(pull, base, tree, flowsDisabled = false) {
  return `Preview CI proof ${pull} ${base} ${tree}${flowsDisabled ? " (Flows skipped)" : ""}`;
}

export async function canReusePreviewCi({
  base,
  commit,
  repository,
  flowsDisabled = false,
  request,
  git,
}) {
  if (![base, commit].every((value) => sha.test(value ?? ""))) return false;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) return false;

  try {
    const [revision, firstParent] = (
      await git(["rev-list", "--parents", "-n", "1", commit])
    )
      .trim()
      .split(" ");
    if (revision !== commit || firstParent !== base) return false;

    const paths = (
      await git([
        "diff",
        "--name-only",
        "-z",
        "--no-renames",
        base,
        commit,
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean);
    if (
      !paths.length ||
      !paths.every(
        (path) =>
          adminBuildPaths.has(path) ||
          reusablePaths.some((scope) => scope.test(path)),
      )
    )
      return false;
    const tree = (await git(["rev-parse", `${commit}^{tree}`])).trim();
    if (!sha.test(tree)) return false;

    const prefix = `/repos/${repository}`;
    const pulls = await request(`${prefix}/commits/${commit}/pulls`);
    const matching = pulls.filter(
      (pull) =>
        pull.merged_at &&
        Number.isSafeInteger(pull.number) &&
        pull.merge_commit_sha === commit &&
        pull.base?.ref === "main" &&
        pull.base.repo?.full_name === repository &&
        pull.head?.repo?.full_name === repository &&
        sha.test(pull.head?.sha ?? ""),
    );
    if (matching.length !== 1) return false;
    const {
      number,
      head: { sha: head },
    } = matching[0];
    const { workflow_runs: runs } = await request(
      `${prefix}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${head}&per_page=5`,
    );
    // The newest matching run controls this head. A failed or in-flight re-run
    // may not be replaced with evidence from an older successful attempt.
    const run = runs.find(
      (row) =>
        row.event === "pull_request" &&
        row.path === ".github/workflows/ci.yml" &&
        row.head_sha === head &&
        row.repository?.full_name === repository &&
        row.head_repository?.full_name === repository,
    );
    if (
      run?.status !== "completed" ||
      run.conclusion !== "success" ||
      !Number.isSafeInteger(run.id) ||
      !Number.isSafeInteger(run.run_attempt)
    )
      return false;
    const { jobs } = await request(
      `${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    );
    const requiredJobs = ["Contract suite", "Contract tests"];
    if (paths.some((path) => adminBuildPaths.has(path)))
      requiredJobs.push(...adminBuildJobs);
    for (const name of requiredJobs) {
      const matches = jobs.filter((job) => job.name === name);
      if (
        matches.length !== 1 ||
        matches[0].status !== "completed" ||
        matches[0].conclusion !== "success"
      )
        return false;
    }
    const classifiers = jobs.filter(
      (job) => job.name === "Classify affected work",
    );
    if (classifiers.length !== 1 || classifiers[0].conclusion !== "success")
      return false;
    const proof =
      classifiers[0].steps?.filter(
        (step) =>
          step.name ===
          previewMergeProofName(number, base, tree, flowsDisabled),
      ) ?? [];
    return (
      proof.length === 1 &&
      proof[0].status === "completed" &&
      proof[0].conclusion === "success"
    );
  } catch {
    return false;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [base, commit] = process.argv.slice(2);
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
  const reuse =
    GITHUB_TOKEN && GITHUB_API_URL
      ? await canReusePreviewCi({
          base,
          commit,
          repository: GITHUB_REPOSITORY,
          flowsDisabled: process.env.SAVIA_CI_FLOWS_ENABLED === "false",
          git: async (args) => (await exec("git", args)).stdout,
          request: async (path) => {
            const response = await fetch(GITHUB_API_URL + path, {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${GITHUB_TOKEN}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
              signal: AbortSignal.timeout(3500),
            });
            if (!response.ok) throw new Error("CI evidence unavailable");
            return response.json();
          },
        })
      : false;
  console.log(String(reuse));
}

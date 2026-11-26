import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReusePreviewCi,
  previewMergeProofName,
} from "./preview-ci-reuse.mjs";

const repo = "team/savia";
const base = "a".repeat(40);
const commit = "b".repeat(40);
const head = "c".repeat(40);
const tree = "d".repeat(40);
const pull = {
  number: 42,
  merged_at: "2026-01-01T00:00:00Z",
  merge_commit_sha: commit,
  base: { ref: "main", repo: { full_name: repo } },
  head: { sha: head, repo: { full_name: repo } },
};
const run = {
  id: 91,
  run_attempt: 2,
  event: "pull_request",
  path: ".github/workflows/ci.yml",
  head_sha: head,
  repository: { full_name: repo },
  head_repository: { full_name: repo },
  status: "completed",
  conclusion: "success",
};
const proofName = `Preview CI proof 42 ${base} ${tree}`;
const classifier = (name = proofName, conclusion = "success") => ({
  name: "Classify affected work",
  conclusion: "success",
  steps: [{ name, conclusion, status: "completed" }],
});
const contractJobs = ["Contract suite", "Contract tests"].map((name) => ({
  name,
  status: "completed",
  conclusion: "success",
}));
const adminBuildJobs = [
  ...Array.from(
    { length: 6 },
    (_, index) => `Admin unit tests (shard ${index + 1}/6)`,
  ),
  "Type-check (Core & Apps)",
].map((name) => ({ name, status: "completed", conclusion: "success" }));

function check({
  parents = commit + " " + base,
  paths = "apps/api/src/assistant/service.ts\0apps/mcp/src/server.ts\0",
  pulls = [pull],
  runs = [run],
  jobs = [classifier()],
  contracts = contractJobs,
  flowsDisabled = false,
  request = async (path) => {
    if (path === `/repos/${repo}/commits/${commit}/pulls`) return pulls;
    if (path.startsWith(`/repos/${repo}/actions/workflows/ci.yml/runs?`))
      return { workflow_runs: runs };
    if (path === `/repos/${repo}/actions/runs/91/attempts/2/jobs?per_page=100`)
      return { jobs: [...jobs, ...contracts] };
    assert.fail(`Unexpected API request ${path}`);
  },
} = {}) {
  return canReusePreviewCi({
    base,
    commit,
    repository: repo,
    flowsDisabled,
    request,
    git: async (args) => {
      if (args[0] === "rev-list") return parents;
      if (args[0] === "rev-parse") return tree;
      if (args[0] === "diff") return paths;
      assert.fail(`Unexpected git arguments ${args}`);
    },
  });
}

test("reuses successful CI for the exact base and merge tree from a same-repo PR", async () => {
  assert.equal(previewMergeProofName(42, base, tree), proofName);
  assert.equal(await check(), true);
});

test("only reuses PR validation with the same Flows configuration", async () => {
  const jobs = [classifier(`${proofName} (Flows skipped)`)];
  assert.equal(await check({ jobs }), false);
  assert.equal(await check({ flowsDisabled: true }), false);
  assert.equal(await check({ flowsDisabled: true, jobs }), true);
});

test("reuses the exact merge-tree proof for covered Pulumi source and tests", async () => {
  assert.equal(
    await check({
      paths:
        "infra/pulumi/backup.mjs\0infra/pulumi/backup.test.mjs\0docs/guides/preview-release-lanes.md\0",
    }),
    true,
  );
});

test("reuses successful PR validation for mixed application and release tooling changes", async () => {
  assert.equal(
    await check({
      paths: [
        "apps/api/src/external-crm/hubspot-workspace.ts",
        "apps/api/test/hubspot-workspace.test.ts",
        "infra/pulumi/runtime-timing.mjs",
        "scripts/initialize-auth-deployment.mjs",
        "scripts/initialize-auth-deployment.test.mjs",
        "docs/guides/preview-release-lanes.md",
      ].join("\0"),
      flowsDisabled: true,
      jobs: [classifier(`${proofName} (Flows skipped)`)],
    }),
    true,
  );
});

test("reuses exact CI proof for named Admin build paths after all Admin checks pass", async () => {
  const paths = [
    "apps/admin/vite.config.ts",
    "apps/admin/vite.plugin-editor.config.ts",
    "apps/admin/build/flows-plugin.ts",
    "apps/admin/build/offline-shell-assets.ts",
    "apps/admin/build/offline-shell-assets.test.ts",
    "apps/admin/build/preview-build.test.ts",
    "apps/admin/src/components/admin/layout.tsx",
    "docs/guides/preview-release-lanes.md",
  ].join("\0");
  assert.equal(
    await check({ paths, jobs: [classifier(), ...adminBuildJobs] }),
    true,
  );

  for (const required of adminBuildJobs) {
    const jobs = [
      classifier(),
      ...adminBuildJobs.filter((job) => job !== required),
    ];
    assert.equal(await check({ paths, jobs }), false, required.name);
  }
  assert.equal(
    await check({
      paths,
      jobs: [
        classifier(),
        ...adminBuildJobs.slice(0, -1),
        { ...adminBuildJobs.at(-1), conclusion: "skipped" },
      ],
    }),
    false,
  );
});

test("falls back when the push, PR, or tested tree cannot be proved", async () => {
  for (const scenario of [
    { parents: commit + " " + "e".repeat(40) },
    { paths: ".github/workflows/ci.yml\0" },
    {
      paths: "apps/admin/vite.config.ts\0apps/admin/package.json\0",
      jobs: [classifier(), ...adminBuildJobs],
    },
    {
      paths: "apps/admin/vite.config.ts\0apps/admin/vitest.config.ts\0",
      jobs: [classifier(), ...adminBuildJobs],
    },
    {
      paths: "apps/admin/build/unreviewed-build.ts\0",
      jobs: [classifier(), ...adminBuildJobs],
    },
    { paths: "packages/db/migrations/0099_new.sql\0" },
    { paths: "infra/pulumi/backup.mjs\0infra/pulumi/Pulumi.preview.yaml\0" },
    { paths: "infra/pulumi/backup.mjs\0infra/pulumi/package-lock.json\0" },
    { paths: "infra/pulumi/backup.mjs\0scripts/preview-ci-reuse.mjs\0" },
    {
      paths:
        "apps/api/src/runtime.ts\0infra/pulumi/backup.mjs\0scripts/upload-cloudflare-secrets.mjs\0",
    },
    {
      paths:
        "apps/api/src/runtime.ts\0scripts/initialize-auth-deployment.mjs\0pnpm-lock.yaml\0",
    },
    { pulls: [] },
    { pulls: [{ ...pull, number: 43 }] },
    { pulls: [{ ...pull, merge_commit_sha: head }] },
    {
      pulls: [
        { ...pull, head: { ...pull.head, repo: { full_name: "fork/savia" } } },
      ],
    },
    { runs: [{ ...run, event: "workflow_dispatch" }] },
    { runs: [{ ...run, conclusion: "failure" }] },
    { runs: [{ ...run, status: "in_progress", conclusion: null }, run] },
    { jobs: [classifier(proofName.replace(tree, head))] },
    { jobs: [classifier(proofName, "skipped")] },
    { jobs: [{ ...classifier(), name: "Other job" }] },
    { contracts: [contractJobs[1]] },
    {
      contracts: [
        contractJobs[0],
        { ...contractJobs[1], conclusion: "skipped" },
      ],
    },
    {
      request: async () => {
        throw new Error("GitHub unavailable");
      },
    },
  ]) {
    assert.equal(await check(scenario), false, JSON.stringify(scenario));
  }
});

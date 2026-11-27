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
const hostedPinPath = "deployment/hosted-plugins.json";
const hostedPinJobs = [
  ...adminBuildJobs,
  ...[
    "API unit tests (shard 1/3)",
    "API unit tests (shard 2/3)",
    "API unit tests (shard 3/3)",
    "Workspace unit tests (Core packages)",
    "Workspace unit tests (Studio server 1/2)",
    "Workspace unit tests (Studio server 2/2)",
  ].map((name) => ({ name, status: "completed", conclusion: "success" })),
];
const flowsJobs = [
  "Flows API tests",
  "Flows API tests (shard 2/2)",
  "Flows core tests",
  "Flows package tests",
  "Flows types and recovery",
  "Flows runtime and preview readiness",
].map((name) => ({ name, status: "completed", conclusion: "success" }));
const validPins = {
  [base]: { mode: "100644", json: '{"revision":"' + "e".repeat(40) + '"}' },
  [commit]: { mode: "100644", json: '{"revision":"' + "f".repeat(40) + '"}' },
};

function check({
  parents = commit + " " + base,
  paths = "apps/api/src/assistant/service.ts\0apps/mcp/src/server.ts\0",
  pulls = [pull],
  runs = [run],
  jobs = [classifier()],
  contracts = contractJobs,
  pins = validPins,
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
      if (args[0] === "ls-tree") {
        const ref = args.at(-3);
        assert.equal(args.at(-1), hostedPinPath);
        return pins[ref]
          ? `${pins[ref].mode} blob ${"1".repeat(40)}\t${hostedPinPath}\n`
          : "";
      }
      if (args[0] === "show") {
        const [ref, path] = args[1].split(":");
        assert.equal(path, hostedPinPath);
        return pins[ref].json;
      }
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

test("reuses exact PR validation for local development changes", async () => {
  const paths = [
    "README.md",
    "apps/admin/build/preview-build.test.ts",
    "apps/admin/vite.config.ts",
    "scripts/dev-local.sh",
    "scripts/dev-local-lock.mjs",
    "scripts/dev-local.test.mjs",
  ].join("\0");
  const jobs = [classifier(`${proofName} (Flows skipped)`), ...adminBuildJobs];
  assert.equal(await check({ paths, jobs, flowsDisabled: true }), true);
  assert.equal(
    await check({
      paths,
      jobs,
      flowsDisabled: true,
      contracts: [contractJobs[1]],
    }),
    false,
  );
  assert.equal(
    await check({
      paths: paths + "\0scripts/another-local-command.sh",
      jobs,
      flowsDisabled: true,
    }),
    false,
  );
});

test("reuses CI for a hosted revision update after the PR passes every full check", async () => {
  const paths = `${hostedPinPath}\0apps/admin/src/features/assistant/assistant-bar.tsx\0`;
  const proof = classifier(`${proofName} (Flows skipped)`);
  const jobs = [proof, ...hostedPinJobs];
  assert.equal(await check({ paths, jobs, flowsDisabled: true }), true);

  for (const job of hostedPinJobs) {
    assert.equal(
      await check({
        paths,
        jobs: jobs.filter((candidate) => candidate !== job),
        flowsDisabled: true,
      }),
      false,
      job.name,
    );
  }
  assert.equal(
    await check({
      paths,
      jobs: [...jobs, hostedPinJobs[0]],
      flowsDisabled: true,
    }),
    false,
  );
  assert.equal(
    await check({
      paths: `${paths}.github/workflows/ci.yml\0`,
      jobs,
      flowsDisabled: true,
    }),
    false,
  );
  assert.equal(
    await check({ paths, jobs: [classifier(), ...hostedPinJobs] }),
    false,
  );
  assert.equal(
    await check({
      paths,
      jobs: [classifier(), ...hostedPinJobs, ...flowsJobs],
    }),
    true,
  );
  for (const job of flowsJobs) {
    assert.equal(
      await check({
        paths,
        jobs: [classifier(), ...hostedPinJobs, ...flowsJobs].map((candidate) =>
          candidate === job ? { ...job, conclusion: "skipped" } : candidate,
        ),
      }),
      false,
      job.name,
    );
  }
});

test("hosted revision reuse requires the expected manifests on both regular files", async () => {
  const paths = `${hostedPinPath}\0`;
  const jobs = [classifier(`${proofName} (Flows skipped)`), ...hostedPinJobs];
  assert.equal(await check({ paths, jobs, flowsDisabled: true }), true);

  for (const pin of [
    { mode: "120000", json: validPins[commit].json },
    { mode: "100644", json: '{"revision":"main"}' },
    {
      mode: "100644",
      json: '{"revision":"' + "f".repeat(40) + '","extra":true}',
    },
    { mode: "100644", json: "null" },
  ]) {
    for (const ref of [base, commit]) {
      assert.equal(
        await check({
          paths,
          jobs,
          flowsDisabled: true,
          pins: { ...validPins, [ref]: pin },
        }),
        false,
      );
    }
  }
  assert.equal(
    await check({
      paths,
      jobs,
      flowsDisabled: true,
      pins: { [base]: validPins[base] },
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

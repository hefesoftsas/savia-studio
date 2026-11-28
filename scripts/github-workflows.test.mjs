import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateContractGate } from "./contract-check-gate.mjs";

test("required contract gate CLI rejects invalid input and a cancelled suite", () => {
  for (const input of [
    "{",
    JSON.stringify({
      changes: {
        result: "success",
        outputs: { kind: "platform", ci_kind: "full" },
      },
      "contract-suite": { result: "cancelled" },
    }),
  ]) {
    const result = spawnSync(
      process.execPath,
      ["scripts/contract-check-gate.mjs"],
      {
        input,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 1);
  }
});

function workflow(name) {
  return readFile(
    new URL(`../.github/workflows/${name}`, import.meta.url),
    "utf8",
  );
}

test("Pulumi helper tests install the API runtime dependencies from the frozen workspace", async () => {
  const pulumi = await workflow("pulumi.yml");
  const unit = pulumi.slice(
    pulumi.indexOf("  unit:\n"),
    pulumi.indexOf("\n  preview:"),
  );

  assert.match(
    unit,
    /uses: pnpm\/action-setup@v5\.0\.0\s+with:\s+version: 11\.24\.0/,
  );
  assert.match(
    unit,
    /pnpm install --frozen-lockfile --filter @savia\/api\.\.\./,
  );
  assert.ok(
    unit.indexOf("pnpm install --frozen-lockfile --filter @savia/api...") <
      unit.indexOf("Run Pulumi helper tests"),
  );
  assert.match(pulumi, /^  runtime-compatibility:\n/m);
  assert.match(pulumi, /^  preview:\n/m);
});

test("mixed frontend and assistant CI requires the union of existing checks", async () => {
  const admin = [
    "admin",
    "admin-2",
    "admin-3",
    "admin-4",
    "admin-5",
    "admin-6",
  ];
  const api = ["api", "api-2", "api-3", "api-extra-shards"];
  const jobs = [
    ...admin,
    ...api,
    "runtime-profile",
    "assistant-mcp",
    "contract-suite",
  ];
  const checks = Object.fromEntries(
    jobs.map((job) => [job, { result: "success" }]),
  );
  const needs = {
    ...checks,
    changes: {
      result: "success",
      outputs: { kind: "platform", ci_kind: "frontend-assistant-api" },
    },
  };
  assert.deepEqual(evaluateContractGate(needs), []);
  for (const job of jobs)
    assert.ok(
      evaluateContractGate({ ...needs, [job]: { result: "failure" } }).length,
      job,
    );

  const ci = await workflow("ci.yml");
  const adminJobs = ci.slice(ci.indexOf("  admin:"), ci.indexOf("  api:"));
  assert.equal([...adminJobs.matchAll(/frontend-assistant-api/g)].length, 6);
  const apiJobs = ci.slice(
    ci.indexOf("  api:"),
    ci.indexOf("  runtime-profile:"),
  );
  assert.ok([...apiJobs.matchAll(/frontend-assistant-api/g)].length >= 8);
  assert.match(ci, /assistant-api\|frontend-assistant-api\)/);
});

test("Preview frontend warmup runs from main without deployment credentials", async () => {
  const [warmup, deploy] = await Promise.all([
    workflow("preview-frontend-warmup.yml"),
    workflow("deploy-preview.yml"),
  ]);
  assert.match(warmup, /push:\s*\n\s*branches: \[main\]/);
  assert.match(warmup, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(warmup, /permissions:\s*\n\s*contents: read/);
  assert.match(
    warmup,
    /SAVIA_CI_FLOWS_ENABLED: \$\{\{ vars\.SAVIA_CI_FLOWS_ENABLED \}\}/,
  );
  assert.doesNotMatch(warmup, /secrets\.|deployments: write|^\s+environment:/m);
  assert.match(warmup, /run: node scripts\/warm-preview-frontend\.mjs --plan/);
  assert.match(
    warmup,
    /SAVIA_PREVIEW_HOSTED_FRONTEND_REVISION: \$\{\{ vars\.SAVIA_PREVIEW_HOSTED_FRONTEND_REVISION \}\}/,
  );
  const planIndex = warmup.indexOf(
    "run: node scripts/warm-preview-frontend.mjs --plan",
  );
  assert.ok(planIndex < warmup.indexOf("uses: pnpm/action-setup"));
  assert.ok(planIndex < warmup.indexOf("cache: pnpm"));
  assert.match(
    warmup,
    /name: Set up pnpm\s+if: \$\{\{ steps\.plan\.outputs\.needed == 'true' \}\}\s+uses: pnpm\/action-setup/,
  );
  assert.match(
    warmup,
    /name: Restore pnpm store\s+if: \$\{\{ steps\.plan\.outputs\.needed == 'true' \}\}/,
  );
  assert.match(
    warmup,
    /name: Install dependencies\s+if: \$\{\{ steps\.plan\.outputs\.needed == 'true' \}\}\s+run: pnpm install --frozen-lockfile/,
  );
  assert.match(
    warmup,
    /name: Prepare frontend assets from the exact main revision\s+if: \$\{\{ steps\.plan\.outputs\.needed == 'true' \}\}/,
  );
  const runtime = deploy.slice(deploy.indexOf("  deploy:\n"));
  assert.match(runtime, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(
    runtime,
    /SAVIA_PREVIEW_FRONTEND_ARTIFACT_DIR: \$\{\{ steps\.warmed_frontend\.outputs\.directory \}\}/,
  );
});

test("frontend CI runs all Admin shards and typechecking before the required gate", async () => {
  const ci = await workflow("ci.yml");
  const admin = ci.slice(ci.indexOf("  admin:"), ci.indexOf("  api:"));
  assert.equal([...admin.matchAll(/ci_kind == 'frontend'/g)].length, 6);
  const profile = ci.slice(
    ci.indexOf("  runtime-profile:"),
    ci.indexOf("  workspace:"),
  );
  assert.match(profile, /frontend\)\n\s+pnpm --filter @savia\/admin typecheck/);
  const gate = ci.slice(ci.indexOf("  contracts:"), ci.indexOf("  typecheck:"));
  for (const name of [
    "admin",
    "admin-2",
    "admin-3",
    "admin-4",
    "admin-5",
    "admin-6",
  ]) {
    assert.ok(gate.includes(`      - ${name}\n`));
  }
});

test("CI validates main pushes and pull requests without deployment credentials", async () => {
  const ci = await workflow("ci.yml");

  assert.match(ci, /push:\n\s+branches: \[main\]/);
  assert.match(ci, /pull_request:/);
  assert.match(ci, /workflow_call:/);
  assert.doesNotMatch(ci, /paths-ignore:/);
  assert.match(ci, /contents: read/);
  assert.match(
    ci,
    /runs-on: ubuntu-24\.04\n(?:\s+environment: production\n)?\s+env:\n\s+PNPM_CONFIG_STRICT_DEP_BUILDS: "false"\n\s+steps:/,
  );
  assert.match(ci, /^  admin:/m);
  assert.match(ci, /^  api:/m);
  assert.match(ci, /^  workspace:/m);
  assert.match(ci, /^  contracts:/m);
  assert.match(ci, /^  typecheck:/m);
  assert.match(ci, /^  runtime-profile:/m);
  assert.match(
    ci,
    /ci_kind=\(infrastructure\|plugin\|none\|auth\|api\|backup-gate\|assistant-api\|ci-config\|frontend\|frontend-assistant-api\|self-hosted\)/,
  );
  assert.match(ci, /pnpm run test:unit:admin/);
  assert.match(ci, /pnpm run test:unit:api/);
  assert.match(ci, /pnpm run test:unit:workspace/);
  assert.match(ci, /pnpm run test:contracts/);
  assert.match(ci, /pnpm run typecheck/);
  assert.doesNotMatch(ci, /CLOUDFLARE_API_TOKEN|secrets\./);
});

test("focused self-hosted changes run package tests and type checks without heavy suites", async () => {
  const ci = await workflow("ci.yml");
  const runtime = ci.slice(
    ci.indexOf("  runtime-profile:"),
    ci.indexOf("  workspace:"),
  );
  assert.match(
    runtime,
    /contains\(fromJSON\('\["auth","api","backup-gate","assistant-api","frontend","frontend-assistant-api","self-hosted"\]'\), needs\.changes\.outputs\.ci_kind\)/,
  );
  const selfHosted = runtime
    .split("            self-hosted)")[1]
    ?.split(";;")[0];
  assert.ok(selfHosted, "runtime profile must have a self-hosted case");
  assert.match(selfHosted, /pnpm --filter @savia\/self-hosted test/);
  assert.match(selfHosted, /pnpm --filter @savia\/self-hosted typecheck/);

  const admin = ci.slice(ci.indexOf("  admin:"), ci.indexOf("  api:"));
  const api = ci.slice(ci.indexOf("  api:"), ci.indexOf("  runtime-profile:"));
  const workspace = ci.slice(
    ci.indexOf("  workspace:"),
    ci.indexOf("  contract-suite:"),
  );
  const flows = ci.slice(
    ci.indexOf("  flows-api:"),
    ci.indexOf("  publication-safety:"),
  );
  for (const section of [admin, api, workspace, flows])
    assert.doesNotMatch(section, /self-hosted/);

  const contractSuite = ci.slice(
    ci.indexOf("  contract-suite:"),
    ci.indexOf("  contracts:"),
  );
  assert.match(contractSuite, /pnpm run test:contracts/);
  const safety = ci.slice(ci.indexOf("  publication-safety:"));
  assert.match(safety, /name: Public source safety/);
  assert.doesNotMatch(safety, /^\s+if:/m);
});

test("contract suite runs independently and the required gate includes all required lanes", async () => {
  const ci = await workflow("ci.yml");
  const contractSuite = ci.slice(
    ci.indexOf("  contract-suite:"),
    ci.indexOf("  contracts:"),
  );
  const contracts = ci.slice(
    ci.indexOf("  contracts:"),
    ci.indexOf("  typecheck:"),
  );

  assert.match(contractSuite, /needs: changes/);
  assert.match(contractSuite, /pnpm run test:contracts/);
  assert.match(contractSuite, /name: Contract suite/);
  assert.match(contractSuite, /ci_kind == 'infrastructure'/);
  assert.match(contracts, /name: Contract tests/);
  assert.match(contracts, /needs:\n\s+- changes\n\s+- plugin-validation/);
  assert.match(contracts, /- runtime-profile\n\s+- contract-suite/);
  assert.match(
    contracts,
    /if: \$\{\{ always\(\) && needs\.changes\.outputs\.reused_pr_ci != 'true' \}\}/,
  );
  assert.match(contracts, /node scripts\/contract-check-gate\.mjs/);
});

test("Admin uses all six weighted shards and validates the distribution helper", async () => {
  const ci = await workflow("ci.yml");
  const assignments = [
    ...ci.matchAll(
      /VITEST_SHARD_ARGS='--shard (\d)\/6 --config \.\.\/\.\.\/scripts\/admin-vitest\.config\.mts'/g,
    ),
  ];
  assert.deepEqual(
    assignments.map((match) => Number(match[1])).sort(),
    [1, 2, 3, 4, 5, 6],
  );
  assert.match(
    ci,
    /node --test scripts\/admin-test-sequencer\.test\.mjs scripts\/contract-check-gate\.test\.mjs/,
  );
});

test("focused runtime profile failures block the required Contract tests gate", async () => {
  const ci = await workflow("ci.yml");
  const contracts = ci.slice(
    ci.indexOf("  contracts:"),
    ci.indexOf("  typecheck:"),
  );

  assert.match(contracts, /needs:[\s\S]*- runtime-profile/);
  assert.match(
    contracts,
    /name: Contract tests[\s\S]*?\n\s+if: \$\{\{ always\(\) && needs\.changes\.outputs\.reused_pr_ci != 'true' \}\}/,
  );
  assert.match(contracts, /- contract-suite/);
  const gate = await readFile(
    new URL("./contract-check-gate.mjs", import.meta.url),
    "utf8",
  );
  assert.match(gate, /RUNTIME_PROFILE_KINDS\.has\(ciKind\)/);
  assert.match(gate, /result !== "success"/);
});

test("contract gate accepts successful mandatory and applicable lanes", () => {
  const baseline = {
    changes: {
      result: "success",
      outputs: { kind: "platform", ci_kind: "full" },
    },
    "plugin-validation": { result: "skipped" },
    "runtime-profile": { result: "skipped" },
    "contract-suite": { result: "success" },
  };
  assert.deepEqual(evaluateContractGate(baseline), []);
  assert.deepEqual(
    evaluateContractGate({
      ...baseline,
      changes: {
        result: "success",
        outputs: { kind: "plugin", ci_kind: "auth" },
      },
      "plugin-validation": { result: "success" },
      "runtime-profile": { result: "success" },
    }),
    [],
  );
});

test("contract gate requires classification and contract suite success", () => {
  const baseline = {
    changes: {
      result: "success",
      outputs: { kind: "platform", ci_kind: "full" },
    },
    "plugin-validation": { result: "skipped" },
    "runtime-profile": { result: "skipped" },
    "contract-suite": { result: "success" },
  };
  assert.notDeepEqual(
    evaluateContractGate({
      ...baseline,
      changes: { result: "failure", outputs: {} },
    }),
    [],
  );
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.notDeepEqual(
      evaluateContractGate({
        ...baseline,
        "contract-suite": result ? { result } : undefined,
      }),
      [],
    );
  }
});

test("contract gate rejects unknown release classification kinds", () => {
  const result = evaluateContractGate({
    changes: {
      result: "success",
      outputs: { kind: "mystery", ci_kind: "full" },
    },
    "plugin-validation": { result: "skipped" },
    "runtime-profile": { result: "skipped" },
    "contract-suite": { result: "success" },
  });

  assert.ok(
    result.some((failure) =>
      failure.includes("release kind was invalid: mystery"),
    ),
  );
});

test("contract gate rejects skipped or cancelled expected plugin and runtime lanes", () => {
  const baseline = {
    changes: {
      result: "success",
      outputs: { kind: "plugin", ci_kind: "auth" },
    },
    "plugin-validation": { result: "success" },
    "runtime-profile": { result: "success" },
    "contract-suite": { result: "success" },
  };
  for (const result of ["failure", "cancelled", "skipped", undefined]) {
    assert.notDeepEqual(
      evaluateContractGate({
        ...baseline,
        "plugin-validation": result ? { result } : undefined,
      }),
      [],
    );
    assert.notDeepEqual(
      evaluateContractGate({
        ...baseline,
        "runtime-profile": result ? { result } : undefined,
      }),
      [],
    );
  }
});

test("long-running CI jobs honor cancellation while Contracts retains its final guard", async () => {
  const ci = await workflow("ci.yml");
  const contracts = ci.slice(
    ci.indexOf("  contracts:"),
    ci.indexOf("  typecheck:"),
  );

  assert.doesNotMatch(ci, /^\s+if: always\(\) &&/m);
  assert.match(
    contracts,
    /^    if: \$\{\{ always\(\) && needs\.changes\.outputs\.reused_pr_ci != 'true' \}\}$/m,
  );
  assert.match(
    contracts,
    /Require successful applicable CI lanes[\s\S]*?CI_NEEDS: \$\{\{ toJSON\(needs\) \}\}/,
  );
  assert.match(ci, /!cancelled\(\)/);
});

test("production deployment is limited to main and has ordered Worker stages", async () => {
  const deploy = await workflow("deploy-cloudflare.yml");

  assert.doesNotMatch(deploy, /workflow_run:/);
  assert.match(deploy, /workflow_dispatch:/);
  assert.match(deploy, /group: savia-production/);
  assert.match(
    deploy,
    /verify:[\s\S]*?run: node infra\/pulumi\/production-ci-proof\.mjs/,
  );
  assert.doesNotMatch(deploy, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(deploy, /needs: preview-check/);
  assert.match(deploy, /needs\.verify\.result == 'success'/);
  assert.match(deploy, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(deploy, /deploy:\n\s+needs: verify/);
  assert.match(deploy, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.doesNotMatch(deploy, /pnpm test && pnpm run typecheck/);
  assert.match(
    deploy,
    /runs-on: ubuntu-24\.04\n\s+environment: production-app\n\s+env:\n\s+PNPM_CONFIG_STRICT_DEP_BUILDS: "false"\n\s+SAVIA_BACKUP_ENVIRONMENT: production\n\s+steps:/,
  );
  assert.match(deploy, /environment\.mjs apply --environment production/);
  assert.match(deploy, /prepare-release\.mjs --environment production/);
  assert.match(deploy, /SAVIA_MCP_SHARED_SECRET/);
  assert.match(deploy, /ASSISTANT_SETTINGS_ENCRYPTION_KEY/);
  assert.match(deploy, /NANGO_API_KEY/);
  assert.match(deploy, /BETTER_AUTH_SECRET/);
  assert.doesNotMatch(deploy, /\n\s+secrets:/);
  assert.doesNotMatch(
    deploy,
    /command:.*deploy --config|finalize-domain-transition/,
  );
  assert.doesNotMatch(deploy, /branches:\s*\["\*"\]/);
  assert.doesNotMatch(deploy, /curl[^\n]*savia\.app\.hefesoft\.com\/health/);
});

test("QuickJS PR previews require an explicit label on same-repository main PRs", async () => {
  const preview = await workflow("preview-quickjs.yml");
  assert.match(preview, /pull_request_target:/);
  assert.match(preview, /branches: \[main\]/);
  assert.match(preview, /types: \[labeled\]/);
  assert.match(preview, /github\.event\.label\.name == 'quickjs-preview'/);
  assert.match(preview, /head\.repo\.full_name == github\.repository/);
  assert.match(preview, /base\.ref == 'main'/);
  assert.match(preview, /environment: preview/);
  assert.match(preview, /PREVIEW_BRANCH: \$\{\{ github\.head_ref \}\}/);
  assert.match(
    preview,
    /node scripts\/preview-deploy\.mjs --branch "\$PREVIEW_BRANCH"/,
  );
  assert.match(
    preview,
    /name: Verify QuickJS preview through authenticated service/,
  );
  assert.match(
    preview,
    /node scripts\/verify-quickjs-preview\.mjs --branch "\$PREVIEW_BRANCH"/,
  );
  assert.ok(
    preview.indexOf("Deploy explicitly labeled QuickJS branch preview") <
      preview.indexOf("Verify QuickJS preview through authenticated service"),
  );
  assert.doesNotMatch(preview, /synchronize|opened|reopened/);
  assert.doesNotMatch(preview, /cleanup:|preview-destroy\.mjs/);
});

test("branch Preview frontend builds use isolated settings and respect the Flows switch", async () => {
  for (const name of ["preview-environment.yml", "preview-quickjs.yml"]) {
    const preview = await workflow(name);
    assert.match(
      preview,
      /run: pnpm --filter @savia\/admin run build\s+env:\s+SAVIA_ADMIN_IGNORE_ENV_FILES: "true"\s+SAVIA_CI_FLOWS_ENABLED: \$\{\{ vars\.SAVIA_CI_FLOWS_ENABLED \}\}/,
      name,
    );
  }
});

test("production import is disabled unless explicitly enabled", async () => {
  const source = await workflow("import-savia-request-variables.yml");
  assert.match(source, /vars\.PRODUCTION_OPERATIONS_ENABLED == 'true'/);
  assert.match(source, /github\.ref == 'refs\/heads\/main'/);
  assert.match(source, /environment: production/);
});

test("production operations fail closed behind an explicit repository variable", async () => {
  const deploy = await workflow("deploy-cloudflare.yml");
  const backup = await workflow("backup-production.yml");
  const freshness = await workflow("check-production-backups.yml");
  const pulumi = await workflow("pulumi.yml");

  assert.match(
    deploy,
    /if: \$\{\{ vars\.PRODUCTION_OPERATIONS_ENABLED == 'true' && github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
  );
  const deployJob = deploy.slice(deploy.indexOf("\n  deploy:"));
  assert.match(
    deployJob,
    /if: \$\{\{ vars\.PRODUCTION_OPERATIONS_ENABLED == 'true' && github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(
    backup,
    /if: \$\{\{ vars\.PRODUCTION_OPERATIONS_ENABLED == 'true' && github\.ref == 'refs\/heads\/main' \}\}/,
  );
  assert.match(
    freshness,
    /if: \$\{\{ vars\.PRODUCTION_OPERATIONS_ENABLED == 'true' && github\.ref == 'refs\/heads\/main' \}\}/,
  );
  assert.match(
    pulumi,
    /if: \$\{\{ github\.event_name == 'workflow_dispatch' && \(inputs\.operation == 'preview' \|\| inputs\.operation == 'apply'\) && \(inputs\.stack == 'preview' \|\| \(inputs\.stack == 'production' && vars\.PRODUCTION_OPERATIONS_ENABLED == 'true' && github\.ref == 'refs\/heads\/main'\)\) \}\}/,
  );
  assert.match(pulumi, /options: \[preview, production\]/);
});

test("preview deploys only successful same-repository main CI and uses its own environment", async () => {
  const preview = await workflow("deploy-preview.yml");
  assert.match(preview, /workflow_run:/);
  assert.match(preview, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(preview, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(
    preview,
    /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/,
  );
  assert.match(preview, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(preview, /name: preview/);
  assert.match(preview, /SAVIA_DEPLOY_ENVIRONMENT: preview/);
  assert.match(preview, /environment\.mjs apply --environment preview/);
  assert.match(
    preview,
    /name: Publish sanitized runtime operation timings\n\s+continue-on-error: true\n\s+if: \$\{\{ always\(\) \}\}\n\s+run: node infra\/pulumi\/runtime-timing\.mjs summary\n\s+env:\n\s+SAVIA_RUNTIME_OPERATION_DIRECTORY: \$\{\{ runner\.temp \}\}\/savia-runtime/,
  );
  assert.ok(
    preview.indexOf("name: Publish sanitized runtime operation timings") >
      preview.indexOf("name: Apply the exact managed runtime plan"),
  );
  assert.ok(
    preview.indexOf("name: Encrypt private command diagnostics") >
      preview.indexOf("name: Publish sanitized runtime operation timings"),
  );
  assert.match(preview, /prepare-release\.mjs --environment preview/);
  assert.doesNotMatch(preview, /\n\s+secrets:/);
  assert.doesNotMatch(preview, /command:.*deploy --config/);
  assert.match(preview, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.doesNotMatch(
    preview,
    /wrangler\.production\.jsonc|reset-d1|environment: production/,
  );
  assert.match(
    preview,
    /SAVIA_PREVIEW_RELEASE_BASE: \$\{\{ needs\.plan\.outputs\.base \}\}/,
  );
  assert.match(
    preview,
    /name: Check out source[\s\S]*?ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}\n\s+fetch-depth: 0/,
  );
  assert.match(
    preview,
    /office_runtime_changed: \$\{\{ steps\.plan\.outputs\.office_runtime_changed \}\}/,
  );
  assert.match(
    preview,
    /store_plugins_changed: \$\{\{ steps\.plan\.outputs\.store_plugins_changed \}\}/,
  );
  assert.match(
    preview,
    /name: Prepare Office runtime assets\n\s+if: \$\{\{ success\(\) && !cancelled\(\) && needs\.plan\.outputs\.office_runtime_changed == 'true' \}\}/,
  );
  assert.match(
    preview,
    /name: Deploy release plugin ZIPs to all workspaces\n\s+if: \$\{\{ success\(\) && !cancelled\(\) && needs\.plan\.outputs\.store_plugins_changed == 'true' \}\}/,
  );
});

test("main CI reuses proven PR checks through the trusted parent only", async () => {
  const ci = await workflow("ci.yml");
  assert.match(ci, /git show "\$BASE_SHA:scripts\/preview-ci-reuse\.mjs"/);
  assert.match(
    ci,
    /\[\[ "\$EVENT_NAME" == "push" && "\$\{GITHUB_REF:-\}" == "refs\/heads\/main" \]\]/,
  );
  assert.match(ci, /test "\$\(git rev-parse HEAD\)" = "\$HEAD_SHA"/);
  assert.match(
    ci,
    /name: Preview CI proof \$\{\{ github\.event\.pull_request\.number \}\} \$\{\{ github\.event\.pull_request\.base\.sha \}\} \$\{\{ steps\.plan\.outputs\.tested_tree \}\}/,
  );
  assert.match(
    ci,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.match(
    ci,
    /contract-suite:[\s\S]*?if: \$\{\{ !cancelled\(\) && needs\.changes\.result == 'success' && needs\.changes\.outputs\.reused_pr_ci != 'true' \}\}/,
  );
});

test("release plugins deploy to all workspaces using existing environment credentials", async () => {
  for (const name of ["deploy-cloudflare.yml", "deploy-preview.yml"]) {
    const source = await workflow(name);
    assert.ok(
      source.indexOf("name: Apply the exact managed runtime plan") <
        source.indexOf("run: node scripts/deploy-store-plugins.mjs"),
    );
    const step = source.slice(
      source.indexOf("name: Deploy release plugin ZIPs"),
    );
    assert.match(step, /CLOUDFLARE_API_TOKEN/);
    assert.match(step, /CLOUDFLARE_DATABASE_ID.*env.SAVIA_DOMAIN_D1_ID/);
    assert.doesNotMatch(
      step,
      /SAVIA_PLUGIN_TARGETS|SAVIA_DEPLOY_EMAIL|SAVIA_DEPLOY_PASSWORD/,
    );
  }
});

test("registry deployment exposes Cloudflare credentials only to the deploy step", async () => {
  const registry = await workflow("deploy-plugin-registry.yml");
  const beforeSteps = registry.split("    steps:")[0];
  assert.doesNotMatch(beforeSteps, /CLOUDFLARE_API_TOKEN/);
  assert.match(
    registry,
    /name: Deploy registry[\s\S]*?env:[\s\S]*?CLOUDFLARE_API_TOKEN:/,
  );
  assert.doesNotMatch(registry, /r2 bucket delete|r2 object delete/);
});

test("environment deployments forward the private registry tenant map", async () => {
  for (const name of ["deploy-preview.yml", "deploy-cloudflare.yml"]) {
    const source = await workflow(name);
    const upload = source.slice(
      source.indexOf("name: Apply the exact managed runtime plan"),
      source.indexOf("name: Deploy release plugin ZIPs"),
    );
    assert.match(
      upload,
      /PLUGIN_REGISTRY_TENANTS: \$\{\{ secrets\.PLUGIN_REGISTRY_TENANTS \}\}/,
    );
    assert.match(
      upload,
      /WHATSAPP_META_APP_SECRET: \$\{\{ secrets\.WHATSAPP_META_APP_SECRET \}\}/,
    );
    assert.match(
      upload,
      /WHATSAPP_WEBHOOK_VERIFY_TOKEN: \$\{\{ secrets\.WHATSAPP_WEBHOOK_VERIFY_TOKEN \}\}/,
    );
  }
});

test("registry deployment accepts only the current main commit", async () => {
  const registry = await workflow("deploy-plugin-registry.yml");
  assert.match(
    registry,
    /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(
    registry,
    /uses: actions\/checkout@v4\n\s+with:\n\s+ref: \$\{\{ github\.sha \}\}/,
  );
  const guardStart = registry.indexOf("name: Reject superseded deployments");
  const deployStart = registry.indexOf("name: Deploy registry");
  assert.ok(
    guardStart >
      registry.indexOf("run: pnpm --filter @savia/plugin-registry typecheck"),
  );
  assert.ok(deployStart > guardStart);
  const guard = registry.slice(guardStart, deployStart);
  assert.match(guard, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.match(
    guard,
    /if \[ "\$approved_sha" != "\$current_sha" \]; then[\s\S]*exit 1/,
  );
});

test("coverage remains manually available without automatic repeated tests", async () => {
  const coverage = await workflow("coverage.yml");
  assert.doesNotMatch(coverage, /^  (?:push|schedule|workflow_run):/m);
  assert.match(coverage, /workflow_dispatch:/);
  assert.doesNotMatch(coverage, /pull_request(?:_target)?:/);
  assert.match(coverage, /pnpm test:coverage/);
  assert.match(coverage, /needs: coverage/);
  const ci = await workflow("ci.yml");
  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /paths-ignore:|continue-on-error: true/);
});

test("native VS Code validation uses current JavaScript actions and verifies the minimum host", async () => {
  const source = await workflow("build-vscode-extension.yml");
  assert.doesNotMatch(
    source,
    /uses: (?:actions\/(?:checkout|setup-node|upload-artifact)|pnpm\/action-setup)@v[1-4](?:[.\s]|$)/,
  );
  assert.match(source, /node-version: 22/);
  assert.match(source, /xvfb-run -a pnpm --filter @savia\/vscode test:host/);
  assert.match(source, /if-no-files-found: error/);
});

test("CodeQL scans affected PR languages or manual selections without push or schedule triggers", async () => {
  const source = await workflow("codeql.yml");
  assert.match(source, /^  pull_request:\n    branches: \[main\]/m);
  assert.match(source, /^  workflow_dispatch:/m);
  assert.doesNotMatch(
    source,
    /^  (?:push|schedule|workflow_run|pull_request_target):/m,
  );
  assert.match(source, /cancel-in-progress: true/);
  assert.match(
    source,
    /github\.event\.pull_request\.base\.sha \|\| github\.sha/,
  );
  assert.match(source, /run: node scripts\/codeql-plan\.mjs/);
  assert.doesNotMatch(source, /uses: actions\/checkout@v[1-4](?:[.\s]|$)/);
  assert.match(source, /needs: changes/);
  assert.match(source, /if: needs\.changes\.outputs\.should_scan == 'true'/);
  assert.match(source, /fromJSON\(needs\.changes\.outputs\.languages\)/);
  assert.match(source, /security-events: write/);
  assert.match(source, /github\/codeql-action\/init@v4/);
  assert.match(source, /github\/codeql-action\/analyze@v4/);
  assert.match(source, /category: \/language:/);
  assert.doesNotMatch(source, /secrets\.|CLOUDFLARE|continue-on-error: true/);
});

test("Preview lanes are exclusive and plugin health stays within rollback protection", async () => {
  const preview = await workflow("deploy-preview.yml");
  assert.match(preview, /needs\.plan\.outputs\.kind == 'platform'/);
  assert.match(preview, /needs\.plan\.outputs\.kind == 'plugin'/);
  const pluginJob = preview.slice(preview.indexOf("\n  plugins:"));
  assert.match(
    pluginJob,
    /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/,
  );
  assert.match(pluginJob, /verify-preview-resources\.mjs/);
  assert.match(pluginJob, /git ls-remote --exit-code origin refs\/heads\/main/);
  assert.match(pluginJob, /publish-preview-plugins\.mjs --plan/);
  assert.match(pluginJob, /name: preview-plugin-recovery/);
  assert.match(pluginJob, /name: preview-release/);
  assert.doesNotMatch(
    pluginJob,
    /Verify existing Preview remains healthy|pulumi up|backup\.mjs|apply-d1-migrations/,
  );
});

test("production promotion still requires the full verified Preview job", async () => {
  const production = await workflow("deploy-cloudflare.yml");
  assert.match(production, /Deploy preview/);
  assert.doesNotMatch(production, /Publish changed Preview plugins/);
});

test("manual previews validate trusted source before executing repository code", async () => {
  const preview = await workflow("preview-environment.yml");
  assert.match(
    preview,
    /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
  );
  const guard = preview.indexOf("name: Validate trusted preview source");
  const setup = preview.indexOf("name: Set up pnpm");
  assert.ok(guard > 0 && setup > guard);
  const checkout = preview.slice(0, guard);
  assert.match(checkout, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(checkout, /fetch-depth: 0/);
  assert.match(checkout, /persist-credentials: false/);
  assert.doesNotMatch(checkout, /ref: \$\{\{ inputs\.branch \}\}/);
  assert.doesNotMatch(
    preview,
    /run:[\s\S]*?\$\{\{ inputs\.(?:branch|confirm) \}\}/,
  );
  const deploy = preview.indexOf("name: Deploy preview environment");
  const destroy = preview.indexOf("name: Destroy preview environment");
  assert.ok(deploy > setup && destroy > deploy);
  assert.match(
    preview.slice(deploy, destroy),
    /BETTER_AUTH_BOOTSTRAP_PASSWORD: \$\{\{ secrets\.SAVIA_BRANCH_PREVIEW_BOOTSTRAP_PASSWORD \}\}/,
  );
  assert.doesNotMatch(preview.slice(0, deploy), /BOOTSTRAP_PASSWORD/);
  assert.doesNotMatch(preview.slice(destroy), /BOOTSTRAP_PASSWORD/);
});

test("Flows CI splits all seven package suites and keeps readiness fail-closed", async () => {
  const ci = await workflow("ci.yml");
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const lanes = [
    "flows-api",
    "flows-api-2",
    "flows-core",
    "flows-packages",
    "flows-readiness",
  ];
  const laneBlocks = lanes.map((name) => {
    const start = ci.indexOf(`  ${name}:`);
    assert.notEqual(start, -1, `missing ${name} lane`);
    const rest = ci.slice(start);
    const next = rest.search(/\n  [a-z][\w-]*:\n/);
    return rest.slice(0, next === -1 ? undefined : next);
  });

  assert.deepEqual(
    packageJson.scripts["flows:test:api"],
    "pnpm --filter @savia/flows-api test",
  );
  assert.deepEqual(
    packageJson.scripts["flows:test:core"],
    [
      "pnpm --filter @savia/flows test",
      "pnpm --filter @savia/flows-native test",
      "pnpm --filter @savia/flows-app test",
      "pnpm --filter @savia/flows-runtime test",
      "pnpm --filter @savia/flows-geo test",
      "pnpm --filter @savia/flows-utils test",
    ].join(" && "),
  );
  assert.deepEqual(
    packageJson.scripts["flows:test"],
    "pnpm run flows:test:core && pnpm run flows:test:api",
  );
  assert.match(laneBlocks[0], /vitest run --shard 1\/2/);
  assert.match(
    laneBlocks[0],
    /node --test 'containers\/ffmpeg\/\*\.test\.mjs'/,
  );
  assert.match(laneBlocks[1], /vitest run --shard 2\/2/);
  assert.doesNotMatch(laneBlocks[1], /containers\/ffmpeg/);
  assert.match(laneBlocks[2], /pnpm --filter @savia\/flows test/);
  assert.match(laneBlocks[2], /pnpm --filter @savia\/flows-native test/);
  for (const name of ["app", "runtime", "geo", "utils"]) {
    assert.ok(
      laneBlocks[3].includes(`pnpm --filter @savia/flows-${name} test`),
    );
  }
  assert.match(laneBlocks[2], /flows:verify/);
  assert.doesNotMatch(
    laneBlocks[2],
    /flows:typecheck|Verify infrastructure and recovery/,
  );
  assert.match(laneBlocks[4], /flows:typecheck/);
  assert.match(laneBlocks[4], /hook-executor typecheck/);
  assert.match(laneBlocks[4], /npm ci --prefix infra\/pulumi --ignore-scripts/);
  assert.match(laneBlocks[4], /infra\/pulumi\/\*\.test\.mjs/);

  const gateStart = ci.indexOf("\n  flows:\n");
  const gateEnd = ci.indexOf("\n  publication-safety:", gateStart);
  const gate = ci.slice(gateStart, gateEnd);
  assert.match(gate, /name: Flows runtime and preview readiness/);
  assert.match(
    gate,
    /needs:\n\s+- changes\n\s+- flows-api\n\s+- flows-api-2\n\s+- flows-core\n\s+- flows-packages\n\s+- flows-readiness/,
  );
  assert.match(gate, /if: \$\{\{ !cancelled\(\)/);
  assert.match(gate, /vars\.SAVIA_CI_FLOWS_ENABLED != 'false'/);
  assert.match(
    gate,
    /needs\.flows-api\.result }}" != "success"[\s\S]*needs\.flows-api-2\.result }}" != "success"[\s\S]*needs\.flows-core\.result }}" != "success"[\s\S]*needs\.flows-packages\.result }}" != "success"[\s\S]*needs\.flows-readiness\.result }}" != "success"/,
  );
  assert.match(gate, /exit 1/);

  const gateScript = gate
    .match(/        run: \|\n((?:          .*\n)+)/)?.[1]
    ?.replace(/^          /gm, "");
  assert.ok(
    gateScript,
    "aggregate gate must provide an executable shell script",
  );
  const flowJobs = [
    "flows-api",
    "flows-api-2",
    "flows-core",
    "flows-packages",
    "flows-readiness",
  ];
  const scenarios = [
    {},
    ...flowJobs.flatMap((job) =>
      ["failure", "cancelled", "skipped"].map((result) => ({ [job]: result })),
    ),
  ];
  for (const overrides of scenarios) {
    const script = flowJobs.reduce(
      (text, job) =>
        text.replaceAll(
          `\${{ needs.${job}.result }}`,
          overrides[job] ?? "success",
        ),
      gateScript,
    );
    const result = spawnSync(
      "bash",
      ["-e", "-u", "-o", "pipefail", "-c", script],
      { encoding: "utf8" },
    );
    assert.equal(result.status, Object.keys(overrides).length ? 1 : 0);
  }

  for (const lane of laneBlocks) {
    assert.match(lane, /needs: changes/);
    assert.match(
      lane,
      /if: \$\{\{ !cancelled\(\) && vars\.SAVIA_CI_FLOWS_ENABLED != 'false' && \(needs\.changes\.result != 'success' \|\| needs\.changes\.outputs\.ci_flows == 'true'\) \}\}/,
    );
  }
  assert.match(
    ci,
    /Run offline Flows recovery contracts[^\n]+\n\s+if: \$\{\{ vars\.SAVIA_CI_FLOWS_ENABLED != 'false'/,
  );
  assert.match(
    ci,
    /name: Preview CI proof .*vars\.SAVIA_CI_FLOWS_ENABLED == 'false' && ' \(Flows skipped\)'/,
  );
});

test("local unit validation honors the dedicated Flows test setting", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const runner = `pnpm() {
    printf 'lane:%s\\n' "$2"
    if [ "$2" = "$SAVIA_TEST_FAIL_LANE" ]; then return 9; fi
  }
  ${manifest.scripts["test:unit"]}`;
  const core = ["test:unit:admin", "test:unit:api", "test:unit:workspace"];
  for (const scenario of [
    { flag: "false", lanes: core },
    { flag: "true", lanes: [...core, "flows:test"] },
    { lanes: [...core, "flows:test"] },
    { flag: "false", fail: "test:unit:api", lanes: core.slice(0, 2) },
    { flag: "true", fail: "flows:test", lanes: [...core, "flows:test"] },
  ]) {
    const env = { ...process.env, SAVIA_TEST_FAIL_LANE: scenario.fail ?? "" };
    delete env.SAVIA_CI_FLOWS_ENABLED;
    if (scenario.flag !== undefined) env.SAVIA_CI_FLOWS_ENABLED = scenario.flag;
    const result = spawnSync("sh", ["-c", runner], { env, encoding: "utf8" });
    assert.equal(result.status, scenario.fail ? 9 : 0, result.stderr);
    assert.deepEqual(
      [...result.stdout.matchAll(/^lane:(.+)$/gm)].map(([, lane]) => lane),
      scenario.lanes,
    );
  }
});

test("focused API validation regenerates and typechecks frontend consumers", async () => {
  const ci = await workflow("ci.yml");
  const profile = ci.split("            api)")[1].split(";;")[0];
  assert.match(profile, /pnpm --filter @savia\/admin typecheck/);
});

test("focused API changes retain all three parallel API test shards", async () => {
  const ci = await workflow("ci.yml");
  const shards = ci.slice(
    ci.indexOf("  api:\n"),
    ci.indexOf("  runtime-profile:\n"),
  );
  assert.equal(
    (
      shards.match(
        /contains\(fromJSON\('\["full","api","assistant-api","frontend-assistant-api"\]'\)/g,
      ) ?? []
    ).length,
    3,
  );
  assert.equal(
    (shards.match(/VITEST_SHARD_ARGS='--shard \d\/3'/g) ?? []).length,
    3,
  );
  assert.equal((shards.match(/API_SHARD: "[1-3]"/g) ?? []).length, 3);
  assert.equal(
    (shards.match(/vitest run --shard "\$API_SHARD\/6"/g) ?? []).length,
    3,
  );
  const extras = ci.slice(
    ci.indexOf("  api-extra-shards:"),
    ci.indexOf("  assistant-mcp:"),
  );
  assert.match(extras, /fail-fast: false/);
  assert.match(extras, /shard: \["4\/6", "5\/6", "6\/6"\]/);
  assert.match(extras, /vitest run --shard "\$API_SHARD"/);
  assert.match(
    ci.slice(ci.indexOf("  contracts:"), ci.indexOf("  typecheck:")),
    /- api-extra-shards/,
  );
  const profile = ci.split("            api)")[1].split(";;")[0];
  assert.match(profile, /@savia\/api exec tsc --noEmit/);
});

test("Preview components can retry independently without repeating runtime publication", async () => {
  const preview = await workflow("deploy-preview.yml");
  const job = (name) =>
    preview.split(`\n  ${name}:`)[1]?.split(/\n  [a-z-]+:/)[0] ?? "";
  const runtime = job("deploy"),
    office = job("office"),
    store = job("store"),
    promotion = job("promotion");
  assert.match(runtime, /needs\.plan\.outputs\.runtime_changed == 'true'/);
  assert.match(runtime, /name: preview-runtime/);
  assert.doesNotMatch(runtime, /prepare-office-runtime|deploy-store-plugins/);
  for (const component of [office, store]) {
    assert.match(component, /needs: \[plan, deploy(?:, plugins)?\]/);
    assert.match(component, /needs\.deploy\.result == 'skipped'/);
    assert.match(
      component,
      /git ls-remote --exit-code origin refs\/heads\/main/,
    );
    assert.doesNotMatch(
      component,
      /environment\.mjs apply|backup\.mjs|apply-d1-migrations/,
    );
  }
  assert.match(office, /name: preview-office/);
  assert.match(store, /name: preview-store/);
  assert.match(store, /SAVIA_PLUGIN_PRESERVE_NEWER_OPTIONAL: "true"/);
  assert.match(promotion, /needs: \[plan, deploy, office, store, plugins\]/);
  for (const name of ["deploy", "office", "store", "plugins"]) {
    assert.ok(promotion.includes(`needs.${name}.result == 'success'`));
    assert.ok(promotion.includes(`needs.${name}.result == 'skipped'`));
  }
  assert.match(promotion, /name: preview-release/);
});

test("Preview skips store publication only when the successful runtime verified the live catalog", async () => {
  const preview = await workflow("deploy-preview.yml");
  const job = (name) =>
    preview.split(`\n  ${name}:`)[1].split(/\n  [a-z-]+:/)[0];
  const runtime = job("deploy");
  const verifier =
    runtime
      .split("- name: Verify the deployed Preview catalog")[1]
      ?.split("- name:")[0] ?? "";
  assert.match(
    runtime,
    /store_current: \$\{\{ steps\.store_current\.outputs\.current \}\}/,
  );
  assert.ok(
    runtime.indexOf("name: Verify the deployed Preview catalog") >
      runtime.indexOf("name: Apply the exact managed runtime plan"),
  );
  assert.match(
    verifier,
    /if: \$\{\{ success\(\) && !cancelled\(\) && needs\.plan\.outputs\.store_plugins_changed == 'true' \}\}/,
  );
  assert.match(verifier, /GITHUB_OUTPUT="\$proof" timeout 20s/);
  assert.match(verifier, /\[\[ "\$\(cat "\$proof"\)" == 'current=true' \]\]/);
  assert.doesNotMatch(verifier, /continue-on-error:/);
  assert.match(verifier, /SAVIA_DEPLOY_ENVIRONMENT: preview/);
  assert.match(
    verifier,
    /CLOUDFLARE_DATABASE_ID: \$\{\{ env\.SAVIA_DOMAIN_D1_ID \}\}/,
  );
  assert.match(
    verifier,
    /SAVIA_PREVIEW_STORE_EXCLUDED_TENANTS: \$\{\{ vars\.SAVIA_PREVIEW_STORE_EXCLUDED_TENANTS \}\}/,
  );
  assert.match(
    verifier,
    /pnpm --filter @savia\/admin exec tsx \.\.\/\.\.\/scripts\/verify-preview-store\.mts/,
  );
  assert.doesNotMatch(job("plan"), /verify-preview-store|secrets\./);

  const script = verifier.split("run: |\n")[1].split("\n        env:")[0];
  const directory = await mkdtemp(join(tmpdir(), "preview-store-proof-"));
  const output = join(directory, "job-output");
  try {
    for (const [proof, status, expected] of [
      ["current=true", "0", "current=true\n"],
      ["current=false", "0", ""],
      ["current=true", "124", ""],
      ["current=true\nextra=invalid", "0", ""],
    ]) {
      await writeFile(output, "");
      const result = spawnSync(
        "bash",
        [
          "-c",
          `timeout() { shift; "$@"; }\npnpm() { printf '%s\\n' "$FIXTURE_PROOF" > "$GITHUB_OUTPUT"; return "$FIXTURE_STATUS"; }\n${script}`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            RUNNER_TEMP: directory,
            GITHUB_OUTPUT: output,
            FIXTURE_PROOF: proof,
            FIXTURE_STATUS: status,
          },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(await readFile(output, "utf8"), expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const expression = job("store").split("${{")[1].split("}}")[0];
  const publishStore = new Function(
    "needs",
    "always",
    "cancelled",
    `return (${expression});`,
  );
  const needs = {
    plan: { result: "success", outputs: { store_plugins_changed: "true" } },
    deploy: { result: "success", outputs: {} },
    plugins: { result: "skipped" },
  };
  const publish = () =>
    publishStore(
      needs,
      () => true,
      () => false,
    );
  assert.equal(publish(), true);
  needs.deploy.outputs.store_current = "false";
  assert.equal(publish(), true);
  needs.deploy.outputs.store_current = "true";
  assert.equal(publish(), false);
  needs.deploy.result = "skipped";
  assert.equal(publish(), true);
  needs.deploy.result = "failure";
  assert.equal(publish(), false);
});

test("Preview promotion rejects required components skipped after a dependency failure", async () => {
  const preview = await workflow("deploy-preview.yml");
  const expression = preview
    .split("\n  promotion:")[1]
    .split("${{")[1]
    .split("}}")[0];
  const evaluate = new Function(
    "needs",
    "always",
    "cancelled",
    `return (${expression});`,
  );
  const needs = {
    plan: {
      result: "success",
      outputs: {
        kind: "platform",
        runtime_changed: "true",
        office_runtime_changed: "true",
        store_plugins_changed: "true",
      },
    },
    deploy: { result: "success", outputs: {} },
    office: { result: "success" },
    store: { result: "success" },
    plugins: { result: "skipped" },
  };
  assert.equal(
    evaluate(
      needs,
      () => true,
      () => false,
    ),
    true,
  );
  for (const component of ["deploy", "office", "store"]) {
    assert.equal(
      evaluate(
        { ...needs, [component]: { result: "skipped" } },
        () => true,
        () => false,
      ),
      false,
      `${component} needs a successful result when required`,
    );
  }
  const reconciled = structuredClone(needs);
  reconciled.store.result = "skipped";
  reconciled.deploy.outputs.store_current = "true";
  assert.equal(
    evaluate(
      reconciled,
      () => true,
      () => false,
    ),
    true,
  );
  reconciled.store.result = "failure";
  assert.equal(
    evaluate(
      reconciled,
      () => true,
      () => false,
    ),
    false,
  );
  const unchanged = structuredClone(needs);
  unchanged.plan.outputs.runtime_changed = "false";
  unchanged.plan.outputs.office_runtime_changed = "false";
  unchanged.plan.outputs.store_plugins_changed = "false";
  for (const component of ["deploy", "office", "store"])
    unchanged[component].result = "skipped";
  assert.equal(
    evaluate(
      unchanged,
      () => true,
      () => false,
    ),
    true,
  );
  unchanged.plan.outputs.kind = "plugin";
  assert.equal(
    evaluate(
      unchanged,
      () => true,
      () => false,
    ),
    false,
  );
  unchanged.plugins.result = "success";
  assert.equal(
    evaluate(
      unchanged,
      () => true,
      () => false,
    ),
    true,
  );
});

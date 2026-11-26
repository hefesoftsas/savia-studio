import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyPreviewCodeChanges,
  derivePreviewCodeScope,
} from "./preview-code-release.mjs";

test("the frontend warmup plans exact main pushes before requiring build inputs", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "savia-frontend-warmup-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Release test");
  git("config", "commit.gpgsign", "false");
  const commit = (path, text) => {
    const filepath = join(cwd, path);
    mkdirSync(dirname(filepath), { recursive: true });
    writeFileSync(filepath, text);
    git("add", path);
    git("commit", "-m", "Fixture update");
    return git("rev-parse", "HEAD");
  };
  const plan = (base, hostedFrontendRevision = "") => {
    const output = join(cwd, "workflow-output");
    writeFileSync(output, "");
    execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL("./warm-preview-frontend.mjs", import.meta.url)),
        "--plan",
      ],
      {
        cwd,
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          GITHUB_REF: "refs/heads/main",
          GITHUB_SHA: git("rev-parse", "HEAD"),
          GITHUB_OUTPUT: output,
          PREVIEW_PUSH_BASE: base,
          SAVIA_PREVIEW_HOSTED_FRONTEND_REVISION: hostedFrontendRevision,
          PREVIEW_PLUGIN_EDITOR_ORIGIN: "",
        },
      },
    );
    return readFileSync(output, "utf8");
  };
  commit("apps/admin/src/view.tsx", "export const value = 1;\n");
  const initial = commit(
    "apps/api/src/service.ts",
    "export const value = 1;\n",
  );
  const tooling = commit(
    "infra/pulumi/prepare-release.mjs",
    "export const value = 1;\n",
  );
  assert.equal(plan(initial), "needed=false\n");
  const backend = commit(
    "apps/api/src/service.ts",
    "export const value = 2;\n",
  );
  assert.equal(plan(tooling), "needed=false\n");
  commit("apps/admin/src/view.tsx", "export const value = 2;\n");
  assert.equal(plan(backend), "needed=true\n");
  assert.equal(plan("0".repeat(40)), "needed=true\n");
  const hostedRevision = "b".repeat(40);
  assert.equal(plan(backend, hostedRevision), "needed=true\n");
  const pinned = commit(
    "deployment/hosted-plugins.json",
    JSON.stringify({ revision: hostedRevision }),
  );
  assert.equal(plan(backend, hostedRevision), "needed=false\n");
  assert.equal(plan(backend, "false"), "needed=true\n");
  commit("apps/admin/src/view.tsx", "export const value = 3;\n");
  assert.equal(plan(pinned), "needed=true\n");
  assert.equal(plan(pinned, hostedRevision), "needed=false\n");
  commit(
    "deployment/hosted-plugins.json",
    JSON.stringify({ revision: "c".repeat(40) }),
  );
  assert.equal(plan(backend, hostedRevision), "needed=true\n");
});

const file = (
  path,
  before = "export const x = 1",
  after = "export const x = 2",
) => ({ path, before, after });
test("isolated source targets and conservative shared coordinator fallback", () => {
  assert.deepEqual(
    classifyPreviewCodeChanges([file("apps/api/src/auth/admin-oauth.ts")]),
    ["api"],
  );
  assert.equal(
    classifyPreviewCodeChanges([file("packages/backup-gate/index.mjs")]),
    null,
  );
});

test("the assistant API and audited shared client select MCP before API", () => {
  assert.deepEqual(
    classifyPreviewCodeChanges([
      file("apps/api/src/assistant/service.ts"),
      file("apps/mcp/src/server.ts"),
      file("packages/release-catalog/src/assistant-api-client.ts"),
    ]),
    ["mcp", "api"],
  );
  assert.deepEqual(
    classifyPreviewCodeChanges([
      file("packages/release-catalog/src/assistant-api-client.ts"),
    ]),
    ["mcp", "api"],
  );
  assert.equal(
    classifyPreviewCodeChanges([
      file("packages/release-catalog/src/assistant-contracts.ts"),
    ]),
    null,
  );
  assert.equal(
    classifyPreviewCodeChanges([file("apps/mcp/src/new-tool.ts", null)]),
    null,
  );
});
test("unknown, configuration, schema and entrypoint changes require full publication", () => {
  for (const path of [
    "pnpm-lock.yaml",
    "infra/pulumi/index.ts",
    "apps/auth/src/index.ts",
    "apps/api/src/env.ts",
    "apps/mcp/src/index.ts",
    "apps/mcp/src/config.ts",
    "packages/db/migrations/01.sql",
    "apps/admin/vite.config.ts",
    "apps/admin/src/plugin-vscode-runtime.ts",
  ])
    assert.equal(classifyPreviewCodeChanges([file(path)]), null, path);
  for (const source of [
    "CREATE TABLE users",
    "CREATE UNIQUE INDEX users_email",
    "CREATE TEMP TABLE users",
    "ALTER TABLE users",
    "getMigrations(auth)",
    "betterAuth({})",
    "oauthProvider({})",
  ])
    assert.equal(
      classifyPreviewCodeChanges([file("apps/auth/src/session.ts", source)]),
      null,
      source,
    );
  assert.equal(
    classifyPreviewCodeChanges([file("apps/api/src/new.ts", null)]),
    null,
  );
  assert.equal(classifyPreviewCodeChanges([file("docs/guide.md")]), null);
});

test("frontend source freezes both frontend targets and includes compatible API and MCP changes", () => {
  for (const path of [
    "apps/admin/src/components/Button.tsx",
    "apps/admin/src/app.css",
    "apps/admin/src/i18n/locales/savia.ts",
  ]) {
    assert.deepEqual(classifyPreviewCodeChanges([file(path)]), [
      "pluginEditor",
      "gateway",
    ]);
    assert.equal(classifyPreviewCodeChanges([file(path, null)]), null);
    assert.deepEqual(
      classifyPreviewCodeChanges([
        file(path),
        file("apps/api/src/assistant/capabilities.ts"),
        file("apps/mcp/src/server.ts"),
      ]),
      ["mcp", "api", "pluginEditor", "gateway"],
    );
    assert.equal(
      classifyPreviewCodeChanges([
        file(path),
        file("apps/auth/src/session.ts"),
      ]),
      null,
    );
  }
  for (const path of [
    "apps/api/src/index.ts",
    "packages/db/migrations/0099-example.sql",
    "apps/admin/src/edge-gateway.ts",
    "apps/admin/src/office-gateway.ts",
    "apps/admin/package.json",
    "apps/admin/wrangler.preview.jsonc",
    "apps/admin/build/manual-chunks.ts",
    "apps/admin/vite.config.ts",
  ]) {
    assert.equal(
      classifyPreviewCodeChanges([file("apps/admin/src/app.tsx"), file(path)]),
      null,
    );
  }
});
test("scope requires a verified ancestor and exact source reads; errors fail closed", async () => {
  const base = "a".repeat(40),
    head = "b".repeat(40);
  const calls = [];
  const run = async (_, args) => {
    calls.push(args);
    return {
      stdout:
        args[0] === "diff"
          ? "apps/api/src/auth/admin-oauth.ts\0"
          : args[0] === "show"
            ? "export const x = 1"
            : "",
    };
  };
  assert.deepEqual(await derivePreviewCodeScope({ base, head, run }), {
    base,
    head,
    targets: ["api"],
  });
  assert.equal(calls[0][0], "merge-base");
  assert.equal(
    await derivePreviewCodeScope({
      base,
      head,
      run: async () => {
        throw new Error("missing history");
      },
    }),
    null,
  );
  assert.equal(await derivePreviewCodeScope({ head, run }), null);
});

test("pending compatible code stays scoped across unrelated deployment tooling changes", () => {
  assert.deepEqual(
    classifyPreviewCodeChanges([
      file("apps/auth/src/lib/utils.ts"),
      file("infra/pulumi/runtime-artifact-custody.mjs"),
      file("scripts/preview-code-release.mjs"),
      file("scripts/preview-release-plan.mjs"),
      file(".github/workflows/deploy-preview.yml"),
    ]),
    ["auth"],
  );
  assert.equal(
    classifyPreviewCodeChanges([
      file("apps/auth/src/lib/utils.ts"),
      file("infra/pulumi/worker-config.mjs"),
    ]),
    null,
  );
  assert.equal(
    classifyPreviewCodeChanges([
      file("infra/pulumi/runtime-artifact-custody.mjs"),
    ]),
    null,
  );
});

test("derivation skips non-runtime paths before reading files absent from the baseline", async () => {
  const base = "a".repeat(40),
    head = "b".repeat(40);
  const scope = await derivePreviewCodeScope({
    base,
    head,
    run: async (_, args) => {
      if (args[0] === "diff")
        return {
          stdout: "apps/auth/src/lib/utils.ts\0docs/new-release-guide.md\0",
        };
      if (args[0] === "show" && args[1].includes("docs/"))
        throw Error("new guide missing from baseline");
      return { stdout: "export const x = 1" };
    },
  });
  assert.deepEqual(scope, { base, head, targets: ["auth"] });
});

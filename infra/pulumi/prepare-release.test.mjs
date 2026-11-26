import test from "node:test";
import assert from "node:assert/strict";
import { prepareEnvironmentRelease } from "./prepare-release.mjs";
import { resolveInfraNames } from "./naming.mjs";
test("standard preparation derives actual binding IDs and freezes the exact source", async () => {
  const accountId = "a".repeat(32),
    names = resolveInfraNames({
      environment: "preview",
      documentsBucket: "savia-documents-preview",
      publicOrigin: "https://savia-preview.hefesoft.com",
    }),
    events = [];
  const outputs = {
    cloudflareAccountId: accountId,
    authD1Id: "auth-id",
    domainD1Id: "domain-id",
    documentsBucketName: names.bucket,
    resolvedEnvironment: "preview",
    resolvedPublicOrigin: names.publicOrigin,
    workerNames: names.workers,
    databaseNames: names.databases,
    deletionProtected: false,
    flowsEnabled: false,
    flowsResources: null,
    flowsExecutionEnabled: false,
    plannedFlowsResourceNames: names.flows,
    tenantSubdomains: [],
    vectorizeIndex: names.vectorizeIndex,
  };
  const result = await prepareEnvironmentRelease(
    { environment: "preview", destination: "/tmp/not-created-release" },
    {
      env: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        SAVIA_PREVIEW_RELEASE_BASE: "a".repeat(40),
      },
      readOutputs: async () => outputs,
      client: { api: async () => ({ subdomain: "test-account" }) },
      render: async (env) => {
        assert.equal(env.SAVIA_DOMAIN_D1_ID, "domain-id");
        events.push("render");
      },
      run: async (binary, args, options) => {
        if (binary === "git")
          return {
            stdout:
              args[0] === "rev-parse"
                ? "b".repeat(40)
                : args[0] === "diff"
                  ? "apps/api/src/auth/admin-oauth.ts"
                  : args[0] === "show"
                    ? "export const x = 1"
                    : "",
          };
        assert.equal(binary, "pnpm");
        assert.match(
          options.env.VITE_PLUGIN_EDITOR_RUNTIME_URL,
          /test-account\.workers\.dev\/plugin-editor$/,
        );
        events.push(args.at(-1));
      },
      freeze: async (options) => {
        assert.equal(options.sourceRevision, "b".repeat(40));
        assert.deepEqual(options.codeOnly, {
          base: "a".repeat(40),
          head: "b".repeat(40),
          targets: ["api"],
        });
        assert.equal(options.configs.length, 1);
        assert.ok(
          options.configs[0].endsWith("apps/api/wrangler.preview.jsonc"),
        );
        events.push("freeze");
        return { artifactDigest: "c".repeat(64) };
      },
    },
  );
  assert.deepEqual(events, ["render", "freeze"]);
  assert.equal(result.sourceRevision, "b".repeat(40));
});

test("full Preview preparation bundles provisioned Flows only when enabled", async () => {
  const accountId = "a".repeat(32);
  const names = resolveInfraNames({
    environment: "preview",
    documentsBucket: "savia-documents-preview",
    publicOrigin: "https://savia-preview.hefesoft.com",
  });
  for (const flowsSetting of ["false", "true", undefined]) {
    await prepareEnvironmentRelease(
      { environment: "preview", destination: "/tmp/not-created-flows-profile" },
      {
        env: {
          CLOUDFLARE_ACCOUNT_ID: accountId,
          SAVIA_CI_FLOWS_ENABLED: flowsSetting,
        },
        readOutputs: async () => ({
          cloudflareAccountId: accountId,
          authD1Id: "auth-id",
          domainD1Id: "domain-id",
          documentsBucketName: names.bucket,
          resolvedEnvironment: "preview",
          resolvedPublicOrigin: names.publicOrigin,
          workerNames: names.workers,
          databaseNames: names.databases,
          deletionProtected: false,
          flowsEnabled: true,
          flowsExecutionEnabled: true,
          flowsResources: {
            databaseId: "flows-db-id",
            kvNamespaceId: "flows-kv-id",
            workerName: names.flows.worker,
            workflowName: names.flows.workflow,
            queueName: names.flows.queue,
            deadLetterQueueName: names.flows.deadLetterQueue,
            buckets: names.flows.buckets,
          },
          plannedFlowsResourceNames: names.flows,
        }),
        client: { api: async () => ({ subdomain: "test-account" }) },
        render: async (env) => {
          assert.equal(env.SAVIA_FLOWS_PROVISIONED, "true");
          assert.equal(
            JSON.parse(env.SAVIA_FLOWS_RESOURCES).workerName,
            "savia-flows-preview",
          );
        },
        run: async (binary) => ({
          stdout: binary === "git" ? "b".repeat(40) : "",
        }),
        freeze: async ({ configs, assetsReady }) => {
          await assetsReady;
          assert.equal(
            configs.some((path) =>
              path.endsWith("flows/api/wrangler.preview.jsonc"),
            ),
            flowsSetting !== "false",
          );
          assert.ok(
            configs.some((path) =>
              path.endsWith("apps/api/wrangler.preview.jsonc"),
            ),
          );
          return {};
        },
      },
    );
  }
});

test("verified Preview code scope is selected before builds and freezes only its Worker targets", async () => {
  const accountId = "a".repeat(32),
    names = resolveInfraNames({
      environment: "preview",
      documentsBucket: "savia-documents-preview",
      publicOrigin: "https://savia-preview.hefesoft.com",
    }),
    events = [];
  const outputs = {
    cloudflareAccountId: accountId,
    authD1Id: "auth-id",
    domainD1Id: "domain-id",
    documentsBucketName: names.bucket,
    resolvedEnvironment: "preview",
    resolvedPublicOrigin: names.publicOrigin,
    workerNames: names.workers,
    databaseNames: names.databases,
    deletionProtected: false,
    flowsEnabled: false,
    flowsResources: null,
    flowsExecutionEnabled: false,
    plannedFlowsResourceNames: names.flows,
    tenantSubdomains: [],
    vectorizeIndex: names.vectorizeIndex,
  };
  await prepareEnvironmentRelease(
    { environment: "preview", destination: "/tmp/not-created-code-only" },
    {
      env: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        SAVIA_PREVIEW_RELEASE_BASE: "a".repeat(40),
      },
      readOutputs: async () => outputs,
      client: {
        api: async () => assert.fail("code-only scope read account API"),
      },
      render: async () => events.push("render"),
      run: async (binary, args) => {
        if (binary === "git") {
          if (args[0] === "rev-parse") return { stdout: "b".repeat(40) };
          if (args[0] === "merge-base") return { stdout: "" };
          if (args[0] === "diff")
            return {
              stdout:
                "apps/api/src/assistant/service.ts\napps/mcp/src/server.ts\npackages/release-catalog/src/assistant-api-client.ts",
            };
          if (args[0] === "show") return { stdout: "export const x = 1" };
        }
        events.push(`build:${args.at(-1)}`);
        return { stdout: "" };
      },
      freeze: async (options) => {
        assert.deepEqual(options.codeOnly, {
          base: "a".repeat(40),
          head: "b".repeat(40),
          targets: ["mcp", "api"],
        });
        assert.deepEqual(
          options.configs
            .map((path) => path.split("/").slice(-2).join("/"))
            .sort(),
          ["api/wrangler.preview.jsonc", "mcp/wrangler.preview.jsonc"],
        );
        assert.ok(options.domainMigrations.endsWith("packages/db/migrations"));
        events.push("freeze");
        return { artifactDigest: "c".repeat(64) };
      },
    },
  );
  assert.deepEqual(events, ["render", "freeze"]);
});

test("frontend Preview scope builds both frontends and freezes only their configs", async () => {
  const accountId = "a".repeat(32),
    names = resolveInfraNames({
      environment: "preview",
      documentsBucket: "savia-documents-preview",
      publicOrigin: "https://savia-preview.hefesoft.com",
    }),
    events = [],
    built = [];
  const outputs = {
    cloudflareAccountId: accountId,
    authD1Id: "auth-id",
    domainD1Id: "domain-id",
    documentsBucketName: names.bucket,
    resolvedEnvironment: "preview",
    resolvedPublicOrigin: names.publicOrigin,
    workerNames: names.workers,
    databaseNames: names.databases,
    deletionProtected: false,
    flowsEnabled: false,
    flowsResources: null,
    flowsExecutionEnabled: false,
    plannedFlowsResourceNames: names.flows,
    tenantSubdomains: [],
    vectorizeIndex: names.vectorizeIndex,
  };
  await prepareEnvironmentRelease(
    { environment: "preview", destination: "/tmp/not-created-code-only" },
    {
      env: {
        CLOUDFLARE_ACCOUNT_ID: accountId,
        SAVIA_PREVIEW_RELEASE_BASE: "a".repeat(40),
      },
      readOutputs: async () => outputs,
      client: {
        api: async () => ({ subdomain: "test-account" }),
      },
      render: async () => events.push("render"),
      run: async (binary, args) => {
        if (binary === "git") {
          if (args[0] === "rev-parse") return { stdout: "b".repeat(40) };
          if (args[0] === "merge-base") return { stdout: "" };
          if (args[0] === "diff")
            return { stdout: "apps/admin/src/i18n/locales/savia.ts" };
          if (args[0] === "show") return { stdout: "export const x = 1" };
        }
        const build = args.at(-1);
        events.push(`build:${build}`);
        await new Promise((ready) => setImmediate(ready));
        assert.ok(events.includes("build:build:assets"));
        assert.ok(events.includes("build:build:plugin-editor"));
        built.push(build);
        return { stdout: "" };
      },
      freeze: async (options) => {
        await options.assetsReady;
        assert.deepEqual(built, ["build:plugin-editor", "build:assets"]);
        assert.deepEqual(options.codeOnly, {
          base: "a".repeat(40),
          head: "b".repeat(40),
          targets: ["pluginEditor", "gateway"],
        });
        assert.deepEqual(
          options.configs.map((path) => path.split("/").slice(-2).join("/")),
          [
            "admin/wrangler.preview.jsonc",
            "plugin-editor-runtime/wrangler.preview.jsonc",
          ],
        );
        assert.ok(options.domainMigrations.endsWith("packages/db/migrations"));
        events.push("freeze");
        return { artifactDigest: "c".repeat(64) };
      },
    },
  );
  assert.deepEqual(events, [
    "render",
    "build:build:plugin-editor",
    "build:build:assets",
    "freeze",
  ]);
});

test("a full Preview release uses verified warm assets or rebuilds the full Worker set", async () => {
  const accountId = "a".repeat(32),
    names = resolveInfraNames({
      environment: "preview",
      documentsBucket: "savia-documents-preview",
      publicOrigin: "https://savia-preview.hefesoft.com",
    }),
    events = [];
  const release = {
    environment: "preview",
    destination: "/tmp/not-created-full-release",
  };
  const dependencies = {
    env: {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      SAVIA_PREVIEW_RELEASE_BASE: "a".repeat(40),
    },
    readOutputs: async () => ({
      cloudflareAccountId: accountId,
      authD1Id: "auth-id",
      domainD1Id: "domain-id",
      documentsBucketName: names.bucket,
      resolvedEnvironment: "preview",
      resolvedPublicOrigin: names.publicOrigin,
      workerNames: names.workers,
      databaseNames: names.databases,
      deletionProtected: false,
      flowsEnabled: false,
      flowsResources: null,
      flowsExecutionEnabled: false,
      plannedFlowsResourceNames: names.flows,
      tenantSubdomains: [],
      vectorizeIndex: names.vectorizeIndex,
    }),
    client: { api: async () => ({ subdomain: "test-account" }) },
    render: async () => events.push("render"),
    run: async (binary, args) => {
      if (binary === "pnpm" && args[0] === "--version")
        return { stdout: "11.24.0\n" };
      if (binary === "git")
        return {
          stdout:
            args[0] === "rev-parse"
              ? "b".repeat(40)
              : args[0] === "diff"
                ? "apps/api/src/auth/admin-oauth.ts"
                : args[0] === "show"
                  ? "CREATE TABLE incompatible_change (id INTEGER)"
                  : "",
        };
      events.push(args.at(-1));
      return { stdout: "" };
    },
    freeze: async (options) => {
      assert.equal(options.codeOnly, undefined);
      assert.equal(options.configs.length, 9);
      events.push("freeze");
      return { artifactDigest: "c".repeat(64) };
    },
  };
  for (const accepted of [true, false]) {
    events.length = 0;
    await prepareEnvironmentRelease(release, {
      ...dependencies,
      env: {
        ...dependencies.env,
        GITHUB_REPOSITORY: "team/savia",
        SAVIA_PREVIEW_FRONTEND_ARTIFACT_DIR: "/secure/preview-warm-assets",
      },
      restoreFrontend: async ({
        directory,
        repository,
        revision,
        tree,
        pnpmVersion,
        env,
      }) => {
        assert.equal(directory, "/secure/preview-warm-assets");
        assert.equal(repository, "team/savia");
        assert.equal(revision, "b".repeat(40));
        assert.equal(tree, "b".repeat(40));
        assert.equal(pnpmVersion, "11.24.0");
        assert.equal(
          env.VITE_PLUGIN_EDITOR_RUNTIME_URL,
          "https://savia-plugin-editor-preview.test-account.workers.dev/plugin-editor",
        );
        events.push("verify");
        if (!accepted) throw new Error("Stale warmed asset inputs");
      },
    });
    assert.ok(events.includes("verify"));
    assert.equal(events.includes("build:plugin-editor"), !accepted);
    assert.equal(events.includes("build:assets"), !accepted);
    assert.ok(events.includes("freeze"));
  }
});
test("production preparation cannot build or read credentials outside reviewed main", async () => {
  await assert.rejects(
    prepareEnvironmentRelease(
      { environment: "production", destination: "/tmp/absent" },
      { env: {}, run: async () => assert.fail("spawned build") },
    ),
    /Production operations/,
  );
});

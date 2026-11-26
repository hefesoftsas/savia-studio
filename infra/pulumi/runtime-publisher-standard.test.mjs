import test from "node:test";
import assert from "node:assert/strict";
import {
  standardReleaseCommands,
  createStandardPublisher,
} from "./runtime-publisher-standard.mjs";
import { codeOnlyReleaseCommands } from "./runtime-publisher-code-only.mjs";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeArtifact } from "./runtime-publisher.mjs";
import { createRuntimeOperations } from "./runtime-operations.mjs";

async function codeOnlyFixture({
  targets,
  artifactTargets = targets,
  runtimeState = "active",
}) {
  const root = await mkdtemp(join(tmpdir(), "savia-code-only-release-"));
  const source = join(root, "source");
  await mkdir(join(source, "migrations"), { recursive: true });
  await writeFile(join(source, "migrations", "0000.sql"), "SELECT 1;");
  await writeFile(join(source, "worker.mjs"), "export default {};");
  await mkdir(join(source, "assets", "admin"), { recursive: true });
  await mkdir(join(source, "assets", "plugin-editor"), { recursive: true });
  await writeFile(join(source, "assets", "admin", "index.html"), "admin");
  await writeFile(
    join(source, "assets", "plugin-editor", "index.html"),
    "plugin editor",
  );
  const revision = "b".repeat(40);
  await writeFile(
    join(source, "release-source.json"),
    JSON.stringify({
      version: 1,
      sourceRevision: revision,
      codeOnly: { base: "a".repeat(40), head: revision, targets },
    }),
  );
  const names = [
    "savia-preview",
    "savia-agencies-preview",
    "savia-auth-preview",
    "savia-mcp-preview",
    "savia-request-preview",
    "savia-connectors-preview",
    "savia-hook-executor-preview",
    "savia-plugin-editor-preview",
  ];
  const artifact = await prepareRuntimeArtifact({
    environment: "preview",
    release: {
      directory: source,
      configs: Object.fromEntries(
        artifactTargets.map((target) => {
          const roleName = {
            gateway: "savia-preview",
            api: "savia-agencies-preview",
            mcp: "savia-mcp-preview",
            auth: "savia-auth-preview",
            request: "savia-request-preview",
            connectors: "savia-connectors-preview",
            pluginEditor: "savia-plugin-editor-preview",
          }[target];
          const config = { name: roleName, main: "worker.mjs" };
          if (target === "gateway")
            config.assets = { directory: "assets/admin" };
          if (target === "pluginEditor")
            config.assets = { directory: "assets/plugin-editor" };
          return [`${roleName}.json`, config];
        }),
      ),
    },
    destination: join(root, "artifact"),
  });
  const inputs = {
    ...artifact,
    accountId: "a".repeat(32),
    workers: names.map((name, i) => ({
      name,
      cloudId: String(i).padStart(32, "a"),
    })),
  };
  const env = {
    CLOUDFLARE_ACCOUNT_ID: inputs.accountId,
    SAVIA_DEPLOY_ENVIRONMENT: "preview",
    SAVIA_FLOWS_PROVISIONED: "false",
    SAVIA_FLOWS_RUNTIME_STATE: runtimeState,
    SAVIA_DOMAIN_D1_ID: "domain-id",
  };
  return { root, inputs, env };
}

test("standard commands preserve coordinator, backup, migration and publication order", () => {
  const options = {
    environment: "preview",
    provisionedFlows: true,
    desiredFlows: true,
    flowsPolicyGeneration: 100,
    configs: {
      backupCoordinator: "/f/coordinator.json",
      api: "/f/api.json",
      flows: "/f/flows.json",
      auth: "/f/auth.json",
      gateway: "/f/gateway.json",
    },
    recoveryDirectory: "/private/recovery",
  };
  const production = { ...options, environment: "production" };
  const productionPlan = standardReleaseCommands(production);
  assert.ok(productionPlan.backup.length > 0);
  assert.deepEqual(
    standardReleaseCommands({ ...production, backupEnabled: false }),
    {
      ...productionPlan,
      quiesce: productionPlan.quiesce.map((step) =>
        step.kind === "drain"
          ? {
              kind: "node",
              script: "scripts/flows-maintenance.mjs",
              args: ["--action", "drain", "--apply"],
            }
          : step,
      ),
      backup: [],
    },
  );
  const plan = standardReleaseCommands(options);
  assert.deepEqual(
    plan.quiesce.map((step) => step.kind),
    ["capture", "wrangler", "wrangler", "wrangler", "drain"],
  );
  assert.equal(plan.quiesce[1].config, "/f/coordinator.json");
  assert.equal(plan.quiesce[2].args.includes("SAVIA_MAINTENANCE:true"), true);
  assert.equal(
    plan.quiesce[3].args.includes("SAVIA_FLOWS_EXECUTION_ENABLED:false"),
    true,
  );
  assert.equal(plan.backup[0].script, "infra/pulumi/backup.mjs");
  assert.ok(plan.backup[0].args.includes("--export-flows-snapshot"));
  assert.ok(!plan.backup[0].args.includes("--flows-snapshot"));
  const concurrencyArg = plan.backup[0].args.indexOf("--r2-concurrency");
  assert.ok(concurrencyArg >= 0);
  assert.equal(plan.backup[0].args[concurrencyArg + 1], "8");
  assert.equal(plan.migrate[0].script, "scripts/apply-d1-migrations.mjs");
  assert.deepEqual(
    plan.deploy.map((step) => step.worker),
    ["auth", undefined, "flows", "api", "gateway"],
  );
  assert.equal(plan.deploy[1].script, "scripts/initialize-auth-deployment.mjs");
  assert.deepEqual(plan.deploy[1].args, [
    "--environment",
    "preview",
    "--config",
    "/f/auth.json",
  ]);
  assert.equal(
    plan.backup.some((step) => step.kind === "encrypt"),
    true,
  );
  const withLease = standardReleaseCommands({
    ...options,
    previewWriteGate: true,
  });
  assert.ok(withLease.quiesce[2].args.includes("SAVIA_MAINTENANCE:true"));
  assert.ok(
    withLease.quiesce[2].args.includes("SAVIA_FLOWS_EXECUTION_ENABLED:false"),
  );
  assert.ok(
    withLease.quiesce[2].args.includes("SAVIA_FLOWS_QUOTAS_ENABLED:false"),
  );
  assert.ok(withLease.quiesce[3].args.includes("SAVIA_FLOWS_MAINTENANCE:true"));
  assert.equal(withLease.quiesce[4].script, "scripts/flows-maintenance.mjs");
  assert.deepEqual(withLease.quiesce[4].args, ["--action", "drain", "--apply"]);
  assert.ok(!withLease.quiesce.some(({ kind }) => kind === "drain"));
  assert.throws(
    () =>
      standardReleaseCommands({
        ...options,
        environment: "production",
        previewWriteGate: true,
      }),
    /Preview write lease/,
  );
});

test("Preview can preserve provisioned Flows while publishing core runtime only", () => {
  const plan = standardReleaseCommands({
    environment: "preview",
    provisionedFlows: true,
    desiredFlows: true,
    manageFlows: false,
    flowsPolicyGeneration: 100,
    previewWriteGate: true,
    configs: {
      backupCoordinator: "/f/coordinator.json",
      api: "/f/api.json",
      flows: "/f/flows.json",
      auth: "/f/auth.json",
      gateway: "/f/gateway.json",
    },
    recoveryDirectory: "/private/recovery",
  });

  assert.deepEqual(
    plan.quiesce.map((step) => step.worker),
    ["backupCoordinator", "api"],
  );
  assert.ok(plan.quiesce.every((step) => step.kind !== "capture"));
  assert.ok(
    plan.quiesce.every(
      (step) =>
        !step.args?.includes("SAVIA_FLOWS_EXECUTION_ENABLED:false") &&
        !step.args?.includes("SAVIA_FLOWS_MAINTENANCE:true") &&
        !step.args?.some((arg) => arg.startsWith("SAVIA_FLOWS_POLICY_GENERATION:")),
    ),
  );
  assert.ok(
    plan.backup.every(
      (step) => !step.args?.includes("--export-flows-snapshot"),
    ),
  );
  assert.deepEqual(plan.migrate.map((step) => step.script), [
    "scripts/apply-d1-migrations.mjs",
  ]);
  assert.deepEqual(
    plan.deploy.filter((step) => step.kind === "wrangler").map((step) => step.worker),
    ["auth", "api", "gateway"],
  );
  assert.ok(!plan.verify.some((step) => step.script === "scripts/verify-flows-preview.mjs"));
});

test("Preview verifies the Flows drain before leasing writers and releases before migrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "savia-preview-write-lease-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "migrations"), { recursive: true });
    await writeFile(join(source, "worker.mjs"), "export default {};");
    const names = [
      "savia-preview",
      "savia-agencies-preview",
      "savia-auth-preview",
      "savia-mcp-preview",
      "savia-request-preview",
      "savia-connectors-preview",
      "savia-hook-executor-preview",
      "savia-backup-coordinator-preview",
      "savia-flows-preview",
    ];
    const artifact = await prepareRuntimeArtifact({
      environment: "preview",
      release: {
        directory: source,
        configs: Object.fromEntries(
          names.map((name) => [
            `${name}.json`,
            {
              name,
              main: "worker.mjs",
              vars: { SAVIA_FLOWS_POLICY_GENERATION: "2" },
            },
          ]),
        ),
      },
      destination: join(root, "artifact"),
    });
    const accountId = "a".repeat(32);
    const inputs = {
      ...artifact,
      accountId,
      workers: names.map((name, index) => ({
        name,
        cloudId: String(index).padStart(32, "a"),
      })),
    };
    const env = {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      SAVIA_DEPLOY_ENVIRONMENT: "preview",
      SAVIA_FLOWS_PROVISIONED: "true",
      SAVIA_DOMAIN_D1_ID: "domain-id",
    };
    for (const key of [
      "BETTER_AUTH_SECRET",
      "SAVIA_MCP_SHARED_SECRET",
      "SAVIA_REQUEST_ENCRYPTION_KEY",
      "EXTENSION_CONNECTIONS_ENCRYPTION_KEY",
      "ASSISTANT_SETTINGS_ENCRYPTION_KEY",
      "STUDIO_INTEGRATION_KEY",
      "NANGO_API_KEY",
      "SAVIA_BACKUP_KEY",
      "SAVIA_BACKUP_CONTROL_SECRET",
      "SAVIA_FLOWS_BRIDGE_SECRET",
      "SAVIA_FLOWS_JWT_SECRET",
      "SAVIA_FLOWS_SECRET_MASTER_KEY",
      "SAVIA_FLOWS_FORM_SIGNING_KEY",
    ])
      env[key] = "a".repeat(64);
    for (const failure of [
      null,
      "credential",
      "pending",
      "held",
      "lease",
      "backup-disabled",
    ]) {
      const events = [];
      let credentialFile;
      const fetchImpl = async (url, options) => {
        assert.equal(
          url,
          "https://savia-preview.hefesoft.com/api/_internal/backup-gate/status",
        );
        assert.match(JSON.parse(options.body).owner, /^[a-f\d-]{36}$/i);
        events.push("probe");
        if (failure === "credential")
          return new Response(null, { status: 401 });
        if (failure === "held") return new Response(null, { status: 409 });
        return Response.json({
          owner: null,
          expiresAt: null,
          active: failure === "pending" ? 1 : 0,
          drained: failure !== "pending",
        });
      };
      const publisher = await createStandardPublisher(inputs, {
        env:
          failure === "backup-disabled"
            ? {
                ...env,
                SAVIA_PREVIEW_BACKUP_ENABLED: "false",
                SAVIA_BACKUP_KEY: undefined,
              }
            : env,
        root,
        recoveryDirectory: join(root, failure ?? "recovery"),
        capture: async () => {},
        encrypt: async () => {},
        sleep: async (milliseconds) => {
          assert.equal(failure, "credential");
          assert.equal(milliseconds, 45_000);
          events.push("fixed-drain");
        },
        runWrangler: async (args) => {
          if (!args.includes("--secrets-file")) return;
          assert.equal(args[0], "deploy");
          assert.ok(!args.includes("SAVIA_MAINTENANCE:true"));
          credentialFile = args[args.indexOf("--secrets-file") + 1];
          assert.deepEqual(JSON.parse(await readFile(credentialFile, "utf8")), {
            SAVIA_BACKUP_CONTROL_SECRET: env.SAVIA_BACKUP_CONTROL_SECRET,
          });
          events.push("attach-credential");
        },
        openWriteControl: async () => {
          events.push("open-control");
          return { fetchImpl, close: async () => events.push("close-control") };
        },
        withWriteLease: async (
          capture,
          { env: leaseEnv, fetchImpl: leaseFetch },
        ) => {
          assert.equal(leaseFetch, fetchImpl);
          assert.equal(
            leaseEnv.SAVIA_BACKUP_CONTROL_URL,
            "https://savia-preview.hefesoft.com/api/_internal/backup-gate",
          );
          events.push("lease");
          if (failure === "lease") throw new Error("Lease denied");
          await capture();
          events.push("release");
        },
        run: async (binary, args) => {
          if (
            args[0]?.endsWith("flows-maintenance.mjs") &&
            args.includes("drain")
          )
            events.push("drain");
          if (args[0]?.endsWith("infra/pulumi/backup.mjs"))
            events.push("capture");
          if (binary === "tar") events.push("archive");
          if (args[0]?.endsWith("apply-d1-migrations.mjs"))
            events.push("migrate");
          if (
            failure === "backup-disabled" &&
            args[0]?.endsWith("verify-preview-health.mjs")
          )
            events.push("verify");
        },
      });
      if (failure === "credential") {
        await publisher.publish();
        assert.deepEqual(events, [
          "open-control",
          "probe",
          "fixed-drain",
          "capture",
          "archive",
          "migrate",
          "attach-credential",
          "close-control",
        ]);
        await assert.rejects(readFile(credentialFile), { code: "ENOENT" });
      } else if (failure === "held") {
        await assert.rejects(publisher.publish(), /lease is already held/i);
        assert.deepEqual(events, ["open-control", "probe", "close-control"]);
      } else if (failure === "pending") {
        await assert.rejects(publisher.publish(), /reports pending writers/i);
        assert.deepEqual(events, ["open-control", "probe", "close-control"]);
      } else if (failure === "lease") {
        await assert.rejects(publisher.publish(), /Lease denied/);
        assert.deepEqual(events, [
          "open-control",
          "probe",
          "drain",
          "lease",
          "close-control",
        ]);
      } else if (failure === "backup-disabled") {
        await publisher.publish();
        assert.deepEqual(events, [
          "drain",
          "migrate",
          "attach-credential",
          "verify",
        ]);
        await assert.rejects(readFile(credentialFile), { code: "ENOENT" });
      } else {
        await publisher.publish();
        assert.deepEqual(events, [
          "open-control",
          "probe",
          "drain",
          "lease",
          "capture",
          "release",
          "archive",
          "migrate",
          "attach-credential",
          "close-control",
        ]);
        await assert.rejects(readFile(credentialFile), { code: "ENOENT" });
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the concrete standard publisher uses existing helpers and never places secrets in arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "savia-standard-release-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await mkdir(join(source, "migrations"));
    await writeFile(join(source, "migrations", "0000.sql"), "SELECT 1;");
    await writeFile(join(source, "worker.mjs"), "export default {};");
    const names = [
      "savia-preview",
      "savia-agencies-preview",
      "savia-auth-preview",
      "savia-mcp-preview",
      "savia-request-preview",
      "savia-connectors-preview",
      "savia-hook-executor-preview",
    ];
    const artifact = await prepareRuntimeArtifact({
      environment: "preview",
      release: {
        directory: source,
        configs: Object.fromEntries(
          names.map((name) => [`${name}.json`, { name, main: "worker.mjs" }]),
        ),
      },
      destination: join(root, "artifact"),
    });
    const inputs = {
      ...artifact,
      accountId: "a".repeat(32),
      workers: names.map((name, i) => ({
        name,
        cloudId: String(i).padStart(32, "a"),
      })),
    };
    const env = {
      CLOUDFLARE_ACCOUNT_ID: inputs.accountId,
      SAVIA_DEPLOY_ENVIRONMENT: "preview",
      SAVIA_FLOWS_PROVISIONED: "false",
      SAVIA_DOMAIN_D1_ID: "domain-id",
      SAVIA_BACKUP_KEY: "a".repeat(64),
    };
    for (const key of [
      "BETTER_AUTH_SECRET",
      "SAVIA_MCP_SHARED_SECRET",
      "SAVIA_REQUEST_ENCRYPTION_KEY",
      "EXTENSION_CONNECTIONS_ENCRYPTION_KEY",
      "ASSISTANT_SETTINGS_ENCRYPTION_KEY",
      "STUDIO_INTEGRATION_KEY",
      "NANGO_API_KEY",
    ])
      env[key] = "SECRET_CANARY";
    const calls = [];
    let activeSecretUploads = 0;
    let maximumSecretUploads = 0;
    const deps = {
      env,
      root,
      recoveryDirectory: join(root, "recovery"),
      encrypt: async () => {},
      run: async (binary, args, options) =>
        calls.push({ binary, args, input: options.input }),
      runWrangler: async (args, options) => {
        calls.push({ binary: "wrangler", args, input: options.input });
        if (args[0] === "versions" && args[1] === "secret") {
          activeSecretUploads++;
          maximumSecretUploads = Math.max(
            maximumSecretUploads,
            activeSecretUploads,
          );
          await new Promise((resolve) => setImmediate(resolve));
          activeSecretUploads--;
        } else if (
          args[0] === "deploy" &&
          !args.includes("SAVIA_MAINTENANCE:true")
        ) {
          assert.equal(activeSecretUploads, 0);
        }
      },
    };
    const publisher = await createStandardPublisher(inputs, deps);
    await publisher.publish();
    assert.equal(maximumSecretUploads, 2);
    const pause = calls.findIndex((row) =>
      row.args.includes("SAVIA_MAINTENANCE:true"),
    );
    const backup = calls.findIndex((row) =>
      row.args[0]?.endsWith("infra/pulumi/backup.mjs"),
    );
    const migrate = calls.findIndex((row) =>
      row.args[0]?.endsWith("scripts/apply-d1-migrations.mjs"),
    );
    assert.ok(pause >= 0 && backup > pause && migrate > backup);
    assert.ok(calls[migrate].args.includes("--migrations-dir"));
    assert.equal(
      calls.some((row) => row.input?.includes("SECRET_CANARY")),
      true,
    );
    assert.ok(
      calls
        .filter(
          (row) => row.binary === "wrangler" && row.args.includes("secret"),
        )
        .every(
          (row) =>
            row.args[0] === "versions" &&
            row.args[1] === "secret" &&
            row.args[2] === "bulk",
        ),
    );
    assert.equal(
      JSON.stringify(calls.map((row) => row.args)).includes("SECRET_CANARY"),
      false,
    );
    calls.length = 0;
    await assert.rejects(
      createStandardPublisher(inputs, {
        ...deps,
        env: { ...env, CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) },
      }),
      /mismatch/,
    );
    assert.deepEqual(calls, []);
    const blocked = await createStandardPublisher(inputs, {
      ...deps,
      run: async (binary, args, options) => {
        calls.push({ binary, args, input: options.input });
        if (args[0]?.endsWith("scripts/initialize-auth-deployment.mjs"))
          throw new Error("Auth preparation failed");
      },
    });
    await assert.rejects(blocked.publish(), /Auth preparation failed/);
    assert.equal(
      calls.some(
        (row) =>
          row.binary === "wrangler" &&
          row.args[0] === "deploy" &&
          row.args.some((arg) => /savia-agencies-preview\.json$/.test(arg)) &&
          !row.args.includes("SAVIA_MAINTENANCE:true"),
      ),
      false,
    );
    assert.equal(
      calls.some(
        (row) =>
          row.binary === "wrangler" &&
          row.args[0] === "deploy" &&
          row.args.some((arg) => /\/savia-preview\.json$/.test(arg)),
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Preview CI flow opt-out needs no Flows bundle and preserves its API binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "savia-core-only-release-"));
  try {
    const source = join(root, "source");
    await mkdir(join(source, "migrations"), { recursive: true });
    await writeFile(join(source, "migrations", "0000.sql"), "SELECT 1;");
    await writeFile(join(source, "worker.mjs"), "export default {};");
    const names = [
      "savia-preview",
      "savia-agencies-preview",
      "savia-auth-preview",
      "savia-mcp-preview",
      "savia-request-preview",
      "savia-connectors-preview",
      "savia-hook-executor-preview",
      "savia-flows-preview",
    ];
    const artifact = await prepareRuntimeArtifact({
      environment: "preview",
      release: {
        directory: source,
        configs: Object.fromEntries(
          names
            .filter((name) => name !== "savia-flows-preview")
            .map((name) => [
              `${name}.json`,
              {
                name,
                main: "worker.mjs",
                ...(name === "savia-agencies-preview"
                  ? {
                      services: [
                        {
                          binding: "SAVIA_FLOWS",
                          service: "savia-flows-preview",
                        },
                      ],
                    }
                  : {}),
              },
            ]),
        ),
      },
      destination: join(root, "artifact"),
    });
    const accountId = "a".repeat(32);
    const inputs = {
      ...artifact,
      accountId,
      workers: names.map((name, index) => ({
        name,
        cloudId: String(index).padStart(32, "a"),
      })),
    };
    const env = {
      CLOUDFLARE_ACCOUNT_ID: accountId,
      SAVIA_DEPLOY_ENVIRONMENT: "preview",
      SAVIA_CI_FLOWS_ENABLED: "false",
      SAVIA_FLOWS_PROVISIONED: "true",
      SAVIA_DOMAIN_D1_ID: "domain-id",
      SAVIA_BACKUP_KEY: "a".repeat(64),
      SAVIA_FLOWS_BRIDGE_SECRET: "bridge-secret-".padEnd(64, "a"),
      SAVIA_FLOWS_JWT_SECRET: "jwt-secret-".padEnd(64, "a"),
      SAVIA_FLOWS_SECRET_MASTER_KEY: "b".repeat(64),
      SAVIA_FLOWS_FORM_SIGNING_KEY: "form-secret-".padEnd(64, "a"),
      BETTER_AUTH_SECRET: "auth-secret",
      SAVIA_MCP_SHARED_SECRET: "mcp-secret",
      SAVIA_REQUEST_ENCRYPTION_KEY: "request-key",
      EXTENSION_CONNECTIONS_ENCRYPTION_KEY: "connection-key",
      ASSISTANT_SETTINGS_ENCRYPTION_KEY: "assistant-key",
      STUDIO_INTEGRATION_KEY: "studio-key",
      NANGO_API_KEY: "nango-key",
    };
    const calls = [];
    const publisher = await createStandardPublisher(inputs, {
      env,
      root,
      recoveryDirectory: join(root, "recovery"),
      capture: async () =>
        assert.fail("Flows recovery capture must be skipped"),
      encrypt: async () => {},
      openWriteControl: async () =>
        assert.fail("Flows opt-out must not use the Flows write lease"),
      run: async (binary, args) => calls.push({ binary, args }),
      runWrangler: async (args) => calls.push({ binary: "wrangler", args }),
    });

    await publisher.publish();

    const flowWorkerConfig = join(
      inputs.artifactDirectory,
      "savia-flows-preview.json",
    );
    const apiConfig = JSON.parse(
      await readFile(
        join(inputs.artifactDirectory, "savia-agencies-preview.json"),
        "utf8",
      ),
    );
    assert.deepEqual(apiConfig.services, [
      { binding: "SAVIA_FLOWS", service: "savia-flows-preview" },
    ]);
    assert.ok(
      !calls.some(
        ({ args }) =>
          args.includes(flowWorkerConfig) ||
          args.some(
            (arg) =>
              arg.endsWith("scripts/flows-maintenance.mjs") ||
              arg.endsWith("scripts/verify-flows-preview.mjs") ||
              arg === "savia-flows-preview",
          ),
      ),
    );
    assert.ok(
      !calls.some(
        ({ binary, args }) =>
          binary === "wrangler" &&
          (args.includes("SAVIA_FLOWS_EXECUTION_ENABLED:false") ||
            args.includes("SAVIA_FLOWS_MAINTENANCE:true")),
      ),
    );
    const apiDeploy = calls.find(
      ({ binary, args }) =>
        binary === "wrangler" &&
        args[0] === "deploy" &&
        args.includes(
          join(inputs.artifactDirectory, "savia-agencies-preview.json"),
        ),
    );
    assert.ok(apiDeploy);
    assert.ok(
      calls.some(
        ({ binary, args }) =>
          binary === "wrangler" &&
          args[0] === "versions" &&
          args[1] === "secret" &&
          args.includes(
            join(inputs.artifactDirectory, "savia-agencies-preview.json"),
          ),
      ),
      "core API secrets including its existing Flows bridge stay on the API Worker",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("code-only publication deploys only scoped preview Workers without stateful release steps", async () => {
  const fixture = await codeOnlyFixture({
    targets: ["api", "auth"],
  });
  try {
    const calls = [];
    const publisher = await createStandardPublisher(fixture.inputs, {
      env: fixture.env,
      root: fixture.root,
      client: {
        readSnapshot: async () => ({ maintenanceWorkerNames: [] }),
      },
      recoveryDirectory: join(fixture.root, "recovery"),
      encrypt: async () => {},
      run: async (binary, args) => calls.push({ binary, args }),
      runWrangler: async (args) => calls.push({ binary: "wrangler", args }),
    });

    await publisher.publish();

    const deployments = calls.filter(
      (call) => call.binary === "wrangler" && call.args[0] === "deploy",
    );
    assert.deepEqual(
      deployments.map((call) => call.args[call.args.indexOf("--config") + 1]),
      [
        join(fixture.inputs.artifactDirectory, "savia-auth-preview.json"),
        join(fixture.inputs.artifactDirectory, "savia-agencies-preview.json"),
      ],
    );
    assert.ok(
      deployments.every(
        (call) =>
          call.args.length === 3 &&
          call.args[0] === "deploy" &&
          call.args[1] === "--config",
      ),
    );
    const authDeploy = calls.findIndex(
      (call) =>
        call.binary === "wrangler" &&
        call.args[0] === "deploy" &&
        call.args.some((arg) => arg.endsWith("savia-auth-preview.json")),
    );
    const authInitialize = calls.findIndex(
      (call) =>
        call.binary === "node" &&
        call.args.some((arg) =>
          arg.endsWith("scripts/initialize-auth-deployment.mjs"),
        ),
    );
    const apiDeploy = calls.findIndex(
      (call) =>
        call.binary === "wrangler" &&
        call.args[0] === "deploy" &&
        call.args.some((arg) => arg.endsWith("savia-agencies-preview.json")),
    );
    assert.ok(authDeploy >= 0 && authInitialize > authDeploy);
    assert.ok(authInitialize < apiDeploy);
    assert.ok(
      calls.some(
        (call) =>
          call.binary === "node" &&
          call.args.some((arg) =>
            arg.endsWith("scripts/verify-preview-health.mjs"),
          ),
      ),
    );
    assert.deepEqual(
      calls
        .filter((call) => call.binary === "node")
        .map((call) => call.args[0].split("/").slice(-2).join("/")),
      [
        "scripts/initialize-auth-deployment.mjs",
        "scripts/verify-preview-health.mjs",
      ],
    );
    assert.equal(
      calls.some(
        (call) =>
          (call.binary === "node" &&
            /backup|apply-d1-migrations|flows-maintenance/.test(
              call.args.join(" "),
            )) ||
          (call.binary === "wrangler" && call.args.includes("secret")),
      ),
      false,
    );
    const callsBeforeRecovery = calls.length;
    await publisher.recover();
    assert.equal(calls.length, callsBeforeRecovery);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("code-only preflight rejects a maintenance runtime before publication", async () => {
  const fixture = await codeOnlyFixture({ targets: ["api"] });
  try {
    const calls = [];
    await assert.rejects(
      createStandardPublisher(fixture.inputs, {
        env: fixture.env,
        root: fixture.root,
        client: {
          readSnapshot: async () => ({
            maintenanceWorkerNames: ["savia-preview"],
          }),
        },
        recoveryDirectory: join(fixture.root, "recovery"),
        run: async (...args) => calls.push(args),
        runWrangler: async (...args) => calls.push(args),
      }),
      /active runtime/,
    );
    assert.deepEqual(calls, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a verified code-only artifact does not repeat bootstrap for existing Workers", async () => {
  const fixture = await codeOnlyFixture({ targets: ["mcp", "api"] });
  try {
    let snapshots = 0;
    const operations = createRuntimeOperations(
      { ...fixture.inputs, mode: "release" },
      {
        root: fixture.root,
        env: {
          ...fixture.env,
          SAVIA_RUNTIME_OPERATION_DIRECTORY: join(fixture.root, "operations"),
        },
        client: {
          readSnapshot: async () => {
            snapshots++;
            return { maintenanceWorkerNames: [], workerVersions: [] };
          },
          api: async () =>
            assert.fail(
              "Bootstrap must not inspect already verified Worker settings",
            ),
        },
        runWrangler: async () => assert.fail("Bootstrap must not deploy"),
      },
    );
    await operations.verifyArtifact();
    assert.deepEqual(await operations.bootstrap(), { createdWorkers: [] });
    assert.equal(snapshots, 1);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("code-only preflight rejects artifact targets outside the exact verified scope", async () => {
  const fixture = await codeOnlyFixture({
    targets: ["api"],
    artifactTargets: ["api", "connectors"],
  });
  try {
    const calls = [];
    await assert.rejects(
      createStandardPublisher(fixture.inputs, {
        env: fixture.env,
        root: fixture.root,
        client: { readSnapshot: async () => ({ maintenanceWorkerNames: [] }) },
        recoveryDirectory: join(fixture.root, "recovery"),
        run: async (...args) => calls.push(args),
        runWrangler: async (...args) => calls.push(args),
      }),
      /exact|scope/i,
    );
    assert.deepEqual(calls, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("frontend code-only publication requires both Workers and deploys their frozen assets in order", async () => {
  const fixture = await codeOnlyFixture({
    targets: ["gateway", "pluginEditor", "api", "mcp"],
  });
  try {
    const calls = [];
    const deploymentUrl =
      "https://savia-plugin-editor-preview.account.workers.dev";
    fixture.env.SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL = deploymentUrl;
    const publisher = await createStandardPublisher(fixture.inputs, {
      env: fixture.env,
      root: fixture.root,
      client: { readSnapshot: async () => ({ maintenanceWorkerNames: [] }) },
      recoveryDirectory: join(fixture.root, "recovery"),
      run: async (binary, args, options) =>
        calls.push({ binary, args, env: options.env }),
      runWrangler: async (args, options) =>
        calls.push({ binary: "wrangler", args, cwd: options.cwd }),
    });
    await publisher.publish();

    const deployments = calls.filter(
      (call) => call.binary === "wrangler" && call.args[0] === "deploy",
    );
    assert.deepEqual(
      deployments.map((call) => call.args[call.args.indexOf("--config") + 1]),
      [
        join(fixture.inputs.artifactDirectory, "savia-mcp-preview.json"),
        join(fixture.inputs.artifactDirectory, "savia-agencies-preview.json"),
        join(
          fixture.inputs.artifactDirectory,
          "savia-plugin-editor-preview.json",
        ),
        join(fixture.inputs.artifactDirectory, "savia-preview.json"),
      ],
    );
    assert.equal(
      await readFile(
        join(fixture.inputs.artifactDirectory, "assets", "admin", "index.html"),
        "utf8",
      ),
      "admin",
    );
    assert.equal(
      await readFile(
        join(
          fixture.inputs.artifactDirectory,
          "assets",
          "plugin-editor",
          "index.html",
        ),
        "utf8",
      ),
      "plugin editor",
    );
    assert.equal(
      calls.some(
        (call) =>
          call.binary === "node" &&
          /backup|apply-d1-migrations|flows-maintenance|initialize-auth/.test(
            call.args.join(" "),
          ),
      ),
      false,
    );
    assert.equal(
      calls.some(
        (call) => call.binary === "wrangler" && call.args.includes("secret"),
      ),
      false,
    );
    assert.deepEqual(
      calls
        .filter((call) => call.binary === "node")
        .map((call) => call.args[0].split("/").slice(-2).join("/")),
      [
        "scripts/configure-plugin-editor-preview.mjs",
        "scripts/verify-preview-health.mjs",
      ],
    );
    assert.equal(
      calls.find((call) =>
        call.args[0]?.endsWith("configure-plugin-editor-preview.mjs"),
      ).env.PLUGIN_EDITOR_DEPLOYMENT_URL,
      deploymentUrl,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("code-only scopes fail closed on unknown, malformed, production, and paused scopes", () => {
  const revision = "b".repeat(40);
  const configs = { api: "/artifact/api.json" };
  const scoped = (targets = ["api"]) => ({
    version: 1,
    sourceRevision: revision,
    codeOnly: { base: "a".repeat(40), head: revision, targets },
  });
  const plan = (
    releaseSource,
    environment = "preview",
    runtimeState = "active",
  ) =>
    codeOnlyReleaseCommands({
      releaseSource,
      environment,
      runtimeState,
      configs,
    });

  assert.throws(() => plan(scoped(["unknown"])), /scope/);
  assert.throws(() => plan(scoped(["api", "api"])), /scope/);
  assert.throws(() => plan(scoped(["pluginEditor"])), /scope/);
  assert.throws(() => plan(scoped(["gateway"])), /scope/);
  assert.throws(
    () => plan(scoped(["auth", "gateway", "pluginEditor"])),
    /scope/,
  );
  assert.throws(
    () =>
      plan({
        ...scoped(),
        codeOnly: { ...scoped().codeOnly, head: "c".repeat(40) },
      }),
    /scope/,
  );
  assert.throws(() => plan(scoped(), "production"), /preview/);
  assert.throws(() => plan(scoped(), "preview", "maintenance"), /active/);
  assert.throws(
    () =>
      codeOnlyReleaseCommands({
        releaseSource: scoped(["gateway"]),
        environment: "preview",
        runtimeState: "active",
        configs: { ...configs, gateway: "/artifact/gateway.json" },
      }),
    /scope/,
  );
});

test("assistant API/MCP code-only publication deploys MCP before API and verifies health", () => {
  const revision = "b".repeat(40);
  const plan = codeOnlyReleaseCommands({
    releaseSource: {
      version: 1,
      sourceRevision: revision,
      codeOnly: {
        base: "a".repeat(40),
        head: revision,
        targets: ["mcp", "api"],
      },
    },
    environment: "preview",
    runtimeState: "active",
    configs: { mcp: "/artifact/mcp.json", api: "/artifact/api.json" },
  });
  assert.deepEqual(
    plan.deploy.map((step) => step.worker),
    ["mcp", "api"],
  );
  assert.deepEqual(
    plan.verify.map((step) => step.script),
    ["scripts/verify-preview-health.mjs"],
  );
});

test("a first install skips existing-data capture but keeps the dependency order", () => {
  const plan = standardReleaseCommands({
    environment: "preview",
    provisionedFlows: false,
    desiredFlows: false,
    configs: {
      api: "/f/api.json",
      auth: "/f/auth.json",
      gateway: "/f/gateway.json",
    },
    recoveryDirectory: "/private/recovery",
  });
  assert.deepEqual(
    plan.quiesce.map((step) => step.worker),
    ["api"],
  );
  assert.equal(plan.backup[0].script, "infra/pulumi/backup.mjs");
  assert.equal(plan.backup[0].args.includes("--flows-snapshot"), false);
  assert.deepEqual(
    plan.deploy.map((step) => step.worker),
    ["auth", undefined, "api", "gateway"],
  );
  assert.throws(
    () => standardReleaseCommands({ environment: "other", configs: {} }),
    /environment/,
  );
  assert.throws(
    () =>
      standardReleaseCommands({
        environment: "preview",
        provisionedFlows: true,
        desiredFlows: false,
        configs: {},
      }),
    /preserve|Flows/,
  );
});

test("restoring retained maintenance hosts skips active-policy capture but still pauses and backs up all Flows data", () => {
  const plan = standardReleaseCommands({
    environment: "preview",
    provisionedFlows: true,
    desiredFlows: true,
    flowsPolicyGeneration: 100,
    runtimeState: "maintenance",
    configs: {
      api: "/f/api.json",
      auth: "/f/auth.json",
      gateway: "/f/gateway.json",
      flows: "/f/flows.json",
      backupCoordinator: "/f/coordinator.json",
    },
    recoveryDirectory: "/private/recovery",
  });
  assert.equal(
    plan.quiesce.some((step) => step.kind === "capture"),
    false,
  );
  assert.equal(
    plan.quiesce.filter((step) => step.kind === "wrangler").length,
    3,
  );
  assert.ok(
    plan.backup.some(
      (step) =>
        step.script === "infra/pulumi/backup.mjs" &&
        step.args.includes("--export-flows-snapshot"),
    ),
  );
});

test("the backup pause consumes a lower generation than the one immutable final release", () => {
  const plan = standardReleaseCommands({
    environment: "preview",
    provisionedFlows: true,
    desiredFlows: true,
    flowsPolicyGeneration: 100,
    configs: {
      api: "/f/api.json",
      auth: "/f/auth.json",
      gateway: "/f/gateway.json",
      flows: "/f/flows.json",
    },
    recoveryDirectory: "/private/recovery",
  });
  const paused = plan.quiesce.find((step) => step.worker === "flows");
  assert.ok(paused.args.includes("SAVIA_FLOWS_POLICY_GENERATION:99"));
});

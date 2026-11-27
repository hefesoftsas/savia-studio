import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import test from "node:test";

import {
  execFileWithInput,
  parseWorkersDevUrl,
  requireGatewayOrigin,
  workerDeploymentOrder,
  workerConfig,
} from "./preview-deploy.mjs";
import { previewNames } from "./preview-environment.mjs";
import { runPreviewUpdate } from "./preview-update.mjs";

function migrationSnapshot(args, options = []) {
  const [script, flag, directory, ...rest] = args;
  assert.equal(script, "scripts/apply-d1-migrations.mjs");
  assert.equal(flag, "--migrations-dir");
  assert.ok(isAbsolute(directory));
  assert.deepEqual(rest, options);
  return directory;
}

async function recordWorkerBundle(args, extraExports = "") {
  const configPath = args[args.indexOf("--config") + 1];
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const code = `// compiled ${config.name}\nexport default {};\n${extraExports}`;
  if (args.includes("--dry-run")) {
    assert.ok(args.includes("--outdir"));
    assert.ok(args.includes("--metafile"));
    const entry = join(args[args.indexOf("--outdir") + 1], "worker.mjs");
    await writeFile(entry, code);
    await writeFile(
      args[args.indexOf("--metafile") + 1],
      JSON.stringify({
        outputs: {
          [entry]: {
            entryPoint: config.main,
            exports: (config.durable_objects?.bindings ?? []).map(
              ({ class_name }) => class_name,
            ),
          },
        },
      }),
    );
  } else {
    assert.equal(config.no_bundle, true);
    assert.equal(config.find_additional_modules, true);
    assert.equal(
      await readFile(join(dirname(configPath), config.main), "utf8"),
      code,
    );
  }
  return config;
}

test("manual update plans only the requested isolated Preview components in order", async () => {
  const result = await runPreviewUpdate([
    "--branch",
    "dev/manual",
    "web",
    "api",
    "request",
    "auth",
    "db",
  ]);
  assert.deepEqual(result, {
    status: "planned",
    environment: "branch-dev-manual",
    targets: [
      { component: "db", name: "savia-agencies-preview-dev-manual" },
      { component: "auth", name: "savia-auth-preview-dev-manual" },
      { component: "request", name: "savia-request-preview-dev-manual" },
      { component: "api", name: "savia-agencies-preview-dev-manual" },
      { component: "web", name: "savia-preview-dev-manual" },
    ],
  });
  const web = await runPreviewUpdate(["--branch", "dev/manual", "web"]);
  assert.deepEqual(
    web.targets.map(({ component }) => component),
    ["web"],
  );
  await assert.rejects(
    runPreviewUpdate(["--branch", "production", "api", "--apply"]),
    /protected ref/,
  );
  await assert.rejects(
    runPreviewUpdate(["--branch", "dev/manual", "flows"]),
    /Unknown/,
  );
  await assert.rejects(
    runPreviewUpdate([
      "--branch",
      "dev/manual",
      "api",
      "--restore-auth-bootstrap",
    ]),
    /Use --restore-auth-bootstrap with the auth component/,
  );
});

test("rejects a manual update when another known branch has the same Preview name", async () => {
  await assert.rejects(
    runPreviewUpdate(["--branch", "dev/booking", "api", "--apply"], {
      makeClient: () =>
        assert.fail("ambiguity must stop before Cloudflare access"),
      run: async (_command, args) =>
        args[0] === "check-ref-format"
          ? { stdout: "dev/booking\n" }
          : {
              stdout:
                "refs/heads/dev/booking\nrefs/remotes/origin/dev-booking\n",
            },
    }),
    /dev\/booking.*dev-booking/,
  );
});

test("manual update publishes the prepared Workers and migrations when the checkout changes later", async (t) => {
  const names = previewNames("dev-manual");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const authDatabaseId = "f1235678-1234-1234-1234-123456789012";
  const domainMigrations = await mkdtemp(
    join(tmpdir(), "savia-preview-input-"),
  );
  t.after(() => rm(domainMigrations, { recursive: true, force: true }));
  await writeFile(join(domainMigrations, "0001_fixture.sql"), "SELECT 1;");
  const calls = [];
  const backendStarted = Promise.withResolvers();
  let webOutput;
  let webReady = false;
  await runPreviewUpdate(
    [
      "--branch",
      "dev-manual",
      "web",
      "api",
      "db",
      "request",
      "auth",
      "--apply",
    ],
    {
      domainMigrations,
      env: { CLOUDFLARE_API_TOKEN: "test-only" },
      makeClient: () => ({
        list: async (path) =>
          path === "/workers/workers"
            ? Object.values(names.workers).map((name) => ({ name }))
            : [
                { name: "savia-agencies", uuid: "production-id" },
                { name: names.databases.domain, uuid: databaseId },
                { name: names.databases.auth, uuid: authDatabaseId },
              ],
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args, { env } = {}) => {
        if (command === "git" && args[0] === "for-each-ref")
          return {
            stdout:
              "refs/heads/dev/manual\nrefs/remotes/origin/dev/manual\nrefs/heads/main\n",
          };
        if (command === "git") return { stdout: "dev-manual\n" };
        if (command === "node") {
          assert.equal(env.CLOUDFLARE_DATABASE_ID, databaseId);
          const checking = args.includes("--check");
          const snapshot = migrationSnapshot(
            args,
            checking ? ["--check", "--allow-pending"] : [],
          );
          assert.notEqual(snapshot, domainMigrations);
          assert.deepEqual(await readdir(snapshot), ["0001_fixture.sql"]);
          assert.equal(
            await readFile(join(snapshot, "0001_fixture.sql"), "utf8"),
            "SELECT 1;",
          );
          calls.push(checking ? "check db" : "db");
        } else if (args.includes("wrangler")) {
          if (args.includes("--dry-run")) {
            assert.equal(env.pnpm_config_verify_deps_before_run, "error");
            assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
          }
          const config = await recordWorkerBundle(args);
          assert.equal(config.keep_vars, true);
          assert.equal(config.ai, undefined);
          assert.ok(
            (config.services ?? []).every(({ service }) =>
              Object.values(names.workers).includes(service),
            ),
          );
          if (config.name === names.workers.gateway) {
            assert.ok(webReady, "the gateway needs the completed web assets");
            assert.equal(config.assets.directory, webOutput);
            if (args.includes("--dry-run")) {
              await writeFile(
                join(domainMigrations, "0001_fixture.sql"),
                "SELECT 2;",
              );
              await writeFile(
                join(domainMigrations, "0002_late.sql"),
                "SELECT 3;",
              );
            }
          }
          if (config.name === names.workers.auth) {
            assert.equal(config.d1_databases[0].database_id, authDatabaseId);
            assert.equal(config.vars.BETTER_AUTH_BOOTSTRAP_EMAIL, undefined);
            assert.equal(config.vars.BETTER_AUTH_BOOTSTRAP_PASSWORD, undefined);
          }
          calls.push(
            `${args.includes("--dry-run") ? "prepare" : "publish"} ${config.name}`,
          );
          if (config.name === names.workers.auth && args.includes("--dry-run"))
            backendStarted.resolve();
        } else {
          assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
          assert.equal(env.SAVIA_CI_FLOWS_ENABLED, "false");
          assert.equal(env.SAVIA_ADMIN_IGNORE_ENV_FILES, "true");
          if (args.at(-1) === "typecheck") {
            assert.equal(env.pnpm_config_verify_deps_before_run, undefined);
            calls.push("typecheck web");
            return;
          }
          assert.equal(args.at(-1), "build:assets");
          assert.equal(env.pnpm_config_verify_deps_before_run, "error");
          webOutput = env.SAVIA_ADMIN_OUT_DIR;
          assert.match(webOutput, /savia-preview-update-.*[/\\]web-assets$/);
          calls.push("build web");
          const timeout = setTimeout(
            () =>
              backendStarted.reject(
                new Error(
                  "Worker preparation did not start during the web build",
                ),
              ),
            5000,
          );
          try {
            await backendStarted.promise;
            webReady = true;
          } finally {
            clearTimeout(timeout);
          }
        }
      },
    },
  );
  assert.deepEqual(calls, [
    "check db",
    "typecheck web",
    "build web",
    `prepare ${names.workers.auth}`,
    `prepare ${names.workers.request}`,
    `prepare ${names.workers.api}`,
    `prepare ${names.workers.gateway}`,
    "db",
    `publish ${names.workers.auth}`,
    `publish ${names.workers.request}`,
    `publish ${names.workers.api}`,
    `publish ${names.workers.gateway}`,
  ]);
});

test(
  "a manual Preview web failure waits for running Worker preparation before cleanup",
  { timeout: 5000 },
  async (t) => {
    const names = previewNames("dev-web-failure");
    const workerStarted = Promise.withResolvers();
    const workerMayFinish = Promise.withResolvers();
    const webFailed = Promise.withResolvers();
    t.after(() => {
      workerStarted.resolve();
      workerMayFinish.resolve();
    });
    const operations = [];
    const update = runPreviewUpdate(
      ["--branch", "dev-web-failure", "auth", "web", "--apply"],
      {
        reportProgress: (operation) => operations.push(operation),
        makeClient: () => ({
          list: async (path) =>
            path === "/workers/workers"
              ? Object.values(names.workers).map((name) => ({ name }))
              : [
                  {
                    name: names.databases.auth,
                    uuid: "f1235678-1234-1234-1234-123456789012",
                  },
                ],
          api: async () => ({ subdomain: "account" }),
        }),
        run: async (command, args) => {
          if (command === "git") return { stdout: "dev-web-failure\n" };
          if (args.at(-1) === "typecheck") return;
          if (!args.includes("wrangler")) {
            await workerStarted.promise;
            webFailed.resolve();
            throw Object.assign(new Error("web build failed"), { code: 1 });
          }
          assert.ok(args.includes("--dry-run"));
          workerStarted.resolve(dirname(args[args.indexOf("--config") + 1]));
          await workerMayFinish.promise;
          await recordWorkerBundle(args);
        },
      },
    );
    const rejected = assert.rejects(update, /operation=build web; exit=1/);
    const directory = await workerStarted.promise;
    await webFailed.promise;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(operations, [
        "inspect resources",
        "typecheck web",
        "build web",
        "validate auth",
      ]);
      assert.ok((await stat(directory)).isDirectory());
    } finally {
      workerMayFinish.resolve();
    }
    await rejected;
    await assert.rejects(stat(directory), { code: "ENOENT" });
  },
);

test("manual update stops without writes if migrations change while preparing the API", async (t) => {
  const names = previewNames("dev-drift");
  const domainMigrations = await mkdtemp(
    join(tmpdir(), "savia-preview-input-"),
  );
  t.after(() => rm(domainMigrations, { recursive: true, force: true }));
  const migration = join(domainMigrations, "0001_fixture.sql");
  await writeFile(migration, "SELECT 1;");
  const operations = [];
  await assert.rejects(
    runPreviewUpdate(["--branch", "dev-drift", "db", "api", "--apply"], {
      domainMigrations,
      reportProgress: (operation) => operations.push(operation),
      makeClient: () => ({
        list: async (path) =>
          path === "/workers/workers"
            ? Object.values(names.workers).map((name) => ({ name }))
            : [
                {
                  name: names.databases.domain,
                  uuid: "12345678-1234-1234-1234-123456789012",
                },
              ],
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args) => {
        if (command === "git") return { stdout: "dev-drift\n" };
        if (command === "node") {
          migrationSnapshot(args, ["--check", "--allow-pending"]);
          return;
        }
        assert.equal(command, "pnpm");
        assert.ok(args.includes("--dry-run"));
        await recordWorkerBundle(args);
        await writeFile(migration, "SELECT 2;");
      },
    }),
    /Domain migrations changed while preparing the API/,
  );
  assert.deepEqual(operations, [
    "inspect resources",
    "check db",
    "validate api",
  ]);
});

test("manual Preview stops a compiled Worker that cannot start before applying changes", async () => {
  const names = previewNames("dev-invalid-worker");
  const operations = [];
  await assert.rejects(
    runPreviewUpdate(
      ["--branch", "dev-invalid-worker", "db", "api", "--apply"],
      {
        reportProgress: (operation) => operations.push(operation),
        makeClient: () => ({
          list: async (path) =>
            path === "/workers/workers"
              ? Object.values(names.workers).map((name) => ({ name }))
              : [
                  {
                    name: names.databases.domain,
                    uuid: "12345678-1234-1234-1234-123456789012",
                  },
                ],
          api: async () => ({ subdomain: "account" }),
        }),
        run: async (command, args) => {
          if (command === "git") return { stdout: "dev-invalid-worker\n" };
          if (command === "node") {
            migrationSnapshot(args, ["--check", "--allow-pending"]);
            return;
          }
          assert.equal(command, "pnpm", "must not apply database migrations");
          assert.ok(args.includes("--dry-run"), "must not publish the Worker");
          await recordWorkerBundle(
            args,
            'export const invalidExport = "not a handler";',
          );
        },
      },
    ),
    (error) => {
      assert.match(
        error.message,
        /Prepared Preview Workers failed to start locally/,
      );
      assert.match(
        error.cause?.message ?? "",
        /invalidExport.*ExportedHandler/,
      );
      return true;
    },
  );
  assert.deepEqual(operations, [
    "inspect resources",
    "check db",
    "validate api",
    "boot workers",
  ]);
});

test("an Auth-only Preview update preserves credentials and uses only the branch Auth database", async () => {
  const names = previewNames("dev-auth");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const commands = [];
  const result = await runPreviewUpdate(
    ["--branch", "dev-auth", "auth", "--apply"],
    {
      makeClient: () => ({
        list: async (path) =>
          path === "/d1/database"
            ? [{ name: names.databases.auth, uuid: databaseId }]
            : [
                names.workers.gateway,
                names.workers.api,
                names.workers.auth,
              ].map((name) => ({ name })),
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args) => {
        if (command === "git") return { stdout: "dev-auth\n" };
        assert.equal(command, "pnpm");
        const config = await recordWorkerBundle(args);
        assert.equal(config.name, names.workers.auth);
        assert.equal(config.keep_vars, true);
        assert.equal(config.vars.BETTER_AUTH_BOOTSTRAP_EMAIL, undefined);
        assert.equal(config.vars.BETTER_AUTH_BOOTSTRAP_PASSWORD, undefined);
        assert.equal(
          config.vars.BETTER_AUTH_URL,
          `https://${names.workers.gateway}.account.workers.dev`,
        );
        assert.deepEqual(config.services, [
          { binding: "SAVIA_IDENTITY", service: names.workers.api },
        ]);
        assert.deepEqual(config.d1_databases, [
          {
            binding: "AUTH_DB",
            database_name: names.databases.auth,
            database_id: databaseId,
          },
        ]);
        commands.push(args.includes("--dry-run") ? "validate" : "publish");
      },
    },
  );
  assert.deepEqual(result.targets, [
    { component: "auth", name: names.workers.auth },
  ]);
  assert.deepEqual(commands, ["validate", "publish"]);
});

test("manual Auth recovery publishes the missing bootstrap secret with the validated Worker", async (t) => {
  const names = previewNames("dev-auth-recovery");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const domainId = "22345678-1234-1234-1234-123456789012";
  const password = "synthetic-auth-recovery-pass";
  const cases = [
    { label: "restore missing credential", existingEmail: true },
    { label: "use default bootstrap email when missing" },
    {
      label: "preserve existing credential",
      existingEmail: true,
      existingPassword: true,
    },
    {
      label: "stop if a credential appears during the build",
      existingEmail: true,
      change: "build",
    },
    {
      label:
        "stop before publishing if an existing credential disappeared during the build",
      existingEmail: true,
      existingPassword: true,
      change: "build",
    },
    {
      label:
        "stop before applying D1 migrations if a credential appeared during the build",
      existingEmail: true,
      change: "build",
      includesDatabase: true,
    },
    {
      label:
        "stop before applying D1 migrations if an existing credential disappeared during the build",
      existingEmail: true,
      existingPassword: true,
      change: "build",
      includesDatabase: true,
    },
    {
      label:
        "stop before publishing if a credential appears while applying D1 migrations",
      existingEmail: true,
      includesDatabase: true,
      change: "migration",
    },
    {
      label:
        "stop before publishing if an existing credential disappears during D1 migrations",
      existingEmail: true,
      existingPassword: true,
      includesDatabase: true,
      change: "migration",
    },
    {
      label:
        "apply D1 migrations and restore Auth when the settings stay stable",
      existingEmail: true,
      includesDatabase: true,
    },
    {
      label:
        "apply D1 migrations and preserve the existing credential when settings stay stable",
      existingEmail: true,
      existingPassword: true,
      includesDatabase: true,
    },
  ];
  for (const {
    label,
    existingEmail,
    existingPassword,
    change,
    includesDatabase,
  } of cases) {
    await t.test(label, async () => {
      const publishes = [];
      const inspected = [];
      const migrations = [];
      const update = runPreviewUpdate(
        [
          "--branch",
          "dev-auth-recovery",
          "auth",
          ...(includesDatabase ? ["db"] : []),
          "--restore-auth-bootstrap",
          "--apply",
        ],
        {
          env: existingPassword
            ? {}
            : { BETTER_AUTH_BOOTSTRAP_PASSWORD: password },
          makeClient: () => ({
            list: async (path) =>
              path === "/d1/database"
                ? [
                    { name: names.databases.auth, uuid: databaseId },
                    ...(includesDatabase
                      ? [{ name: names.databases.domain, uuid: domainId }]
                      : []),
                  ]
                : [
                    names.workers.gateway,
                    names.workers.api,
                    names.workers.auth,
                  ].map((name) => ({ name })),
            api: async (path) => {
              if (path === "/workers/subdomain")
                return { subdomain: "account" };
              inspected.push(path);
              const changed =
                (change === "build" && inspected.length > 1) ||
                (change === "migration" && migrations.includes("apply"));
              const passwordPresent = changed
                ? !existingPassword
                : existingPassword;
              return {
                bindings: [
                  { name: "BETTER_AUTH_SECRET", type: "secret_text" },
                  ...(existingEmail
                    ? [
                        {
                          name: "BETTER_AUTH_BOOTSTRAP_EMAIL",
                          type: "plain_text",
                        },
                      ]
                    : []),
                  ...(passwordPresent
                    ? [
                        {
                          name: "BETTER_AUTH_BOOTSTRAP_PASSWORD",
                          type: "secret_text",
                        },
                      ]
                    : []),
                ],
              };
            },
          }),
          run: async (command, args, { env } = {}) => {
            if (command === "git") return { stdout: "dev-auth-recovery\n" };
            assert.equal(env.BETTER_AUTH_BOOTSTRAP_PASSWORD, undefined);
            if (command === "node") {
              assert.ok(includesDatabase);
              const check = args.includes("--check");
              migrationSnapshot(
                args,
                check ? ["--check", "--allow-pending"] : [],
              );
              assert.equal(env.CLOUDFLARE_DATABASE_ID, domainId);
              migrations.push(check ? "check" : "apply");
              return;
            }
            assert.equal(command, "pnpm");
            assert.ok(args.includes("deploy"));
            const config = await recordWorkerBundle(args);
            assert.equal(config.vars.BETTER_AUTH_BOOTSTRAP_PASSWORD, undefined);
            assert.equal(
              config.vars.BETTER_AUTH_BOOTSTRAP_EMAIL,
              existingEmail ? undefined : "savia.admin@example.test",
            );
            assert.equal(config.keep_vars, true);
            const secretFlag = args.indexOf("--secrets-file");
            if (args.includes("--dry-run")) {
              assert.equal(secretFlag, -1);
              return;
            }
            const secretFile = secretFlag < 0 ? null : args[secretFlag + 1];
            publishes.push(secretFile);
            if (existingPassword) assert.equal(secretFile, null);
            else {
              assert.equal((await stat(secretFile)).mode & 0o777, 0o600);
              assert.deepEqual(JSON.parse(await readFile(secretFile, "utf8")), {
                BETTER_AUTH_BOOTSTRAP_PASSWORD: password,
              });
            }
          },
        },
      );
      if (change) {
        await assert.rejects(
          update,
          /bootstrap bindings changed during the update/,
        );
        assert.deepEqual(publishes, []);
      } else {
        const result = await update;
        assert.equal(
          result.authBootstrap,
          existingPassword ? "preserved" : "restored",
        );
        assert.equal(publishes.length, 1);
      }
      assert.deepEqual(
        migrations,
        includesDatabase
          ? change === "build"
            ? ["check"]
            : ["check", "apply"]
          : [],
      );
      assert.equal(
        inspected.length,
        includesDatabase && change !== "build" ? 3 : 2,
      );
      assert.ok(
        inspected.every(
          (path) => path === `/workers/scripts/${names.workers.auth}/settings`,
        ),
      );
      if (publishes[0])
        await assert.rejects(stat(publishes[0]), { code: "ENOENT" });
    });
  }
});

test("manual Preview reports the failing stage without printing raw command output", async () => {
  const names = previewNames("dev-failure");
  const progress = [];
  const secret = "test-only-secret-token";
  await assert.rejects(
    runPreviewUpdate(["--branch", "dev-failure", "db", "api", "--apply"], {
      env: { CLOUDFLARE_API_TOKEN: secret },
      reportProgress: (operation) => progress.push(operation),
      makeClient: () => ({
        list: async (path) =>
          path === "/workers/workers"
            ? Object.values(names.workers).map((name) => ({ name }))
            : [
                {
                  name: names.databases.domain,
                  uuid: "12345678-1234-1234-1234-123456789012",
                },
              ],
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args) => {
        if (command === "git") return { stdout: "dev-failure\n" };
        if (command === "node") {
          if (args.includes("--check")) {
            migrationSnapshot(args, ["--check", "--allow-pending"]);
            return;
          }
          const error = Object.assign(new Error("node exited with code 1"), {
            stderr: `D1 query failed (403): ${secret}`,
            code: 1,
          });
          throw error;
        }
        assert.ok(
          args.includes("--dry-run"),
          "publishing must stop once migration fails",
        );
        await recordWorkerBundle(args);
      },
    }),
    (error) => {
      assert.match(
        error.message,
        /diagnostic=PERMISSION_DENIED; remediation=CHECK_ACCESS; operation=migrate db; exit=1/,
      );
      assert.ok(!error.message.includes(secret));
      return true;
    },
  );
  assert.deepEqual(progress, [
    "inspect resources",
    "check db",
    "validate api",
    "boot workers",
    "migrate db",
  ]);
});

test("a partial grouped update reports completed components and can retry the remaining ones", async () => {
  const branch = "dev-partial";
  const names = previewNames(branch);
  const published = [];
  let databaseApplied = false;
  let requestUnavailable = true;
  const options = {
    makeClient: () => ({
      list: async (path) =>
        path === "/workers/workers"
          ? Object.values(names.workers).map((name) => ({ name }))
          : [
              {
                name: names.databases.domain,
                uuid: "12345678-1234-1234-1234-123456789012",
              },
              {
                name: names.databases.auth,
                uuid: "f1235678-1234-1234-1234-123456789012",
              },
            ],
      api: async () => ({ subdomain: "account" }),
    }),
    run: async (command, args) => {
      if (command === "git") return { stdout: `${branch}\n` };
      if (command === "node") {
        if (args.includes("--allow-pending")) {
          migrationSnapshot(args, ["--check", "--allow-pending"]);
          return;
        }
        if (args.includes("--check")) {
          migrationSnapshot(args, ["--check"]);
          assert.ok(databaseApplied);
          return;
        }
        migrationSnapshot(args);
        assert.equal(databaseApplied, false);
        databaseApplied = true;
        return;
      }
      if (!args.includes("wrangler")) return;
      const config = await recordWorkerBundle(args);
      if (args.includes("--dry-run")) return;
      if (config.name === names.workers.request && requestUnavailable) {
        throw Object.assign(new Error("wrangler exited with code 1"), {
          code: 1,
          stderr: "HTTP 403 test-only-private-detail",
        });
      }
      published.push(config.name);
    },
  };
  await assert.rejects(
    runPreviewUpdate(
      ["--branch", branch, "db", "auth", "request", "api", "web", "--apply"],
      options,
    ),
    (error) => {
      assert.match(error.message, /Completed Preview updates: db, auth\./);
      assert.match(
        error.message,
        /diagnostic=PERMISSION_DENIED; remediation=CHECK_ACCESS; operation=publish request; exit=1/,
      );
      assert.doesNotMatch(error.message, /test-only-private-detail/);
      return true;
    },
  );
  assert.deepEqual(published, [names.workers.auth]);
  assert.ok(databaseApplied);

  requestUnavailable = false;
  const result = await runPreviewUpdate(
    ["--branch", branch, "request", "api", "web", "--apply"],
    options,
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(published, [
    names.workers.auth,
    names.workers.request,
    names.workers.api,
    names.workers.gateway,
  ]);
});

test("a database-only Preview update needs no Workers access", async () => {
  const names = previewNames("dev-db");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const result = await runPreviewUpdate(
    ["--branch", "dev-db", "db", "--apply"],
    {
      makeClient: () => ({
        list: async (path) => {
          assert.equal(path, "/d1/database");
          return [{ name: names.databases.domain, uuid: databaseId }];
        },
        api: async () => assert.fail("Workers access is not needed"),
      }),
      run: async (command, args, { env } = {}) => {
        if (command === "git") return { stdout: "dev-db\n" };
        assert.equal(command, "node");
        migrationSnapshot(args);
        assert.equal(env.CLOUDFLARE_DATABASE_ID, databaseId);
      },
    },
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(result.targets, [
    { component: "db", name: names.databases.domain },
  ]);
});

test("a web-only Preview update only needs the gateway and API Workers", async () => {
  const names = previewNames("dev-web");
  const commands = [];
  let publicDirectory;
  const result = await runPreviewUpdate(
    ["--branch", "dev-web", "web", "--apply"],
    {
      makeClient: () => ({
        list: async (path) => {
          assert.equal(path, "/workers/workers");
          return [names.workers.gateway, names.workers.api].map((name) => ({
            name,
          }));
        },
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args, { env } = {}) => {
        if (command === "git") return { stdout: "dev-web\n" };
        if (args.includes("wrangler")) {
          await recordWorkerBundle(args);
        } else {
          publicDirectory = env.SAVIA_ADMIN_PUBLIC_DIR;
          assert.equal(
            dirname(publicDirectory),
            dirname(env.SAVIA_ADMIN_OUT_DIR),
          );
          assert.ok((await stat(join(publicDirectory, "login"))).isDirectory());
          const downloads = await readdir(
            join(publicDirectory, "downloads"),
          ).catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return [];
          });
          assert.ok(!downloads.some((file) => file.endsWith(".vsix")));
        }
        commands.push([command, args[1], args.includes("--dry-run")]);
      },
    },
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(commands, [
    ["pnpm", "@savia/admin", false],
    ["pnpm", "@savia/api", true],
    ["pnpm", "@savia/api", false],
  ]);
  await assert.rejects(stat(publicDirectory), { code: "ENOENT" });
});

test("a web-only Preview update reports its missing API binding before building", async () => {
  const names = previewNames("dev-web");
  await assert.rejects(
    runPreviewUpdate(["--branch", "dev-web", "web", "--apply"], {
      makeClient: () => ({
        list: async () => [{ name: names.workers.gateway }],
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command) => {
        assert.equal(command, "git", "missing bindings must stop the build");
        return { stdout: "dev-web\n" };
      },
    }),
    new RegExp(`Missing Preview Workers.*${names.workers.api}`),
  );
});

test("an API-only Preview update can run without the Hook Executor Worker", async () => {
  const names = previewNames("dev-api");
  const ids = { domain: "12345678-1234-1234-1234-123456789012" };
  const commands = [];
  const result = await runPreviewUpdate(
    ["--branch", "dev-api", "api", "--apply"],
    {
      makeClient: () => ({
        list: async (path) =>
          path === "/d1/database"
            ? [{ name: names.databases.domain, uuid: ids.domain }]
            : Object.entries(names.workers)
                .filter(([role]) => role !== "hookExecutor")
                .map(([, name]) => ({ name })),
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args, { env } = {}) => {
        if (command === "git") return { stdout: "dev-api\n" };
        if (command === "node") {
          migrationSnapshot(args, ["--check"]);
          assert.equal(env.CLOUDFLARE_DATABASE_ID, ids.domain);
          commands.push("check");
          return;
        }
        const config = await recordWorkerBundle(args);
        assert.equal(config.name, names.workers.api);
        assert.equal(config.d1_databases[0].database_id, ids.domain);
        commands.push(args.includes("--dry-run") ? "validate" : "publish");
      },
    },
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(commands, ["check", "validate", "check", "publish"]);
});

test("a Request-only Preview update checks the shared database and deploys only its private Worker", async () => {
  const names = previewNames("dev-request");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const operations = [];
  const result = await runPreviewUpdate(
    ["--branch", "dev-request", "request", "--apply"],
    {
      reportProgress: (operation) => operations.push(operation),
      makeClient: () => ({
        list: async (path) =>
          path === "/d1/database"
            ? [{ name: names.databases.domain, uuid: databaseId }]
            : [
                names.workers.gateway,
                names.workers.request,
                names.workers.hookExecutor,
              ].map((name) => ({ name })),
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command, args, { env } = {}) => {
        if (command === "git") return { stdout: "dev-request\n" };
        if (command === "node") {
          migrationSnapshot(args, ["--check"]);
          assert.equal(env.CLOUDFLARE_DATABASE_ID, databaseId);
          return;
        }
        const config = await recordWorkerBundle(args);
        assert.equal(config.name, names.workers.request);
        assert.equal(config.keep_vars, true);
        assert.equal(config.workers_dev, false);
        assert.equal(config.preview_urls, false);
        assert.equal(config.ai, undefined);
        assert.deepEqual(config.services, [
          { binding: "HOOK_SERVICE", service: names.workers.hookExecutor },
        ]);
        assert.deepEqual(config.d1_databases, [
          {
            binding: "DB",
            database_name: names.databases.domain,
            database_id: databaseId,
          },
        ]);
      },
    },
  );
  assert.deepEqual(result.targets, [
    { component: "request", name: names.workers.request },
  ]);
  assert.deepEqual(operations, [
    "inspect resources",
    "check db",
    "validate request",
    "boot workers",
    "recheck db",
    "publish request",
  ]);
});

test("a Request-only Preview update stops before building without its Hook Executor", async () => {
  const names = previewNames("dev-request");
  await assert.rejects(
    runPreviewUpdate(["--branch", "dev-request", "request", "--apply"], {
      makeClient: () => ({
        list: async (path) =>
          path === "/d1/database"
            ? [
                {
                  name: names.databases.domain,
                  uuid: "12345678-1234-1234-1234-123456789012",
                },
              ]
            : [names.workers.gateway, names.workers.request].map((name) => ({
                name,
              })),
        api: async () => ({ subdomain: "account" }),
      }),
      run: async (command) => {
        assert.equal(
          command,
          "git",
          "must stop before checking or building the Worker",
        );
        return { stdout: "dev-request\n" };
      },
    }),
    new RegExp(`Missing Preview Workers.*${names.workers.hookExecutor}`),
  );
});

test("an API update stops before building Workers if the domain history does not match", async (t) => {
  const names = previewNames("dev-pending");
  const cases = [
    {
      name: "pending migrations",
      stderr: "D1 schema has pending Savia migrations (1).",
      diagnostic:
        /diagnostic=D1_MIGRATIONS_PENDING; remediation=INCLUDE_DB_IN_PREVIEW_UPDATE; operation=check db; exit=1/,
    },
    {
      name: "database ahead of the checkout",
      stderr:
        "D1 migration history contains migrations missing from this checkout.",
      diagnostic:
        /diagnostic=D1_MIGRATION_HISTORY_MISMATCH; remediation=USE_MATCHING_CHECKOUT; operation=check db; exit=1/,
    },
    {
      name: "database ahead of the checkout in a grouped update",
      includeDatabase: true,
      stderr:
        "D1 migration history contains migrations missing from this checkout.",
      diagnostic:
        /diagnostic=D1_MIGRATION_HISTORY_MISMATCH; remediation=USE_MATCHING_CHECKOUT; operation=check db; exit=1/,
    },
  ];
  for (const { name, includeDatabase, stderr, diagnostic } of cases) {
    await t.test(name, async () => {
      const operations = [];
      await assert.rejects(
        runPreviewUpdate(
          [
            "--branch",
            "dev-pending",
            ...(includeDatabase ? ["db"] : []),
            "auth",
            "api",
            "web",
            "--apply",
          ],
          {
            makeClient: () => ({
              list: async (path) =>
                path === "/d1/database"
                  ? Object.entries(names.databases).map(([kind, name]) => ({
                      name,
                      uuid:
                        kind === "auth"
                          ? "f1235678-1234-1234-1234-123456789012"
                          : "12345678-1234-1234-1234-123456789012",
                    }))
                  : Object.values(names.workers).map((name) => ({ name })),
              api: async () => ({ subdomain: "account" }),
            }),
            reportProgress: (operation) => operations.push(operation),
            run: async (command, args) => {
              if (command === "git") return { stdout: "dev-pending\n" };
              assert.equal(command, "node");
              migrationSnapshot(args, [
                "--check",
                ...(includeDatabase ? ["--allow-pending"] : []),
              ]);
              throw Object.assign(new Error("node exited with code 1"), {
                stderr,
                code: 1,
              });
            },
          },
        ),
        diagnostic,
      );
      assert.deepEqual(operations, ["inspect resources", "check db"]);
    });
  }
});

test("manual Preview stops before publishing any Worker if D1 changes during preparation", async () => {
  const names = previewNames("dev-late-history");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const operations = [];
  let snapshot;
  let historyAdvanced = false;
  await assert.rejects(
    runPreviewUpdate(
      ["--branch", "dev-late-history", "auth", "request", "api", "--apply"],
      {
        makeClient: () => ({
          list: async (path) =>
            path === "/d1/database"
              ? [
                  { name: names.databases.domain, uuid: databaseId },
                  {
                    name: names.databases.auth,
                    uuid: "f1235678-1234-1234-1234-123456789012",
                  },
                ]
              : Object.values(names.workers).map((name) => ({ name })),
          api: async () => ({ subdomain: "account" }),
        }),
        reportProgress: (operation) => operations.push(operation),
        run: async (command, args, { env } = {}) => {
          if (command === "git") return { stdout: "dev-late-history\n" };
          if (command === "node") {
            assert.equal(env.CLOUDFLARE_DATABASE_ID, databaseId);
            const directory = migrationSnapshot(args, ["--check"]);
            if (!historyAdvanced) {
              snapshot = directory;
              return;
            }
            assert.equal(directory, snapshot);
            throw Object.assign(new Error("D1 check failed"), {
              code: 1,
              stderr:
                "D1 migration history contains migrations missing from this checkout.",
            });
          }
          assert.ok(args.includes("--dry-run"), "must not publish a Worker");
          const config = await recordWorkerBundle(args);
          if (config.name === names.workers.api) historyAdvanced = true;
        },
      },
    ),
    /diagnostic=D1_MIGRATION_HISTORY_MISMATCH; remediation=USE_MATCHING_CHECKOUT; operation=recheck db; exit=1/,
  );
  assert.deepEqual(operations, [
    "inspect resources",
    "check db",
    "validate auth",
    "validate request",
    "validate api",
    "boot workers",
    "recheck db",
  ]);
  await assert.rejects(stat(snapshot), { code: "ENOENT" });
});

test("branch preview schedules are opt-in", () => {
  const names = previewNames("schedule-opt-in");
  const ids = { auth: "auth-id", domain: "domain-id" };
  const origin = "https://preview.example.test";

  const defaultConfig = workerConfig("api", names, ids, origin);
  const scheduledConfig = workerConfig("api", names, ids, origin, {
    enableSchedules: true,
  });

  assert.equal(defaultConfig.triggers, undefined);
  assert.deepEqual(scheduledConfig.triggers, { crons: ["* * * * *"] });
});

test("deploys the isolated connector gateway before the API service binding", () => {
  assert.deepEqual(
    workerDeploymentOrder([
      "auth",
      "hookExecutor",
      "request",
      "mcp",
      "api",
      "connectorGateway",
      "gateway",
    ]),
    [
      "auth",
      "hookExecutor",
      "request",
      "connectorGateway",
      "mcp",
      "api",
      "gateway",
    ],
  );
});

test("routes public quote reports through the preview gateway", () => {
  const config = workerConfig(
    "gateway",
    { workers: { gateway: "savia-preview-test" } },
    {},
    "https://savia-preview-test.workers.dev",
    { assetsDir: "/tmp/savia-admin-assets" },
  );

  assert.ok(config.assets.run_worker_first.includes("/public/quotes"));
  assert.ok(config.assets.run_worker_first.includes("/public/quotes/*"));
});

test("parses Cloudflare account-subdomain worker URLs", () => {
  assert.equal(
    parseWorkersDevUrl(
      "Uploaded https://savia-preview-test.account-123.workers.dev",
    ),
    "https://savia-preview-test.account-123.workers.dev",
  );
  assert.equal(
    parseWorkersDevUrl("Uploaded https://savia-preview-test.workers.dev"),
    "https://savia-preview-test.workers.dev",
  );
  assert.equal(parseWorkersDevUrl("Upload complete"), null);
});

test("requires a discovered origin after a real preview gateway deployment", () => {
  assert.equal(
    requireGatewayOrigin({ url: "https://preview.account.workers.dev" }, false),
    "https://preview.account.workers.dev",
  );
  assert.equal(requireGatewayOrigin({ url: null }, true), null);
  assert.throws(
    () => requireGatewayOrigin({ url: null }, false),
    /Could not determine preview origin/,
  );
});

test("writes provided stdin to the spawned command and closes it", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  let stdinText = "";
  let stdinEnded = false;
  child.stdin = {
    on() {},
    write(chunk) {
      stdinText += chunk;
    },
    end(chunk) {
      if (chunk !== undefined) stdinText += chunk;
      stdinEnded = true;
    },
  };
  const calls = [];
  const spawnImpl = (...args) => {
    calls.push(args);
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from("wrangler ok"));
      child.emit("close", 0, null);
    });
    return child;
  };

  const result = await execFileWithInput(
    "pnpm",
    ["secret", "put", "ENCRYPTION_KEY"],
    { input: "secret-value", cwd: "/workspace/savia" },
    spawnImpl,
  );

  assert.equal(stdinText, "secret-value");
  assert.equal(stdinEnded, true);
  assert.equal(result.stdout, "wrangler ok");
  assert.equal(result.stderr, "");
  assert.equal(calls[0][0], "pnpm");
  assert.deepEqual(calls[0][1], ["secret", "put", "ENCRYPTION_KEY"]);
  assert.equal(calls[0][2].cwd, "/workspace/savia");
});

test("does not leave child stdin errors unhandled", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr.setEncoding = () => {};
  child.stdin = new EventEmitter();
  child.stdin.end = () => {
    child.stdin.emit(
      "error",
      Object.assign(new Error("closed"), { code: "EPIPE" }),
    );
    queueMicrotask(() => child.emit("close", 1, null));
  };
  await assert.rejects(
    execFileWithInput(
      "pnpm",
      ["secret", "put"],
      { input: "secret" },
      () => child,
    ),
    /closed/,
  );
});

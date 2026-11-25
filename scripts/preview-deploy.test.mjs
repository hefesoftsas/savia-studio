import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
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

test("manual update plans only the requested isolated Preview components in order", async () => {
  const result = await runPreviewUpdate([
    "--branch",
    "dev/manual",
    "web",
    "api",
    "db",
  ]);
  assert.deepEqual(result, {
    status: "planned",
    environment: "branch-dev-manual",
    targets: [
      { component: "db", name: "savia-agencies-preview-dev-manual" },
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

test("manual update prepares Workers before migration and publishes only selected targets", async () => {
  const names = previewNames("dev-manual");
  const databaseId = "12345678-1234-1234-1234-123456789012";
  const calls = [];
  let webOutput;
  await runPreviewUpdate(
    ["--branch", "dev-manual", "web", "api", "db", "--apply"],
    {
      env: { CLOUDFLARE_API_TOKEN: "test-only" },
      makeClient: () => ({
        list: async (path) =>
          path === "/workers/workers"
            ? Object.values(names.workers).map((name) => ({ name }))
            : [
                { name: "savia-agencies", uuid: "production-id" },
                { name: names.databases.domain, uuid: databaseId },
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
          calls.push("db");
        } else if (args.includes("wrangler")) {
          const config = JSON.parse(
            await readFile(args[args.indexOf("--config") + 1], "utf8"),
          );
          assert.equal(config.keep_vars, true);
          assert.equal(config.ai, undefined);
          assert.ok(
            (config.services ?? []).every(({ service }) =>
              Object.values(names.workers).includes(service),
            ),
          );
          if (config.name === names.workers.gateway)
            assert.equal(config.assets.directory, webOutput);
          calls.push(
            `${args.includes("--dry-run") ? "prepare" : "publish"} ${config.name}`,
          );
        } else {
          assert.equal(env.CLOUDFLARE_API_TOKEN, undefined);
          assert.equal(env.SAVIA_CI_FLOWS_ENABLED, "false");
          assert.equal(env.SAVIA_ADMIN_IGNORE_ENV_FILES, "true");
          webOutput = env.SAVIA_ADMIN_OUT_DIR;
          assert.match(webOutput, /savia-preview-update-.*[/\\]web-assets$/);
          calls.push("build web");
        }
      },
    },
  );
  assert.deepEqual(calls, [
    "build web",
    `prepare ${names.workers.api}`,
    `prepare ${names.workers.gateway}`,
    "db",
    `publish ${names.workers.api}`,
    `publish ${names.workers.gateway}`,
  ]);
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
    "validate api",
    "migrate db",
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
        assert.deepEqual(args, ["scripts/apply-d1-migrations.mjs"]);
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
      run: async (command, args) => {
        if (command === "git") return { stdout: "dev-web\n" };
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
      run: async (command, args) => {
        if (command === "git") return { stdout: "dev-api\n" };
        const config = JSON.parse(
          await readFile(args[args.indexOf("--config") + 1], "utf8"),
        );
        assert.equal(config.name, names.workers.api);
        assert.equal(config.d1_databases[0].database_id, ids.domain);
        commands.push(args.includes("--dry-run") ? "validate" : "publish");
      },
    },
  );
  assert.equal(result.status, "updated");
  assert.deepEqual(commands, ["validate", "publish"]);
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

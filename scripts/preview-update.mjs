import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runWithCommandDiagnostics } from "../infra/pulumi/command-diagnostics.mjs";
import {
  bootPreviewWorkers,
  bundleRuntimeWorker,
  previewWorkerStartupOptions,
} from "../infra/pulumi/runtime-artifact.mjs";
import { createRuntimeCloudClient } from "../infra/pulumi/runtime-cloud.mjs";
import {
  execFileWithInput,
  requireBranchBootstrapPassword,
  workerConfig,
} from "../infra/pulumi/runtime-publisher-branch.mjs";
import { isVersionedVscodeDownload } from "./lib/prepare-vscode-download.mjs";
import { previewNames, slugifyBranch } from "./preview-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const roles = { auth: "auth", request: "request", api: "api", web: "gateway" };
const order = ["db", ...Object.keys(roles)];
const authBootstrapEmail = "BETTER_AUTH_BOOTSTRAP_EMAIL";
const authBootstrapPassword = "BETTER_AUTH_BOOTSTRAP_PASSWORD";
const usage =
  "Usage: pnpm deploy:preview --branch <branch> <db|auth|request|api|web> [...] [--restore-auth-bootstrap] [--apply]";

async function readMigrations(directory) {
  const filenames = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(
    filenames.map(async (name) => ({
      name,
      sql: await readFile(join(directory, name)),
    })),
  );
}

export async function runPreviewUpdate(
  argv,
  {
    env = process.env,
    makeClient = createRuntimeCloudClient,
    run = execFileWithInput,
    reportProgress = () => {},
    domainMigrations = join(root, "packages/db/migrations"),
  } = {},
) {
  const { values, positionals } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    allowPositionals: true,
    options: {
      branch: { type: "string" },
      apply: { type: "boolean" },
      "restore-auth-bootstrap": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) return usage;
  if (!values.branch || !positionals.length) throw new Error(usage);
  const branchCheck = await run(
    "git",
    ["check-ref-format", "--branch", values.branch],
    { cwd: root },
  );
  if (branchCheck.stdout.trim() !== values.branch)
    throw new Error("Use an explicit branch name");
  const slug = slugifyBranch(values.branch);
  const names = previewNames(slug);
  const components = new Set(positionals);
  if (positionals.some((component) => !order.includes(component)))
    throw new Error(`Unknown Preview component. ${usage}`);
  const restoreAuthBootstrap = values["restore-auth-bootstrap"];
  if (restoreAuthBootstrap && !components.has("auth"))
    throw new Error("Use --restore-auth-bootstrap with the auth component");
  const selected = order.filter((component) => components.has(component));
  const targets = selected.map((component) => ({
    component,
    name:
      component === "db"
        ? names.databases.domain
        : names.workers[roles[component]],
  }));
  const environment = `branch-${slug}`;
  if (!values.apply)
    return {
      status: "planned",
      environment,
      targets,
      ...(restoreAuthBootstrap ? { authBootstrap: "restore-if-missing" } : {}),
    };

  const { stdout: refs } = await run(
    "git",
    [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
      "refs/remotes/origin",
    ],
    { cwd: root },
  );
  const matchingBranches = new Set(
    values.branch === slug ? [] : [values.branch],
  );
  for (const ref of refs.trim().split("\n")) {
    const branch = /^refs\/(?:heads|remotes\/origin)\/(.+)$/.exec(ref)?.[1];
    if (!branch) continue;
    try {
      if (slugifyBranch(branch) === slug) matchingBranches.add(branch);
    } catch {
      // Unrelated protected or invalid branch names cannot own this Preview.
    }
  }
  if (matchingBranches.size > 1)
    throw new Error(
      `Preview ${environment} has an ambiguous branch name: ${[...matchingBranches].join(", ")}`,
    );

  reportProgress("inspect resources");
  const client = makeClient(
    { accountId: env.CLOUDFLARE_ACCOUNT_ID, workers: [] },
    { env },
  );
  const updatesWorkers = selected.some((component) => component !== "db");
  const updatesDomainWorker =
    components.has("api") || components.has("request");
  const databaseKinds = [];
  if (updatesDomainWorker || components.has("db")) databaseKinds.push("domain");
  if (components.has("auth")) databaseKinds.push("auth");
  const [workers, databases, workersDomain] = await Promise.all([
    updatesWorkers ? client.list("/workers/workers") : [],
    databaseKinds.length ? client.list("/d1/database") : [],
    updatesWorkers ? client.api("/workers/subdomain") : undefined,
  ]);
  const databaseIds = {};
  for (const kind of databaseKinds) {
    const name = names.databases[kind];
    const id = databases.find((database) => database.name === name)?.uuid;
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id ?? ""))
      throw new Error(`Missing Preview database ${name} in ${environment}`);
    databaseIds[kind] = id;
  }
  const subdomain = workersDomain?.subdomain;
  if (
    updatesWorkers &&
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain ?? "")
  )
    throw new Error("Existing account Workers subdomain is required");

  const suffix = updatesWorkers ? `${subdomain}.workers.dev` : undefined;
  const origin = suffix
    ? `https://${names.workers.gateway}.${suffix}`
    : undefined;
  const workerUpdates = selected
    .filter((component) => component !== "db")
    .map((component) => {
      const config = workerConfig(roles[component], names, databaseIds, origin);
      config.keep_vars = true;
      if (component === "api")
        config.vars.SAVIA_MCP_URL = `https://${names.workers.mcp}.${suffix}/mcp`;
      return { component, config };
    });
  if (updatesWorkers) {
    // The gateway serves the public origin used by the frontend and API settings.
    const required = new Set([names.workers.gateway]);
    for (const { config } of workerUpdates) {
      required.add(config.name);
      for (const { service } of config.services ?? []) required.add(service);
    }
    const available = new Set(workers.map(({ name }) => name));
    const missing = [...required].filter((name) => !available.has(name));
    if (missing.length)
      throw new Error(
        `Missing Preview Workers in ${environment}: ${missing.join(", ")}`,
      );
  }

  const readAuthBindings = async () => {
    const settings = await client.api(
      `/workers/scripts/${names.workers.auth}/settings`,
    );
    if (!Array.isArray(settings?.bindings))
      throw new Error("Cloudflare did not return the branch Auth bindings");
    return new Set(settings.bindings.map(({ name }) => name));
  };
  const authBindings = restoreAuthBootstrap
    ? await readAuthBindings()
    : undefined;
  const bootstrapPassword =
    authBindings && !authBindings.has(authBootstrapPassword)
      ? requireBranchBootstrapPassword(env)
      : undefined;
  const seedBootstrapEmail =
    bootstrapPassword && !authBindings.has(authBootstrapEmail);
  const auth = workerUpdates.find(({ component }) => component === "auth");
  if (auth && !seedBootstrapEmail) delete auth.config.vars[authBootstrapEmail];
  const checkAuthBootstrap = async () => {
    if (!authBindings) return;
    const current = await readAuthBindings();
    const passwordChanged =
      current.has(authBootstrapPassword) !==
      authBindings.has(authBootstrapPassword);
    const emailChanged =
      bootstrapPassword &&
      current.has(authBootstrapEmail) !== authBindings.has(authBootstrapEmail);
    if (passwordChanged || emailChanged)
      throw new Error(
        "Branch Auth bootstrap bindings changed during the update. Run the update again with the current settings.",
      );
  };

  const directory = await mkdtemp(join(tmpdir(), "savia-preview-update-"));
  const runtimeEnv = { ...env };
  delete runtimeEnv[authBootstrapPassword];
  const execute = (operation, executable, args, commandEnv = runtimeEnv) => {
    reportProgress(operation);
    return runWithCommandDiagnostics({
      execute: run,
      executable,
      args,
      options: { cwd: root, env: commandEnv },
      directory: env.SAVIA_RUNTIME_OPERATION_DIRECTORY,
      operation,
    });
  };
  const wrangler = (operation, args, commandEnv = runtimeEnv) =>
    execute(
      operation,
      "pnpm",
      ["--filter", "@savia/api", "exec", "wrangler", ...args],
      commandEnv,
    );
  const migrationsDirectory = join(directory, "migrations");
  const domainMigration = (operation, ...args) =>
    execute(
      operation,
      "node",
      [
        "scripts/apply-d1-migrations.mjs",
        "--migrations-dir",
        migrationsDirectory,
        ...args,
      ],
      { ...runtimeEnv, CLOUDFLARE_DATABASE_ID: databaseIds.domain },
    );
  const completed = [];
  try {
    const migrations = databaseIds.domain
      ? await readMigrations(domainMigrations)
      : [];
    if (databaseIds.domain) {
      await mkdir(migrationsDirectory);
      await Promise.all(
        migrations.map(({ name, sql }) =>
          writeFile(join(migrationsDirectory, name), sql, { mode: 0o600 }),
        ),
      );
    }
    if (updatesWorkers && databaseIds.domain)
      await domainMigration(
        "check db",
        "--check",
        ...(components.has("db") ? ["--allow-pending"] : []),
      );

    const webAssetsDirectory = join(directory, "web-assets");
    const web = workerUpdates.find(({ component }) => component === "web");
    const parallelBuild = Boolean(web && workerUpdates.length > 1);
    const buildEnv = Object.fromEntries(
      Object.entries(env).filter(([key]) =>
        ["PATH", "HOME", "TMPDIR", "TEMP", "PNPM_HOME", "CI"].includes(key),
      ),
    );
    buildEnv.SAVIA_ADMIN_IGNORE_ENV_FILES = "true";
    buildEnv.SAVIA_CI_FLOWS_ENABLED = "false";
    buildEnv.SAVIA_ADMIN_OUT_DIR = webAssetsDirectory;
    if (web) {
      const source = join(root, "apps/admin/public");
      const downloads = join(source, "downloads");
      buildEnv.SAVIA_ADMIN_PUBLIC_DIR = join(directory, "web-public");
      await cp(source, buildEnv.SAVIA_ADMIN_PUBLIC_DIR, {
        recursive: true,
        filter: (path) => {
          const entry = basename(path);
          return (
            dirname(path) !== downloads ||
            (!isVersionedVscodeDownload(entry) &&
              !entry.startsWith(".savia-vsix-"))
          );
        },
      });
    }
    if (parallelBuild) {
      await execute(
        "typecheck web",
        "pnpm",
        ["--filter", "@savia/admin", "run", "typecheck"],
        buildEnv,
      );
      // Let the initial pnpm command prepare the shared dependencies.
      // Concurrent commands must fail on drift instead of reinstalling them.
      buildEnv.pnpm_config_verify_deps_before_run = "error";
    }

    const buildWebAssets = async () => {
      if (!web) return;
      await execute(
        "build web",
        "pnpm",
        [
          "--filter",
          "@savia/admin",
          "run",
          parallelBuild ? "build:assets" : "build",
        ],
        buildEnv,
      );
    };

    const prepareWorker = async ({ component, config }) => {
      if (component === "web") config.assets.directory = webAssetsDirectory;
      const source = join(directory, `${component}.json`);
      const bundleDirectory = join(directory, component);
      await writeFile(source, JSON.stringify(config), { mode: 0o600 });
      const bundle = await bundleRuntimeWorker(
        {
          path: source,
          config,
          directory: bundleDirectory,
          metafile: join(directory, `${component}.build-meta.json`),
        },
        (args) =>
          wrangler(
            `validate ${component}`,
            args,
            parallelBuild ? buildEnv : runtimeEnv,
          ),
      );
      if (component === "api" || component === "request") {
        const current = await readMigrations(domainMigrations);
        if (
          current.length !== migrations.length ||
          migrations.some(
            ({ name, sql }, index) =>
              name !== current[index].name || !sql.equals(current[index].sql),
          )
        )
          throw new Error(
            `Domain migrations changed while preparing the ${component === "api" ? "API" : "Request Worker"}. Run the Preview update again with the current files.`,
          );
      }
      const path = join(bundleDirectory, "wrangler.json");
      const prepared = { ...config, ...bundle };
      const startup = await previewWorkerStartupOptions(
        bundleDirectory,
        prepared,
      );
      await writeFile(path, JSON.stringify(prepared), {
        mode: 0o600,
      });
      return { component, path, startup };
    };
    const prepareServiceWorkers = async () => {
      const prepared = [];
      for (const worker of workerUpdates)
        if (worker.component !== "web")
          prepared.push(await prepareWorker(worker));
      return prepared;
    };

    // The gateway needs the built assets. The other Workers can prepare
    // while the web build runs. Keep the staging files until both tasks settle.
    const [assets, services] = await Promise.allSettled([
      buildWebAssets(),
      prepareServiceWorkers(),
    ]);
    if (assets.status === "rejected") throw assets.reason;
    if (services.status === "rejected") throw services.reason;
    const configs = services.value;
    if (web) configs.push(await prepareWorker(web));
    if (configs.length) {
      reportProgress("boot workers");
      await bootPreviewWorkers(configs.map(({ startup }) => startup));
    }
    if (components.has("db")) {
      await checkAuthBootstrap();
      await domainMigration("migrate db");
      completed.push("db");
    } else if (updatesDomainWorker)
      await domainMigration("recheck db", "--check");
    for (const { component, path } of configs) {
      const args = ["deploy", "--config", path];
      if (component === "auth") await checkAuthBootstrap();
      if (component === "auth" && bootstrapPassword) {
        const secrets = join(directory, "auth-bootstrap.json");
        await writeFile(
          secrets,
          JSON.stringify({ [authBootstrapPassword]: bootstrapPassword }),
          { mode: 0o600 },
        );
        args.push("--secrets-file", secrets);
      }
      await wrangler(`publish ${component}`, args);
      completed.push(component);
    }
    return {
      status: "updated",
      environment,
      origin,
      targets,
      ...(restoreAuthBootstrap
        ? { authBootstrap: bootstrapPassword ? "restored" : "preserved" }
        : {}),
    };
  } catch (error) {
    if (!completed.length) throw error;
    throw new Error(
      `${error.message}\nCompleted Preview updates: ${completed.join(", ")}.`,
      { cause: error },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = await runPreviewUpdate(process.argv.slice(2), {
      reportProgress: (operation) => console.error(`Preview: ${operation}`),
    });
    console.log(
      typeof result === "string" ? result : JSON.stringify(result, null, 2),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

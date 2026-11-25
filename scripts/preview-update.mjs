import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { runWithCommandDiagnostics } from "../infra/pulumi/command-diagnostics.mjs";
import { createRuntimeCloudClient } from "../infra/pulumi/runtime-cloud.mjs";
import {
  execFileWithInput,
  workerConfig,
} from "../infra/pulumi/runtime-publisher-branch.mjs";
import { previewNames, slugifyBranch } from "./preview-environment.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const roles = { api: "api", web: "gateway" };
const order = ["db", "api", "web"];
const usage =
  "Usage: pnpm deploy:preview --branch <branch> <db|api|web> [...] [--apply]";

export async function runPreviewUpdate(
  argv,
  {
    env = process.env,
    makeClient = createRuntimeCloudClient,
    run = execFileWithInput,
    reportProgress = () => {},
  } = {},
) {
  const { values, positionals } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    allowPositionals: true,
    options: {
      branch: { type: "string" },
      apply: { type: "boolean" },
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
  const selected = order.filter((component) => components.has(component));
  const targets = selected.map((component) => ({
    component,
    name:
      component === "db"
        ? names.databases.domain
        : names.workers[roles[component]],
  }));
  const environment = `branch-${slug}`;
  if (!values.apply) return { status: "planned", environment, targets };

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
  const updatesWorkers = components.has("api") || components.has("web");
  const needsDatabase = components.has("api") || components.has("db");
  const [workers, databases, workersDomain] = await Promise.all([
    updatesWorkers ? client.list("/workers/workers") : [],
    needsDatabase ? client.list("/d1/database") : [],
    updatesWorkers ? client.api("/workers/subdomain") : undefined,
  ]);
  const databaseId = databases.find(
    ({ name }) => name === names.databases.domain,
  )?.uuid;
  if (
    needsDatabase &&
    !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(databaseId ?? "")
  )
    throw new Error(
      `Missing Preview database ${names.databases.domain} in ${environment}`,
    );
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
      const config = workerConfig(
        roles[component],
        names,
        { domain: databaseId },
        origin,
      );
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

  const directory = await mkdtemp(join(tmpdir(), "savia-preview-update-"));
  const execute = (operation, executable, args, commandEnv = env) => {
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
  const wrangler = (operation, args) =>
    execute(operation, "pnpm", [
      "--filter",
      "@savia/api",
      "exec",
      "wrangler",
      ...args,
    ]);
  try {
    const webAssetsDirectory = join(directory, "web-assets");
    if (components.has("web")) {
      const buildEnv = Object.fromEntries(
        Object.entries(env).filter(([key]) =>
          ["PATH", "HOME", "TMPDIR", "TEMP", "PNPM_HOME", "CI"].includes(key),
        ),
      );
      buildEnv.SAVIA_ADMIN_IGNORE_ENV_FILES = "true";
      buildEnv.SAVIA_CI_FLOWS_ENABLED = "false";
      buildEnv.SAVIA_ADMIN_OUT_DIR = webAssetsDirectory;
      await execute(
        "build web",
        "pnpm",
        ["--filter", "@savia/admin", "run", "build"],
        buildEnv,
      );
    }

    const configs = [];
    for (const { component, config } of workerUpdates) {
      if (component === "web") config.assets.directory = webAssetsDirectory;
      const path = join(directory, `${component}.json`);
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      await wrangler(`validate ${component}`, [
        "deploy",
        "--config",
        path,
        "--dry-run",
      ]);
      configs.push({ component, path });
    }
    if (components.has("db"))
      await execute("migrate db", "node", ["scripts/apply-d1-migrations.mjs"], {
        ...env,
        CLOUDFLARE_DATABASE_ID: databaseId,
      });
    for (const { component, path } of configs)
      await wrangler(`publish ${component}`, ["deploy", "--config", path]);
    return { status: "updated", environment, origin, targets };
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

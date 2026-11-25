import { appendFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnvironment } from "./environments.mjs";
import { readDeploymentOutputs } from "./render-from-outputs.mjs";
import { renderEnvFromOutputs } from "./outputs.mjs";
import { renderCloudflareConfigFromEnv } from "./worker-config.mjs";
import {
  readSharedRegistryOutputs,
  renderSharedRegistry,
} from "./shared-registry/render.mjs";
import { freezeRuntimeRelease } from "./runtime-artifact.mjs";
import { createRuntimeCloudClient } from "./runtime-cloud.mjs";
import { execFileWithInput } from "./runtime-publisher-branch.mjs";
import { derivePreviewCodeScope } from "../../scripts/preview-code-release.mjs";
import { restorePreviewFrontendArtifact } from "./preview-frontend-artifacts.mjs";
const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
export async function prepareEnvironmentRelease(
  { environment, destination },
  {
    env = process.env,
    run = execFileWithInput,
    freeze = freezeRuntimeRelease,
    readOutputs = readDeploymentOutputs,
    render = renderCloudflareConfigFromEnv,
    sharedOutputs = readSharedRegistryOutputs,
    renderShared = renderSharedRegistry,
    restoreFrontend = restorePreviewFrontendArtifact,
    client,
  } = {},
) {
  const descriptor = resolveEnvironment(environment);
  if (!["application", "shared"].includes(descriptor.kind))
    throw new Error("Use the branch deployment delegate for branch releases");
  if (
    environment === "production" &&
    (env.PRODUCTION_OPERATIONS_ENABLED !== "true" ||
      env.GITHUB_REF !== "refs/heads/main")
  )
    throw new Error("Production operations are disabled or not reviewed main");
  const revision = (
    await run("git", ["rev-parse", "HEAD"], { cwd: root, env })
  ).stdout.trim();
  if (!/^[a-f\d]{40}$/.test(revision))
    throw new Error("Exact checked-out source revision required");
  const codeOnly =
    environment === "preview"
      ? await derivePreviewCodeScope({
          base: env.SAVIA_PREVIEW_RELEASE_BASE,
          head: revision,
          cwd: root,
          run,
        })
      : null;
  let configs,
    operationEnv = { ...env };
  const frontendBuilds = [];
  if (descriptor.kind === "application") {
    const outputs = await readOutputs(environment, { env, run });
    operationEnv = { ...env, ...renderEnvFromOutputs(outputs, root) };
    await render(operationEnv);
    const apps = [
      "api",
      "auth",
      "admin",
      "mcp",
      "savia-request",
      "connector-gateway",
      "hook-executor",
      "backup-coordinator",
      ...(outputs.flowsEnabled ? ["flows/api"] : []),
      ...(environment === "preview" ? ["plugin-editor-runtime"] : []),
    ];
    const includesFrontend = codeOnly?.targets.includes("gateway") ?? false;
    if (environment === "preview" && (!codeOnly || includesFrontend)) {
      client ??= createRuntimeCloudClient(
        { accountId: env.CLOUDFLARE_ACCOUNT_ID, workers: [] },
        { env },
      );
      const { subdomain } = await client.api("/workers/subdomain");
      if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain ?? ""))
        throw new Error("Existing account Workers subdomain is required");
      operationEnv.SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL = `https://savia-plugin-editor-preview.${subdomain}.workers.dev`;
      operationEnv.VITE_PLUGIN_EDITOR_RUNTIME_URL = `${operationEnv.SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL}/plugin-editor`;
      frontendBuilds.push("build:plugin-editor");
    }
    if (!codeOnly || includesFrontend) frontendBuilds.push("build:assets");
    configs = apps.map((app) =>
      join(root, "apps", app, `wrangler.${environment}.jsonc`),
    );
    if (codeOnly) {
      const appForTarget = {
        gateway: "admin",
        pluginEditor: "plugin-editor-runtime",
        auth: "auth",
        mcp: "mcp",
        api: "api",
        request: "savia-request",
        connectors: "connector-gateway",
      };
      configs = configs.filter((path) =>
        codeOnly.targets.some((target) =>
          path.endsWith(`/apps/${appForTarget[target]}/wrangler.preview.jsonc`),
        ),
      );
      if (configs.length !== codeOnly.targets.length)
        throw new Error("Preview code scope contains an unsupported Worker");
    }
  } else {
    await sharedOutputs({ env, run });
    await renderShared({ env, run });
    configs = [join(root, "apps/plugin-registry/wrangler.production.jsonc")];
  }
  const frontendArtifactDirectory = env.SAVIA_PREVIEW_FRONTEND_ARTIFACT_DIR;
  if (
    environment === "preview" &&
    frontendBuilds.length &&
    frontendArtifactDirectory
  ) {
    try {
      const tree = (
        await run("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, env })
      ).stdout.trim();
      await restoreFrontend({
        root,
        directory: frontendArtifactDirectory,
        repository: env.GITHUB_REPOSITORY,
        revision,
        tree,
        pnpmVersion: (
          await run("pnpm", ["--version"], { cwd: root, env })
        ).stdout.trim(),
        env: operationEnv,
      });
      frontendBuilds.length = 0;
      console.log(
        "Reusing verified Preview frontend assets for the exact source and build inputs.",
      );
    } catch {
      console.log(
        "Preview frontend asset proof unavailable. Building from source.",
      );
    }
  }
  const buildFrontends = async () => {
    const results = await Promise.allSettled(
      frontendBuilds.map(async (script) =>
        run("pnpm", ["--filter", "@savia/admin", "run", script], {
          cwd: root,
          env: operationEnv,
        }),
      ),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  };
  const assetsReady =
    environment === "preview" && frontendBuilds.length
      ? buildFrontends()
      : undefined;
  if (!assetsReady) await buildFrontends();
  const [artifact, assets] = await Promise.allSettled([
    Promise.resolve().then(() =>
      freeze({
        environment,
        configs,
        destination: resolve(destination),
        sourceRevision: revision,
        ...(assetsReady ? { assetsReady } : {}),
        ...(codeOnly ? { codeOnly } : {}),
        ...(descriptor.kind === "application"
          ? { domainMigrations: join(root, "packages/db/migrations") }
          : {}),
      }),
    ),
    assetsReady,
  ]);
  if (assets.status === "rejected") throw assets.reason;
  if (artifact.status === "rejected") throw artifact.reason;
  if (env.GITHUB_ENV && operationEnv.SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL)
    await appendFile(
      env.GITHUB_ENV,
      `SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL=${operationEnv.SAVIA_PLUGIN_EDITOR_DEPLOYMENT_URL}\n`,
    );
  return { ...artifact.value, sourceRevision: revision };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const value = (flag) => {
    const index = argv.indexOf(flag);
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--"))
      throw new Error(`Missing ${flag}`);
    return argv[index + 1];
  };
  Promise.resolve()
    .then(() => {
      if (argv.length !== 4)
        throw new Error("Use --environment <id> --out <directory>");
      return prepareEnvironmentRelease({
        environment: value("--environment"),
        destination: value("--out"),
      });
    })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

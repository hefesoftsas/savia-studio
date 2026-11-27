import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import {
  join,
  dirname,
  resolve,
  relative,
  isAbsolute,
  basename,
  matchesGlob,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareRuntimeArtifact,
  assertCredentialFreeConfig,
} from "./runtime-publisher.mjs";
import { execFileWithInput } from "./runtime-publisher-branch.mjs";
const root = fileURLToPath(new URL("../../", import.meta.url));

const defaultModuleRules = [
  { type: "Text", globs: ["**/*.txt", "**/*.html", "**/*.sql"] },
  { type: "Data", globs: ["**/*.bin"] },
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

export async function previewWorkerStartupOptions(directory, config) {
  // Capture the emitted modules before assets and database migrations are copied in.
  const complete = new Set();
  const rules = [...(config.rules ?? []), ...defaultModuleRules].filter(
    (rule) => {
      if (complete.has(rule.type)) return false;
      if (rule.fallthrough !== true) complete.add(rule.type);
      return true;
    },
  );
  const entry = join(directory, config.main);
  const modules = [{ type: "ESModule", path: entry }];
  for (const file of await readdir(directory, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!file.isFile()) continue;
    const path = join(file.parentPath, file.name);
    if (path === entry) continue;
    const name = relative(directory, path).replaceAll("\\", "/");
    const rule = rules.find(({ globs }) =>
      globs.some((glob) => matchesGlob(name, glob)),
    );
    if (rule) modules.push({ type: rule.type, path });
  }
  return {
    name: config.name,
    modules,
    modulesRoot: directory,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: config.vars,
    unsafeRegisterWorker: false,
  };
}

export async function bootPreviewWorkers(workers) {
  const requireApi = createRequire(join(root, "apps/api/package.json"));
  const { Miniflare, convertV4MiniflareOptions } = requireApi("miniflare");
  const runtime = new Miniflare(
    convertV4MiniflareOptions({ host: "127.0.0.1", port: 0, workers }),
  );
  try {
    await runtime.ready;
  } catch (cause) {
    // Miniflare can repeat the startup failure while disposing the runtime.
    await runtime.dispose().catch(() => {});
    throw new Error("Prepared Preview Workers failed to start locally", {
      cause,
    });
  }
  await runtime.dispose();
}

async function normalizeBuildMetadata(directory) {
  // Wrangler's README embeds a timestamp and source maps use the temporary
  // outdir as sourceRoot. Neither should change a content-addressed release.
  await rm(join(directory, "README.md"), { force: true });
  for (const file of await readdir(directory))
    if (/\.m?js\.map$/.test(file)) {
      const path = join(directory, file),
        map = JSON.parse(await readFile(path, "utf8"));
      const sourceRoot = resolve(directory, map.sourceRoot ?? "");
      map.sources = (map.sources ?? []).map((source, index) => {
        if (/^[a-z]+:/.test(source)) return source;
        const absolute = resolve(sourceRoot, source),
          name = relative(root, absolute)
            .replaceAll("\\", "/")
            .replace(
              /\.wrangler\/tmp\/bundle-[^/]+\//g,
              ".wrangler/generated/",
            );
        if (!name.startsWith("..") && !isAbsolute(name)) return name;
        const digest = createHash("sha256")
          .update(map.sourcesContent?.[index] ?? basename(source))
          .digest("hex")
          .slice(0, 12);
        return `external/${digest}/${basename(source)}`;
      });
      map.sourceRoot = "";
      if (map.file) map.file = basename(map.file);
      await writeFile(path, JSON.stringify(map), { mode: 0o600 });
    }
}

export async function bundleRuntimeWorker(
  { path, config, directory, metafile },
  runWrangler,
) {
  await mkdir(directory, { recursive: true });
  await runWrangler([
    "deploy",
    "--dry-run",
    "--config",
    path,
    "--outdir",
    directory,
    "--metafile",
    metafile,
  ]);
  const metadata = JSON.parse(await readFile(metafile, "utf8"));
  const entries = Object.entries(metadata.outputs ?? {}).filter(
    ([file, info]) => info.entryPoint && /\.m?js$/.test(file),
  );
  if (entries.length !== 1)
    throw new Error("Worker compiler must produce one entry module");
  const requiredExports = [
    ...(config.durable_objects?.bindings ?? [])
      .filter(
        (binding) =>
          !binding.script_name || binding.script_name === config.name,
      )
      .map((binding) => binding.class_name),
    ...(config.workflows ?? [])
      .filter(
        (binding) =>
          !binding.script_name || binding.script_name === config.name,
      )
      .map((binding) => binding.class_name),
  ];
  if (requiredExports.some((name) => !entries[0][1].exports?.includes(name)))
    throw new Error(
      "Worker bundle is missing a declared Durable Object or Workflow export",
    );
  const entry = resolve(dirname(path), entries[0][0]);
  const main = relative(directory, entry);
  if (
    main.startsWith("..") ||
    isAbsolute(main) ||
    !(await stat(entry)).isFile()
  )
    throw new Error("Worker compiler entry is outside its frozen directory");
  await normalizeBuildMetadata(directory);
  return { main, no_bundle: true, find_additional_modules: true };
}

export async function freezeRuntimeRelease(
  {
    environment,
    configs,
    destination,
    domainMigrations,
    sourceRevision,
    codeOnly,
    assetsReady,
  },
  {
    runWrangler = async (args) => {
      try {
        return await execFileWithInput(
          join(root, "apps/api/node_modules/.bin/wrangler"),
          args,
          {
            cwd: root,
            env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
          },
        );
      } catch {
        throw new Error("Frozen Worker build failed");
      }
    },
  } = {},
) {
  let assetsInProgress = Boolean(assetsReady);
  let assetFailure;
  const assetBuild = assetsReady?.then(
    () => {
      assetsInProgress = false;
    },
    (reason) => {
      assetFailure = { reason };
    },
  );
  if (!Array.isArray(configs) || !configs.length)
    throw new Error("Prepared source configurations are required");
  const sources = [],
    names = new Set();
  for (const path of configs) {
    const config = JSON.parse(await readFile(path, "utf8"));
    if (
      !/^savia(?:-[a-z0-9]+)*$/.test(config.name) ||
      names.has(config.name) ||
      !config.main ||
      config.build?.command ||
      config.build?.cwd
    )
      throw new Error("Invalid or duplicate source Worker build target");
    assertCredentialFreeConfig(config);
    names.add(config.name);
    sources.push({ path: resolve(path), config });
  }
  const work = await mkdtemp(join(tmpdir(), "savia-frozen-build-"));
  const staging = join(work, "payload");
  await mkdir(staging);
  try {
    if (sourceRevision !== undefined) {
      if (!/^[a-f\d]{40}$/.test(sourceRevision))
        throw new Error("Exact source revision required");
      await writeFile(
        join(staging, "release-source.json"),
        JSON.stringify({
          version: 1,
          sourceRevision,
          ...(codeOnly ? { codeOnly } : {}),
        }),
        { mode: 0o600 },
      );
    }
    const frozen = {};
    const startupWorkers = [];
    const validateStartup =
      environment === "preview" || environment.startsWith("branch-");
    if (domainMigrations)
      await cp(domainMigrations, join(staging, "migrations"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    const freezeWorker = async ({ path, config }) => {
      const directory = join(staging, "workers", config.name);
      const bundle = await bundleRuntimeWorker(
        {
          path,
          config,
          directory,
          metafile: join(work, `${config.name}.build-meta.json`),
        },
        runWrangler,
      );
      const output = { ...structuredClone(config), ...bundle };
      if (
        ["preview", "production"].includes(environment) &&
        config.name ===
          (environment === "preview" ? "savia-auth-preview" : "savia-auth")
      ) {
        if (!sourceRevision)
          throw new Error("Managed Auth requires an exact source revision");
        output.vars = {
          ...output.vars,
          SAVIA_AUTH_DEPLOYMENT_REVISION: sourceRevision,
        };
      }
      delete output.$schema;
      delete output.build;
      const startup = validateStartup
        ? await previewWorkerStartupOptions(directory, output)
        : undefined;
      if (config.assets?.directory) {
        await cp(
          resolve(dirname(path), config.assets.directory),
          join(directory, "assets"),
          { recursive: true, errorOnExist: true, force: false },
        );
        output.assets.directory = "assets";
      }
      for (const [index, binding] of (output.d1_databases ?? []).entries())
        if (binding.migrations_dir) {
          const migrationDir = `migrations-${index}`;
          await cp(
            resolve(dirname(path), binding.migrations_dir),
            join(directory, migrationDir),
            { recursive: true, errorOnExist: true, force: false },
          );
          binding.migrations_dir = migrationDir;
        }
      if (output.migrations_dir) {
        await cp(
          resolve(dirname(path), output.migrations_dir),
          join(directory, "migrations"),
          { recursive: true, errorOnExist: true, force: false },
        );
        output.migrations_dir = "migrations";
      }
      for (const key of ["wasm_modules", "text_blobs", "data_blobs"])
        for (const [binding, source] of Object.entries(output[key] ?? {})) {
          if (!/^[A-Za-z0-9_]+$/.test(binding))
            throw new Error("Invalid frozen module binding");
          await mkdir(join(directory, "bindings"), { recursive: true });
          const target = `bindings/${binding}`;
          await cp(resolve(dirname(path), source), join(directory, target), {
            force: false,
            errorOnExist: true,
          });
          output[key][binding] = target;
        }
      return [`workers/${config.name}/wrangler.json`, output, startup];
    };
    const freezeSources = async (targets) => {
      let offset = 0;
      while (offset < targets.length) {
        if (assetFailure) throw assetFailure.reason;
        const batchSize =
          environment === "preview" && !assetsInProgress ? 2 : 1;
        const results = await Promise.allSettled(
          targets.slice(offset, offset + batchSize).map(freezeWorker),
        );
        for (const result of results) {
          if (result.status === "rejected") throw result.reason;
          const [path, config, startup] = result.value;
          frozen[path] = config;
          if (startup) startupWorkers.push(startup);
        }
        offset += batchSize;
      }
    };
    if (assetsReady) {
      await freezeSources(
        sources.filter(({ config }) => !config.assets?.directory),
      );
      await assetBuild;
      if (assetFailure) throw assetFailure.reason;
      await freezeSources(
        sources.filter(({ config }) => config.assets?.directory),
      );
    } else {
      await freezeSources(sources);
    }
    if (startupWorkers.length) await bootPreviewWorkers(startupWorkers);
    return await prepareRuntimeArtifact({
      environment,
      release: { directory: staging, configs: frozen },
      destination,
    });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

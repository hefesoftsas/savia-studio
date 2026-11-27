import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeRuntimeRelease } from "./runtime-artifact.mjs";
import { verifyRuntimeArtifact } from "./runtime-publisher.mjs";
test("managed Auth readiness is tied to the frozen source revision", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savia-auth-release-test-"));
  try {
    const config = join(directory, "auth.json");
    await writeFile(
      config,
      JSON.stringify({
        name: "savia-auth-preview",
        main: "worker.ts",
        vars: { BETTER_AUTH_URL: "https://savia-preview.hefesoft.com" },
      }),
    );
    const runWrangler = async (args) => {
      const out = args[args.indexOf("--outdir") + 1];
      await writeFile(join(out, "worker.mjs"), "export default {};");
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({
          outputs: { [join(out, "worker.mjs")]: { entryPoint: "worker.ts" } },
        }),
      );
    };
    const artifact = await freezeRuntimeRelease(
      {
        environment: "preview",
        configs: [config],
        sourceRevision: "a".repeat(40),
        codeOnly: {
          base: "b".repeat(40),
          head: "a".repeat(40),
          targets: ["auth"],
        },
        destination: join(directory, "release"),
      },
      { runWrangler },
    );
    const manifest = await verifyRuntimeArtifact(artifact);
    assert.deepEqual(manifest.releaseSource.codeOnly, {
      base: "b".repeat(40),
      head: "a".repeat(40),
      targets: ["auth"],
    });
    const source = JSON.parse(
      await readFile(
        join(artifact.artifactDirectory, "release-source.json"),
        "utf8",
      ),
    );
    assert.deepEqual(source.codeOnly, {
      base: "b".repeat(40),
      head: "a".repeat(40),
      targets: ["auth"],
    });
    const frozen = JSON.parse(
      await readFile(
        join(artifact.artifactDirectory, manifest.configs[0]),
        "utf8",
      ),
    );
    assert.equal(frozen.vars.SAVIA_AUTH_DEPLOYMENT_REVISION, "a".repeat(40));
    await assert.rejects(
      freezeRuntimeRelease(
        {
          environment: "preview",
          configs: [config],
          destination: join(directory, "invalid"),
        },
        { runWrangler },
      ),
      /source revision/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("artifact preparation bundles once and freezes code, assets and both migration histories", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savia-freeze-test-"));
  try {
    const app = join(directory, "app");
    await mkdir(app);
    await mkdir(join(app, "assets"));
    await writeFile(join(app, "assets", "index.html"), "fixture");
    await mkdir(join(app, "sql"));
    await writeFile(join(app, "sql", "0000.sql"), "SELECT 1;");
    await writeFile(join(app, "worker.ts"), "export default {};");
    const path = join(app, "wrangler.json");
    await writeFile(
      path,
      JSON.stringify({
        name: "savia-preview",
        main: "worker.ts",
        assets: { directory: "assets" },
        d1_databases: [{ binding: "DB", migrations_dir: "sql" }],
      }),
    );
    const calls = [];
    const runWrangler = async (args) => {
      calls.push(args);
      const out = args[args.indexOf("--outdir") + 1];
      await writeFile(join(out, "worker.mjs"), "export default {};");
      await writeFile(join(out, "README.md"), String(Math.random()));
      await writeFile(
        join(out, "worker.mjs.map"),
        JSON.stringify({
          version: 3,
          sourceRoot: out,
          sources: [join(app, "worker.ts")],
          sourcesContent: ["export default {};"],
        }),
      );
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({
          outputs: { [join(out, "worker.mjs")]: { entryPoint: "worker.ts" } },
        }),
      );
    };
    const artifact = await freezeRuntimeRelease(
      {
        environment: "preview",
        configs: [path],
        destination: join(directory, "artifact"),
        domainMigrations: join(app, "sql"),
      },
      { runWrangler },
    );
    const second = await freezeRuntimeRelease(
      {
        environment: "preview",
        configs: [path],
        destination: join(directory, "artifact-b"),
        domainMigrations: join(app, "sql"),
      },
      { runWrangler },
    );
    assert.equal(artifact.artifactDigest, second.artifactDigest);
    const manifest = await verifyRuntimeArtifact(artifact);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes("--dry-run"));
    const config = JSON.parse(
      await readFile(
        join(artifact.artifactDirectory, manifest.configs[0]),
        "utf8",
      ),
    );
    assert.equal(config.no_bundle, true);
    assert.equal(config.main, "worker.mjs");
    assert.equal(
      await readFile(
        join(artifact.artifactDirectory, "migrations", "0000.sql"),
        "utf8",
      ),
      "SELECT 1;",
    );
    assert.equal(
      await readFile(
        join(
          artifact.artifactDirectory,
          "workers",
          "savia-preview",
          config.assets.directory,
          "index.html",
        ),
        "utf8",
      ),
      "fixture",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Preview freezes independent Workers in parallel and waits before publishing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savia-freeze-parallel-"));
  try {
    const names = ["savia-preview", "savia-mcp-preview"];
    const configs = [];
    for (const name of names) {
      const config = join(directory, `${name}.json`);
      await writeFile(config, JSON.stringify({ name, main: "worker.ts" }));
      configs.push(config);
    }
    const running = [];
    const bothStarted = Promise.withResolvers();
    const runWrangler = async (args) => {
      running.push(args);
      if (running.length === configs.length) bothStarted.resolve();
      await bothStarted.promise;
      const out = args[args.indexOf("--outdir") + 1];
      await writeFile(join(out, "worker.mjs"), "export default {};");
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({
          outputs: { [join(out, "worker.mjs")]: { entryPoint: "worker.ts" } },
        }),
      );
    };
    const artifact = await freezeRuntimeRelease(
      {
        environment: "preview",
        configs,
        destination: join(directory, "release"),
      },
      { runWrangler },
    );
    const manifest = await verifyRuntimeArtifact(artifact);
    assert.deepEqual(
      manifest.configs,
      names.map((name) => `workers/${name}/wrangler.json`).sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Preview refuses to freeze a Worker that fails to start", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "savia-freeze-invalid-worker-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "wrangler.json");
  const destination = join(directory, "release");
  await writeFile(
    path,
    JSON.stringify({ name: "savia-preview", main: "worker.ts" }),
  );
  const runWrangler = async (args) => {
    const entry = join(args[args.indexOf("--outdir") + 1], "worker.mjs");
    await writeFile(
      entry,
      'export const invalidExport = "not a handler";\nexport default {};',
    );
    await writeFile(
      args[args.indexOf("--metafile") + 1],
      JSON.stringify({
        outputs: { [entry]: { entryPoint: "worker.ts" } },
      }),
    );
  };
  await assert.rejects(
    freezeRuntimeRelease(
      { environment: "preview", configs: [path], destination },
      { runWrangler },
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
  await assert.rejects(stat(destination), { code: "ENOENT" });
});

test("Preview freezes a WebAssembly Worker while the frontend assets build", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savia-freeze-assets-"));
  try {
    const backend = join(directory, "backend.json");
    const frontend = join(directory, "frontend.json");
    await writeFile(
      backend,
      JSON.stringify({
        name: "savia-hook-executor-preview",
        main: "worker.ts",
        rules: [
          { type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true },
        ],
      }),
    );
    await writeFile(
      frontend,
      JSON.stringify({
        name: "savia-preview",
        main: "worker.ts",
        assets: { directory: "assets" },
      }),
    );
    const assets = Promise.withResolvers();
    let assetsBuilt = false;
    const runWrangler = async (args) => {
      const config = args[args.indexOf("--config") + 1];
      if (config === backend) {
        assert.equal(assetsBuilt, false);
        // Release the frontend only after the independent Worker has started.
        await mkdir(join(directory, "assets"));
        await writeFile(join(directory, "assets", "index.html"), "generated");
        assetsBuilt = true;
        assets.resolve();
      } else {
        assert.equal(assetsBuilt, true);
      }
      const out = args[args.indexOf("--outdir") + 1];
      if (config === backend) {
        await writeFile(
          join(out, "script.wasm"),
          Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
        );
        await writeFile(
          join(out, "worker.mjs"),
          'import wasm from "./script.wasm";\nexport default { fetch: () => new Response(String(wasm instanceof WebAssembly.Module)) };',
        );
      } else {
        await writeFile(join(out, "worker.mjs"), "export default {};");
      }
      await writeFile(
        args[args.indexOf("--metafile") + 1],
        JSON.stringify({
          outputs: { [join(out, "worker.mjs")]: { entryPoint: "worker.ts" } },
        }),
      );
    };
    const artifact = await freezeRuntimeRelease(
      {
        environment: "preview",
        configs: [frontend, backend],
        destination: join(directory, "release"),
        assetsReady: assets.promise,
      },
      { runWrangler },
    );
    assert.equal(
      await readFile(
        join(
          artifact.artifactDirectory,
          "workers",
          "savia-preview",
          "assets",
          "index.html",
        ),
        "utf8",
      ),
      "generated",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

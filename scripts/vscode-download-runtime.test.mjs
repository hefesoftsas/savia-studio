import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderProductionConfigs } from "../infra/pulumi/worker-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const requireApi = createRequire(
  new URL("../apps/api/package.json", import.meta.url),
);
const requireAdmin = createRequire(
  new URL("../apps/admin/package.json", import.meta.url),
);

test("the Preview gateway starts from its actual entry and serves extension downloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "savia-vscode-download-"));
  const filename = "savia-plugin-authoring-0.1.0.vsix";
  const bytes = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
  const hash = createHash("sha256").update(bytes).digest("hex");
  let runtime;
  try {
    const outputRoot = join(directory, "config");
    await renderProductionConfigs({
      deploymentEnvironment: "preview",
      authD1Id: "preview-auth-test",
      domainD1Id: "preview-domain-test",
      documentsBucket: "savia-documents-preview",
      publicOrigin: "https://savia-preview.hefesoft.com",
      outputRoot,
    });
    const config = JSON.parse(
      await readFile(
        join(outputRoot, "apps/admin/wrangler.preview.jsonc"),
        "utf8",
      ),
    );
    const assets = join(directory, "assets");
    await mkdir(join(assets, "downloads"), { recursive: true });
    await writeFile(join(assets, "index.html"), "<html>Savia Admin</html>");
    await writeFile(join(assets, "downloads", filename), bytes);
    await writeFile(
      join(assets, "downloads", `${filename}.sha256`),
      `${hash}  ${filename}\n`,
    );
    const { outputFiles } = await requireAdmin("esbuild").build({
      entryPoints: [join(root, "apps/admin", config.main)],
      bundle: true,
      format: "esm",
      platform: "browser",
      write: false,
    });
    const { Miniflare, convertV4MiniflareOptions } = requireApi("miniflare");
    runtime = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: outputFiles[0].text,
        compatibilityDate: config.compatibility_date,
        compatibilityFlags: config.compatibility_flags,
        bindings: config.vars,
        assets: {
          directory: assets,
          binding: config.assets.binding,
          run_worker_first: config.assets.run_worker_first,
          routerConfig: { has_user_worker: true },
          assetConfig: { not_found_handling: config.assets.not_found_handling },
        },
        serviceBindings: {
          API: (request) =>
            Response.json({
              tenant: request.headers.get("x-savia-tenant-slug"),
            }),
        },
      }),
    );

    const origin = "https://savia-preview.hefesoft.com";
    const tenantApi = await runtime.dispatchFetch(
      "https://demo.savia-preview.hefesoft.com/v1/identity/me",
    );
    assert.equal(tenantApi.status, 200);
    assert.deepEqual(await tenantApi.json(), { tenant: "demo" });
    const url = `${origin}/downloads/${filename}`;
    const download = await runtime.dispatchFetch(url);
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("content-disposition"),
      `attachment; filename="${filename}"`,
    );
    const downloaded = new Uint8Array(await download.arrayBuffer());
    assert.deepEqual(downloaded, bytes);
    const checksum = await runtime.dispatchFetch(`${url}.sha256`);
    assert.equal(checksum.status, 200);
    assert.equal(
      (await checksum.text()).split(/\s/)[0],
      createHash("sha256").update(downloaded).digest("hex"),
    );
    const metadata = await runtime.dispatchFetch(url, { method: "HEAD" });
    assert.equal(metadata.status, 200);
    assert.equal((await metadata.arrayBuffer()).byteLength, 0);

    for (const suffix of [".vsix", ".vsix.sha256"]) {
      const missing = await runtime.dispatchFetch(
        `${origin}/downloads/savia-plugin-authoring-999.0.0${suffix}`,
        { headers: { "sec-fetch-mode": "navigate", accept: "text/html" } },
      );
      assert.equal(missing.status, 404);
      assert.equal(missing.headers.get("cache-control"), "no-store");
      assert.equal(await missing.text(), "");
    }
  } finally {
    await runtime?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

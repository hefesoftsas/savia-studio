import { build } from "esbuild";
import type { Plugin } from "vite";
import { fileURLToPath } from "node:url";

/** Both the browser editor and native VSIX ship these same pinned bundles. */
export async function buildPluginIdeRuntime(): Promise<string> {
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL(
          "../src/features/studio-engine/plugin-ide-react-runtime.ts",
          import.meta.url,
        ),
      ),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "SaviaPluginReact",
    platform: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}
const vendorBundles = [
  { name: "zod", globalName: "SaviaPluginZod" },
  { name: "pdf-lib", globalName: "SaviaPluginPdf" },
] as const;

async function buildPluginIdeVendorBundle({
  name,
  globalName,
}: (typeof vendorBundles)[number]): Promise<string> {
  const result = await build({
    stdin: {
      contents: `export * from "${name}";`,
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      sourcefile: "plugin-vendor.js",
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    platform: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  return result.outputFiles[0].text;
}

async function buildPluginIdeVendorBundles(): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      vendorBundles.map(async (vendor) => [
        vendor.name,
        await buildPluginIdeVendorBundle(vendor),
      ]),
    ),
  );
}
export async function buildPluginIdeBundles() {
  const [runtimeBundle, vendorBundles] = await Promise.all([
    buildPluginIdeRuntime(),
    buildPluginIdeVendorBundles(),
  ]);
  return { runtimeBundle, vendorBundles };
}
export function pluginIdeRuntimePlugin(): Plugin {
  const runtimeId = "virtual:savia-plugin-ide-runtime";
  const vendorById = new Map(
    vendorBundles.map((vendor) => [
      `virtual:savia-plugin-ide-vendor/${vendor.name}`,
      vendor,
    ]),
  );
  let bundled: Promise<string> | undefined;
  const vendors = new Map<string, Promise<string>>();
  return {
    name: "savia-plugin-ide-runtime",
    resolveId(id) {
      if (id === runtimeId || vendorById.has(id)) return `\0${id}`;
    },
    async load(id) {
      if (!id.startsWith("\0")) return;
      const moduleId = id.slice(1);
      if (moduleId === runtimeId) {
        bundled ??= buildPluginIdeRuntime();
        return `export default ${JSON.stringify(await bundled)}`;
      }
      const vendor = vendorById.get(moduleId);
      if (!vendor) return;
      let bundle = vendors.get(vendor.name);
      if (!bundle) {
        bundle = buildPluginIdeVendorBundle(vendor);
        vendors.set(vendor.name, bundle);
      }
      return `export default ${JSON.stringify(await bundle)}`;
    },
  };
}

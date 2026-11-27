import type { AuthoringBundleSources } from "@savia/plugin-authoring/bundles";

export const browserPluginBundles: AuthoringBundleSources = {
  runtimeBundle: () =>
    import("virtual:savia-plugin-ide-runtime").then((module) => module.default),
  vendorBundles: {
    zod: () =>
      import("virtual:savia-plugin-ide-vendor/zod").then(
        (module) => module.default,
      ),
    "pdf-lib": () =>
      import("virtual:savia-plugin-ide-vendor/pdf-lib").then(
        (module) => module.default,
      ),
  },
};

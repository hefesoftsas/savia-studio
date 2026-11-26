import { expect, it } from "vitest";
import { collectOfflineShellAssets } from "./offline-shell-assets";

it("precaches record routes and their static closure without traversing optional editors or icon catalogs", () => {
  const chunk = (
    name: string,
    facadeModuleId: string,
    imports: string[] = [],
    dynamicImports: string[] = [],
    css: string[] = [],
  ) => ({
    type: "chunk" as const,
    fileName: name,
    facadeModuleId,
    imports,
    dynamicImports,
    code: "code",
    isEntry: name === "entry.js",
    viteMetadata: { importedCss: new Set(css) },
  });
  const style = (name: string) => ({
    type: "asset" as const,
    fileName: name,
    source: new TextEncoder().encode(".card{display:block}"),
  });
  const bundle = {
    "office.js": {
      ...chunk("office.js", "/office/index.html", ["office-engine.js"]),
      isEntry: true,
    },
    "pluginEditor.js": {
      ...chunk(
        "pluginEditor.js",
        "/plugin-editor.html",
        ["extension-host.js"],
        [],
        ["plugin-editor.css"],
      ),
      isEntry: true,
    },
    "extension-host.js": chunk("extension-host.js", "extension-host"),
    "office-engine.js": chunk(
      "office-engine.js",
      "/features/office/office-engine.ts",
    ),
    "entry.js": chunk(
      "entry.js",
      "/src/main.tsx",
      ["shared.js"],
      ["crm.js"],
      ["main.css"],
    ),
    "private-app.js": chunk("private-app.js", "/src/app.tsx", ["shared.js"]),
    "appearance.js": chunk("appearance.js", "/admin/appearance-cache.ts"),
    "registration.js": chunk(
      "registration.js",
      "/pwa/register-service-worker.ts",
    ),
    "public.js": chunk("public.js", "/public-forms/public-form-page.tsx"),
    "crm.js": chunk(
      "crm.js",
      "/studio/studio-page.tsx",
      [],
      ["records.js", "studio.js"],
    ),
    "records.js": chunk(
      "records.js",
      "/studio-engine/records.tsx",
      ["table.js"],
      ["editor.js"],
      ["records.css"],
    ),
    "detail.js": chunk("detail.js", "/studio-engine/record-detail.tsx"),
    "form.js": chunk("form.js", "/studio-engine/collection-record-form.tsx"),
    "shared.js": chunk("shared.js", "shared", [], [], ["shared.css"]),
    "table.js": chunk("table.js", "table", ["shared.js"]),
    "studio.js": chunk("studio.js", "/studio-engine/screen-manager.tsx"),
    "editor.js": chunk("editor.js", "editor", [], ["icon.js"], ["editor.css"]),
    "icon.js": chunk("icon.js", "lucide/icon"),
    "main.css": style("main.css"),
    "shared.css": style("shared.css"),
    "records.css": style("records.css"),
    "editor.css": style("editor.css"),
    "plugin-editor.css": style("plugin-editor.css"),
  };
  const assets = collectOfflineShellAssets(bundle);
  expect([...assets.keys()].sort()).toEqual(
    [
      "entry.js",
      "private-app.js",
      "appearance.js",
      "registration.js",
      "crm.js",
      "records.js",
      "detail.js",
      "form.js",
      "shared.js",
      "table.js",
      "main.css",
      "shared.css",
      "records.css",
    ].sort(),
  );
  expect(assets.get("records.css")).toBe(
    bundle["records.css"].source.byteLength,
  );
});

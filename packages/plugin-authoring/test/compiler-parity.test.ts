import { beforeAll, describe, expect, it, vi } from "vitest";
import { buildPluginIdeBundles } from "../../../apps/admin/build/plugin-ide-runtime";
import {
  compileAuthoringProject,
  packageAuthoringProject,
} from "../src/compiler";
import {
  createPluginProject,
  packagePluginProject,
} from "../../../apps/admin/src/features/studio-engine/plugin-ide-project";
let bundles: Awaited<ReturnType<typeof buildPluginIdeBundles>>;
beforeAll(async () => {
  bundles = await buildPluginIdeBundles();
});
describe("shared browser and native authoring compiler", () => {
  it("loads only the compiler bundles referenced by the retained project", async () => {
    const lazyBundles = {
      runtimeBundle: vi.fn(async () => bundles.runtimeBundle),
      vendorBundles: {
        zod: vi.fn(async () => bundles.vendorBundles.zod),
        "pdf-lib": vi.fn(async () => bundles.vendorBundles["pdf-lib"]),
      },
    };
    const files = createPluginProject();
    const starter = await compileAuthoringProject(files, lazyBundles);
    expect(lazyBundles.runtimeBundle).toHaveBeenCalledOnce();
    expect(starter.entryJs).toBe(
      (await compileAuthoringProject(files, bundles)).entryJs,
    );
    expect(lazyBundles.vendorBundles.zod).not.toHaveBeenCalled();
    expect(lazyBundles.vendorBundles["pdf-lib"]).not.toHaveBeenCalled();

    const archive = {
      ...files,
      "original-source.json": JSON.stringify({
        "entry.tsx":
          'import { z } from "zod"; export function render(el) { el.textContent = z.string().parse("Hello"); }',
        "unused.ts":
          'import { PDFDocument } from "pdf-lib"; export { PDFDocument };',
      }),
    };
    const compiled = await compileAuthoringProject(archive, lazyBundles);
    expect(compiled.entryJs).toBe(
      (await compileAuthoringProject(archive, bundles)).entryJs,
    );
    expect(lazyBundles.vendorBundles.zod).toHaveBeenCalledOnce();
    expect(lazyBundles.vendorBundles["pdf-lib"]).not.toHaveBeenCalled();
    const browser = await packagePluginProject(archive);
    expect(browser.entryJs).toBe(compiled.entryJs);
  });

  it("produces identical deterministic ZIP bytes and fixtures without running source", async () => {
    const files = createPluginProject();
    files["entry.tsx"] =
      'globalThis.__saviaSourceExecuted = true; export function render(el: HTMLElement) { el.textContent="Hello"; }';
    const native = await packageAuthoringProject(files, bundles);
    const browser = await packagePluginProject(files);
    expect(native.zipBytes).toEqual(
      new Uint8Array(await browser.blob.arrayBuffer()),
    );
    expect(native.entryJs).toContain('el.textContent="Hello"');
    expect((globalThis as any).__saviaSourceExecuted).toBeUndefined();
    expect((await compileAuthoringProject(files, bundles)).fixtures).toEqual({
      collections: {},
      settings: {},
    });
    expect((await packageAuthoringProject(files, bundles)).zipBytes).toEqual(
      native.zipBytes,
    );
  });
  it("retains nested SDK sources, assets and CommonJS cycles in both adapters", async () => {
    const files = createPluginProject();
    files["original-source.json"] = JSON.stringify({
      "packages/example/src/entry.tsx":
        'import { greeting } from "@savia/test"; import image from "./image.png"; import "./style.css"; export function render(el) { el.textContent=greeting+image; }',
      "packages/test/src/index.ts":
        'import { name } from "./name"; export const greeting=name;',
      "packages/test/src/name.ts":
        'import { greeting } from "./index"; export const name="Hi";',
      "packages/example/src/image.png": "data:image/png;base64,aGVsbG8=",
      "packages/example/src/style.css": ".example {color:red}",
    });
    const native = await packageAuthoringProject(files, bundles);
    expect(native.zipBytes).toEqual(
      new Uint8Array(
        await (await packagePluginProject(files)).blob.arrayBuffer(),
      ),
    );
    expect(native.entryJs).toContain("data:image/png;base64,aGVsbG8=");
    expect(native.entryJs).toContain("packages/test/src/name.ts");
  });
  it("rejects arbitrary npm resolution, missing assets and unsafe fixtures", async () => {
    const files = createPluginProject();
    for (const source of [
      'import x from "unsupported-package"; export function render(el) { el.textContent=x; }',
      'import x from "./missing.png"; export function render(el) { el.textContent=x; }',
    ])
      await expect(
        compileAuthoringProject(
          {
            ...files,
            "original-source.json": JSON.stringify({ "entry.tsx": source }),
          },
          bundles,
        ),
      ).rejects.toThrow();
    await expect(
      compileAuthoringProject(
        {
          ...files,
          "preview.json": '{"collections":{},"settings":{"__proto__":{}}}',
        },
        bundles,
      ),
    ).rejects.toThrow("Unsafe");
  });
  it("enforces the authored entry and original archive byte limits", async () => {
    const files = createPluginProject();
    await expect(
      compileAuthoringProject(
        { ...files, "entry.tsx": "x".repeat(2 * 1024 * 1024 + 1) },
        bundles,
      ),
    ).rejects.toThrow();
    await expect(
      compileAuthoringProject(
        {
          ...files,
          "original-source.json": JSON.stringify({
            "entry.tsx": "x".repeat(2 * 1024 * 1024),
          }),
        },
        bundles,
      ),
    ).rejects.toThrow();
  });
});

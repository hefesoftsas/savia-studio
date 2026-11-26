import { expect, it, vi } from "vitest";
import { createPluginEditorFileSync } from "../plugin-editor-file-sync";

it("writes the acknowledged edit without rewriting unchanged unopened files", async () => {
  const writeFile = vi.fn().mockResolvedValue(undefined);
  const applyToModel = vi.fn();
  const sync = createPluginEditorFileSync({
    writeFile,
    removeFile: vi.fn(),
    applyToModel,
  });
  const edits = new Map<string, number>();
  const files = { "entry.tsx": "before", "unused.ts": "unchanged" };

  await sync({ files, acknowledgements: {} }, edits);
  expect(writeFile.mock.calls).toEqual(Object.entries(files));
  writeFile.mockClear();

  edits.set("entry.tsx", 1);
  await sync({ files, acknowledgements: {} }, edits);
  expect(writeFile).not.toHaveBeenCalled();
  expect(edits.get("entry.tsx")).toBe(1);

  await sync(
    {
      files: { ...files, "entry.tsx": "after" },
      acknowledgements: { "entry.tsx": 1 },
    },
    edits,
  );
  expect(writeFile.mock.calls).toEqual([["entry.tsx", "after"]]);
  expect(edits.has("entry.tsx")).toBe(false);
});

it("does not overwrite a newer local edit that arrives during a write", async () => {
  const edits = new Map([["entry.tsx", 1]]);
  const applyToModel = vi.fn();
  const sync = createPluginEditorFileSync({
    async writeFile() {
      edits.set("entry.tsx", 2);
    },
    removeFile: vi.fn(),
    applyToModel,
  });
  await sync(
    { files: { "entry.tsx": "first" }, acknowledgements: { "entry.tsx": 1 } },
    edits,
  );
  expect(applyToModel).not.toHaveBeenCalled();
  expect(edits.get("entry.tsx")).toBe(2);
});

it("retries the same file after a write failure", async () => {
  const writeFile = vi
    .fn()
    .mockRejectedValueOnce(new Error("write failed"))
    .mockResolvedValueOnce(undefined);
  const applyToModel = vi.fn();
  const sync = createPluginEditorFileSync({
    writeFile,
    removeFile: vi.fn(),
    applyToModel,
  });
  const edits = new Map<string, number>();
  const state = { files: { "entry.tsx": "source" }, acknowledgements: {} };

  await expect(sync(state, edits)).rejects.toThrow("write failed");
  expect(applyToModel).not.toHaveBeenCalled();
  await sync(state, edits);
  expect(writeFile).toHaveBeenCalledTimes(2);
  expect(applyToModel).toHaveBeenCalledWith("entry.tsx", "source");
});

it("removes stale paths before writing replacement project files", async () => {
  const virtualFiles = new Map([["savia-globals.d.ts", "generated"]]);
  const operations: string[] = [];
  const sync = createPluginEditorFileSync({
    async writeFile(path, value) {
      operations.push(`write ${path}`);
      virtualFiles.set(path, value);
    },
    async removeFile(path) {
      operations.push(`remove ${path}`);
      virtualFiles.delete(path);
    },
    applyToModel: vi.fn(),
  });
  const edits = new Map<string, number>();
  const initial = { "entry.tsx": "source", "src/old.ts": "old" };
  await sync({ files: initial, acknowledgements: {} }, edits);
  operations.length = 0;
  edits.set("src/old.ts", 1);

  const files = { "entry.tsx": "source", "src/new.ts": "new" };
  await sync({ files, acknowledgements: {} }, edits);

  expect(operations).toEqual(["remove src/old.ts", "write src/new.ts"]);
  expect(Object.fromEntries(virtualFiles)).toEqual({
    ...files,
    "savia-globals.d.ts": "generated",
  });
  expect(edits.has("src/old.ts")).toBe(false);
});

it("retries removing a stale path before applying a replacement", async () => {
  const removeFile = vi
    .fn()
    .mockRejectedValueOnce(new Error("remove failed"))
    .mockResolvedValueOnce(undefined);
  const writeFile = vi.fn();
  const sync = createPluginEditorFileSync({
    writeFile,
    removeFile,
    applyToModel: vi.fn(),
  });
  const edits = new Map<string, number>();
  await sync({ files: { "src/old.ts": "old" }, acknowledgements: {} }, edits);
  writeFile.mockClear();
  const replacement = { files: { "src/new.ts": "new" }, acknowledgements: {} };

  await expect(sync(replacement, edits)).rejects.toThrow("remove failed");
  expect(writeFile).not.toHaveBeenCalled();
  await sync(replacement, edits);
  expect(removeFile.mock.calls).toEqual([["src/old.ts"], ["src/old.ts"]]);
  expect(writeFile).toHaveBeenCalledExactlyOnceWith("src/new.ts", "new");
});

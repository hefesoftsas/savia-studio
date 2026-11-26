import type { EditorState } from "./plugin-vscode-protocol";

export function createPluginEditorFileSync({
  writeFile,
  removeFile,
  applyToModel,
}: {
  writeFile(path: string, value: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  applyToModel(path: string, value: string): void;
}) {
  const writtenFiles = new Map<string, string>();

  return async (
    {
      files,
      acknowledgements,
    }: Pick<EditorState, "files" | "acknowledgements">,
    localEdits: Map<string, number>,
  ) => {
    for (const path of writtenFiles.keys()) {
      if (Object.hasOwn(files, path)) continue;
      await removeFile(path);
      writtenFiles.delete(path);
      localEdits.delete(path);
    }
    for (const [path, value] of Object.entries(files)) {
      const pendingEdit = localEdits.get(path);
      if (pendingEdit !== undefined) {
        if ((acknowledgements[path] ?? 0) < pendingEdit) continue;
        localEdits.delete(path);
      }
      if (writtenFiles.get(path) !== value) {
        await writeFile(path, value);
        writtenFiles.set(path, value);
      }
      // The user may have typed again while the previous edit was written.
      if (!localEdits.has(path)) applyToModel(path, value);
    }
  };
}

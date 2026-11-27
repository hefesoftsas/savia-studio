import { browserPluginBundles } from "./plugin-ide-bundles";
import {
  compileAuthoringProject,
  packageAuthoringProject,
  type IdeFiles,
} from "@savia/plugin-authoring/project";
export {
  createPluginProject,
  serializePluginProject,
  parsePluginProject,
} from "@savia/plugin-authoring/project";
export type {
  IdeFiles,
  PluginIdeFixtures,
} from "@savia/plugin-authoring/project";
export function compilePluginProject(files: IdeFiles) {
  return compileAuthoringProject(files, browserPluginBundles);
}
export async function packagePluginProject(files: IdeFiles) {
  const packaged = await packageAuthoringProject(files, browserPluginBundles);
  return {
    blob: new Blob([packaged.zipBytes.buffer as ArrayBuffer], {
      type: "application/zip",
    }),
    manifest: packaged.manifest,
    entryJs: packaged.entryJs,
  };
}

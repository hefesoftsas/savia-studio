import { browserPluginBundles } from "./plugin-ide-bundles";
import { compilePluginSourceArchive as compileSource } from "@savia/plugin-authoring/source-compiler";
export {
  pluginSourceEntry,
  findMissingPluginSourceAssets,
} from "@savia/plugin-authoring/source-compiler";
export function compilePluginSourceArchive(archive: string) {
  return compileSource(archive, browserPluginBundles);
}

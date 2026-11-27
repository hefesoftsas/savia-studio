import type { LucideIcon } from "lucide-react";

const lucideIconLoaders = import.meta.glob<{ default: LucideIcon }>(
  ["@lucide-icon-dist/*.mjs", "!@lucide-icon-dist/index.mjs"],
  // Keep configurable lookups lazy when an icon is also used by the app shell.
  { query: "?savia-configurable-icon" },
);

const loaderByIconId = new Map<
  string,
  () => Promise<{ default: LucideIcon }>
>();

for (const [path, loader] of Object.entries(lucideIconLoaders)) {
  const match = path.match(/\/([^/]+)\.mjs$/);
  if (!match) continue;
  loaderByIconId.set(match[1], loader);
}

export async function loadLucideIcon(name: string) {
  const loader = loaderByIconId.get(name);
  return loader ? (await loader()).default : null;
}

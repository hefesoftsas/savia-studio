import type { ComponentType } from "react";
import { useLookupIcon } from "./use-lookup-icon";
import type { SvgIconProps } from "@thesvg/react";

type ThesvgIconComponent = ComponentType<SvgIconProps>;

const thesvgIconLoaders = import.meta.glob<{ default: ThesvgIconComponent }>([
  "@thesvg-icon-dist/*.js",
  "!@thesvg-icon-dist/index.js",
]);

const loaderByIconId = new Map<
  string,
  () => Promise<{ default: ThesvgIconComponent }>
>();

for (const [path, loader] of Object.entries(thesvgIconLoaders)) {
  const match = path.match(/\/([^/]+)\.js$/);
  if (!match) continue;
  loaderByIconId.set(match[1], loader);
}

const componentCache = new Map<string, ThesvgIconComponent>();

async function loadThesvgIconComponent(name: string) {
  const cached = componentCache.get(name);
  if (cached) return cached;

  const loader = loaderByIconId.get(name);
  if (!loader) return null;

  const module = await loader();
  componentCache.set(name, module.default);
  return module.default;
}

export function ThesvgLookupIcon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const Icon = useLookupIcon(name, componentCache, loadThesvgIconComponent);

  if (!Icon) {
    return <span className={className} aria-hidden="true" />;
  }

  return <Icon className={className} aria-hidden="true" />;
}

export function hasThesvgIconLoader(name: string) {
  return loaderByIconId.has(name);
}

export const thesvgIconLoaderCount = loaderByIconId.size;

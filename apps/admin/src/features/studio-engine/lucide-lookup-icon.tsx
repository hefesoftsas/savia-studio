import { useLookupIcon } from "./use-lookup-icon";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

const componentCache = new Map<string, LucideIcon>();

async function loadLucideIconComponent(name: string) {
  const cached = componentCache.get(name);
  if (cached) return cached;

  const { loadLucideIcon } = await import("./lucide-icon-catalog");
  const icon = await loadLucideIcon(name);
  if (icon) componentCache.set(name, icon);
  return icon;
}

export function LucideLookupIcon({
  name,
  className,
  fallback,
}: {
  name: string;
  className?: string;
  fallback?: ReactNode;
}) {
  const Icon = useLookupIcon(name, componentCache, loadLucideIconComponent);

  if (!Icon) {
    return fallback ?? <span className={className} aria-hidden="true" />;
  }

  return <Icon aria-hidden="true" className={className} />;
}

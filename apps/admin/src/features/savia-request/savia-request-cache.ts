import type { FlowSummary, RequestFlow } from "./types";

export type SaviaRequestSnapshot = {
  flows: FlowSummary[];
  folders: string[];
  flow: RequestFlow | null;
  stepIndex: number;
  error: string | null;
  updatedAt: number;
};

const snapshots = new Map<string, SaviaRequestSnapshot>();

export function saviaRequestCacheKey(scope: string | undefined): string {
  return scope ?? "__platform__";
}

/** Estado conservado en memoria al salir de la ruta (mismo ámbito). */
export function readSaviaRequestSnapshot(
  scope: string | undefined,
): SaviaRequestSnapshot | undefined {
  return snapshots.get(saviaRequestCacheKey(scope));
}

export function writeSaviaRequestSnapshot(
  scope: string | undefined,
  snapshot: SaviaRequestSnapshot,
): void {
  const key = saviaRequestCacheKey(scope);
  const { flow } = snapshot;
  if (!flow?.variables.some((variable) => variable.secret && variable.value)) {
    snapshots.set(key, snapshot);
    return;
  }
  const variables = flow.variables.map((variable) =>
    variable.secret && variable.value ? { ...variable, value: "" } : variable,
  );
  snapshots.set(key, { ...snapshot, flow: { ...flow, variables } });
}

/** Limpia el ámbito anterior al cambiar de tenant/permisos/sesión. */
export function clearSaviaRequestSnapshot(scope?: string | undefined): void {
  if (scope === undefined) {
    snapshots.clear();
    return;
  }
  snapshots.delete(saviaRequestCacheKey(scope));
}

export function clearAllSaviaRequestSnapshots(): void {
  snapshots.clear();
}

export function isSaviaFlowsDisabled(): boolean {
  return import.meta.env.VITE_SAVIA_FLOWS_DISABLED === "true";
}

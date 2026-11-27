import type { RequestResult } from "../../../../api/src/request-results/contracts";
import type { RequestAction } from "@savia/studio-shared/request-page";
import { apiFetch } from "./api";
import { getStudioRuntime } from "./runtime";
export type PageRun = {
  id: string;
  tenantId: string;
  pageName: string;
  actionId: string;
  label: string;
  mode: "mock" | "live";
  status: "running" | "complete" | "failed";
  values: Record<string, unknown>;
  result: RequestResult | null;
  error: string | null;
  createdAt: string;
};
export async function requestPageApi<T>(
  path: string,
  body?: unknown,
): Promise<T> {
  const transport = getStudioRuntime().requestTransport;
  if (!transport)
    throw new Error("Abre esta página desde Savia para conectar sus requests.");
  return apiFetch<T>(
    path,
    body === undefined
      ? { method: "GET" }
      : { method: "POST", body: JSON.stringify(body) },
    transport,
  );
}
export async function executeRequestPageAction(
  pageName: string,
  action: RequestAction,
  values: Record<string, unknown>,
  mode: PageRun["mode"] = "mock",
  id: string = crypto.randomUUID(),
): Promise<PageRun> {
  const run = await requestPageApi<PageRun>("/runs", {
    id,
    tenantId: getStudioRuntime().tenantId ?? 0,
    pageName,
    actionId: action.id,
    mode,
    values,
  });
  if (run?.id !== id || !["running", "complete", "failed"].includes(run.status))
    throw new Error("La respuesta no confirmó la ejecución solicitada.");
  return run;
}

import {
  useRealtimeRefresh,
  RemoteChangesNotice,
} from "@/realtime/use-realtime-refresh";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useLocation } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  FilePlus2,
  History,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
  Workflow,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RouteLoading } from "@/components/admin/route-loading";
import {
  getSessionGeneration,
  useSessionGeneration,
} from "@/auth/session-scope";
import { isReadAccessDenied } from "@/queries/read-state";
import type { RequestResult } from "../../../../api/src/request-results/contracts";
import { useAppServices } from "@/features/assistant/assistant-context";
import { StandardResult } from "./standard-result";
import { SecretsScreen } from "./secrets-screen";
import { SaviaRequestScopeBar } from "./savia-request-scope-bar";
import { useSaviaRequestWorkspace } from "./savia-request-provider";
import {
  hasRenamedVariableKey,
  type RequestFlow,
  type RequestRun,
  type RequestStep,
  type RequestVariable,
} from "./types";
import { CodeEditor } from "./editor/code-editor";
import { DeleteDialog, useDeleteConfirmation } from "./editor/delete-dialog";
import { VariableAccessContext } from "./editor/variable-context";
import { VariableInput } from "./editor/variable-input";
import { VariableNames } from "./editor/variable-completion";

type WorkspaceTab = "steps" | "variables" | "run" | "history";
type EditorPane = "body" | "headers" | "pre" | "post";

function requestDestinationLabel(flow: RequestFlow): string {
  const hosts = flow.steps.map((step) => {
    try {
      const url = new URL(step.url);
      return url.username || url.password ? null : url.host;
    } catch {
      return null;
    }
  });
  const uniqueHosts = [...new Set(hosts)];
  if (hosts.length > 0 && hosts.every(Boolean) && uniqueHosts.length === 1) {
    return uniqueHosts[0]!;
  }
  return flow.provider ?? "proveedor";
}

function displayInput(values: Record<string, string>) {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => {
        if (!key.endsWith("_request_body")) return [key, value];
        try {
          return [key, JSON.parse(value)];
        } catch {
          return [key, value];
        }
      }),
    ),
    null,
    2,
  );
}

function executionInput(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("La entrada debe ser un objeto JSON.");
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      typeof field === "object" ? JSON.stringify(field) : String(field),
    ]),
  );
}

function emptyFlow(): RequestFlow {
  const id = `request-${crypto.randomUUID()}`;
  return {
    id,
    name: "Nuevo flow",
    folderPath: "Mis requests",
    provider: "Personalizado",
    kind: "request",
    description: "",
    input: {},
    variables: [],
    versions: [],
    steps: [
      {
        id: crypto.randomUUID(),
        name: "Nuevo request",
        url: "https://",
        method: "GET",
        headers: { accept: "application/json" },
        body: "",
        bodyType: "none",
        pre: "",
        post: "",
      },
    ],
  };
}

function emptyStep(): RequestStep {
  return {
    id: crypto.randomUUID(),
    name: "Nuevo request",
    url: "https://",
    method: "GET",
    headers: { accept: "application/json" },
    body: "",
    bodyType: "none",
    pre: "",
    post: "",
  };
}

function bodyLanguage(step: RequestStep): "json" | "xml" | "text" {
  if (
    step.bodyType === "json" ||
    step.headers["content-type"]?.includes("json")
  ) {
    return "json";
  }
  if (step.bodyType === "xml" || !step.bodyType) return "xml";
  return "text";
}

export function SaviaRequestWorkspace() {
  const services = useAppServices();
  const {
    active,
    api,
    busy,
    clearSelection,
    createAndSelectFlow,
    discardDraft,
    dirty,
    duplicateAndSelectFlow,
    error,
    flow,
    flows,
    folders,
    refreshNavigation,
    reloadFlow,
    retryRoute,
    routeLoading,
    routeReadError,
    saveDraft,
    scope,
    selectFlow,
    stepIndex,
    updateDraft,
    view,
  } = useSaviaRequestWorkspace();
  const [tab, setTab] = useState<WorkspaceTab>("steps");
  const [editor, setEditor] = useState<EditorPane>("body");
  const destinationLabel = flow ? requestDestinationLabel(flow) : "proveedor";
  const sessionGeneration = useSessionGeneration();
  const flowId = active && view === "flow" ? flow?.id : undefined;
  const flowScope = useMemo(
    () => ({ api, flowId, sessionGeneration }),
    [api, flowId, sessionGeneration],
  );
  const location = useLocation();
  const creationScope = useMemo(
    () => ({ flowScope, location }),
    [flowScope, location],
  );
  const [creation, setCreation] = useState<{
    scope: typeof creationScope;
    draft: RequestFlow;
    error?: string;
  }>();
  const currentCreation =
    creation?.scope === creationScope ? creation : undefined;
  const creatingFlow = Boolean(
    currentCreation && currentCreation.error === undefined,
  );
  const [liveScope, setLiveScope] = useState<typeof flowScope | null>(null);
  const effectiveMode =
    flowId === "dane-city-lookup" || liveScope === flowScope ? "live" : "mock";
  const [operationInput, setOperationInput] = useState<{
    scope: typeof flowScope;
    text: string;
  }>();
  const [inputRevision, setInputRevision] = useState(0);
  const input =
    operationInput?.scope === flowScope
      ? operationInput.text
      : displayInput(flow?.input ?? {});
  const currentFlowScope = useRef<typeof flowScope | null>(null);
  const historyRequest = useRef(0);
  const [history, setHistory] = useState<{
    scope: typeof flowScope;
    runs: RequestRun[];
  }>();
  const [selectedRun, setSelectedRun] = useState<{
    scope: typeof flowScope;
    run: RequestRun;
  }>();
  const runs = history?.scope === flowScope ? history.runs : [];
  const activeRun = selectedRun?.scope === flowScope ? selectedRun.run : null;
  const [notice, setNotice] = useState("");
  const [submission, setSubmission] = useState<{
    scope: typeof flowScope;
  } | null>(null);
  const submitting = submission?.scope === flowScope;
  const { deletion, confirmDeletion, closeDeletion } = useDeleteConfirmation(
    api,
    active && view === "flow",
    flow,
  );

  useLayoutEffect(() => {
    currentFlowScope.current = flowScope;
    setOperationInput(undefined);
    return () => {
      currentFlowScope.current = null;
      historyRequest.current += 1;
    };
  }, [flowScope]);

  const isCurrentFlowScope = useCallback(
    () =>
      currentFlowScope.current === flowScope &&
      flowScope.sessionGeneration === getSessionGeneration(),
    [flowScope],
  );

  const setInput = useCallback(
    (text: string) => {
      if (isCurrentFlowScope()) setOperationInput({ scope: flowScope, text });
    },
    [flowScope, isCurrentFlowScope],
  );

  const restoreOperationInput = () => {
    if (!isCurrentFlowScope()) return;
    setOperationInput(undefined);
    // Reset the editor immediately so its typing delay cannot lag behind the run payload.
    setInputRevision((current) => current + 1);
  };

  const setMode = (mode: RequestRun["mode"]) => {
    if (isCurrentFlowScope()) setLiveScope(mode === "live" ? flowScope : null);
  };

  const readStoredVariable = useCallback(
    async (key: string) => {
      if (!flowScope.flowId || !isCurrentFlowScope()) return;
      const { value } = await flowScope.api.revealVariable(
        flowScope.flowId,
        key,
      );
      if (isCurrentFlowScope()) return value;
    },
    [flowScope, isCurrentFlowScope],
  );

  const refreshRuns = useCallback(async () => {
    if (!flowScope.flowId || !isCurrentFlowScope()) return;
    const request = ++historyRequest.current;
    const isCurrent = () =>
      isCurrentFlowScope() && request === historyRequest.current;
    try {
      const nextRuns = await flowScope.api.listRuns(flowScope.flowId);
      if (isCurrent()) setHistory({ scope: flowScope, runs: nextRuns });
    } catch (cause) {
      if (!isCurrent()) return;
      if (isReadAccessDenied(cause)) {
        setHistory(undefined);
        setSelectedRun(undefined);
      }
      throw cause;
    }
  }, [isCurrentFlowScope, flowScope]);

  useEffect(() => {
    void refreshRuns().catch(() => undefined);
  }, [refreshRuns]);

  const remote = useRealtimeRefresh({
    topics: ["integrations"],
    tenantId: scope ? Number(scope.replace(/^tenant:/, "")) : 0,
    refreshScope: JSON.stringify([sessionGeneration, flowId]),
    blocked: dirty || busy || submitting || creatingFlow || Boolean(deletion),
    accepts: (event) =>
      !event.collection || event.collection === "savia-request",
    refresh: async () => {
      await refreshNavigation();
      if (flowId && isCurrentFlowScope()) {
        await reloadFlow();
        await refreshRuns();
      }
    },
  });
  const working = busy || submitting || creatingFlow;
  const step = flow?.steps[stepIndex] ?? flow?.steps[0];
  const variableNames = useMemo(
    () =>
      [
        ...(flow?.variables.map((variable) => variable.key) ?? []),
        ...Object.keys(flow?.input ?? {}),
        ...(flow?.steps.flatMap((candidate) =>
          [candidate.pre, candidate.post].flatMap((script) =>
            [...script.matchAll(/bru\.setVar\(\s*['"]([^'"]+)['"]/g)].map(
              (match) => match[1] ?? "",
            ),
          ),
        ) ?? []),
      ]
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .sort(),
    [flow],
  );

  const updateStep = (patch: Partial<RequestStep>) => {
    if (!flow || !step) return;
    updateDraft({
      ...flow,
      steps: flow.steps.map((candidate, index) =>
        index === stepIndex ? { ...candidate, ...patch } : candidate,
      ),
    });
  };
  const updateVariable = (index: number, patch: Partial<RequestVariable>) => {
    const variable = flow?.variables[index];
    if (!flow || !variable) return;
    const next = {
      ...variable,
      ...patch,
      draft: variable.draft ?? {
        id: `stored:${variable.key}`,
        originalKey: variable.key,
        originalSecretConfigured: Boolean(
          variable.secret && variable.configured,
        ),
      },
    };
    updateDraft({
      ...flow,
      variables: flow.variables.map((candidate, currentIndex) =>
        currentIndex === index ? next : candidate,
      ),
    });
    return next;
  };
  const saveCurrentDraft = async () =>
    (await saveDraft()) && isCurrentFlowScope();
  const withSubmission = async (work: () => Promise<void>) => {
    if (!isCurrentFlowScope()) return;
    const action = { scope: flowScope };
    setSubmission(action);
    setNotice("");
    try {
      await work();
    } catch (exception) {
      if (isCurrentFlowScope())
        setNotice(
          exception instanceof Error
            ? exception.message
            : "No pudimos completar la operación.",
        );
    } finally {
      setSubmission((current) => (current === action ? null : current));
    }
  };
  const run = () =>
    withSubmission(async () => {
      if (!flow) return;
      const runInput = executionInput(input);
      const newKeys = Object.keys(runInput).filter(
        (key) => !Object.hasOwn(flow.input, key),
      );
      if (newKeys.length > 0)
        throw new Error(
          `Guarda las claves nuevas antes de ejecutar (${newKeys.join(", ")}).`,
        );
      if (!(await saveCurrentDraft())) return;
      const result = await api.run(flow.id, effectiveMode, runInput);
      if (!isCurrentFlowScope()) return;
      setSelectedRun({ scope: flowScope, run: result });
      await refreshRuns();
      if (!isCurrentFlowScope()) return;
      setTab("run");
      setNotice(
        result.status === "success"
          ? effectiveMode === "mock"
            ? "Simulación completada. No se contactó al proveedor."
            : "El proveedor respondió. Revisa el resultado JSON."
          : (result.error ?? "No se completó el flow."),
      );
    });
  const publish = () =>
    withSubmission(async () => {
      if (!flow || !(await saveCurrentDraft())) return;
      await api.publish(flow.id);
      setNotice("Versión publicada.");
    });
  const createFlow = async () => {
    if (!active || working || !isCurrentFlowScope()) return;
    const draft = currentCreation?.draft ?? emptyFlow();
    const attempt = { scope: creationScope, draft };
    setCreation(attempt);
    try {
      if (!(await createAndSelectFlow(draft, Boolean(currentCreation))))
        setCreation((current) => (current === attempt ? undefined : current));
    } catch (cause) {
      setCreation((current) =>
        current === attempt
          ? {
              ...attempt,
              error:
                cause instanceof Error
                  ? cause.message
                  : "No pudimos crear el flow.",
            }
          : current,
      );
    }
  };
  const duplicateFlow = () =>
    withSubmission(async () => {
      if (flow) await duplicateAndSelectFlow(flow.id);
    });
  const removeFlow = () => {
    if (!flow) return;
    confirmDeletion({
      title: "Eliminar flow",
      description: `¿Eliminar «${flow.name}» con todos sus pasos?`,
      run: async (isCurrent) => {
        await api.removeFlow(flow.id);
        // The deletion already succeeded. Clear the selection if reloading the list fails.
        const [next] = await refreshNavigation().catch(() => []);
        if (!isCurrent()) return;
        if (next) {
          discardDraft();
          await selectFlow(next.id);
        } else clearSelection();
      },
    });
  };
  const reloadRestoredFlow = async (isCurrent: () => boolean) =>
    isCurrent() &&
    (await reloadFlow({ discardOnFailure: true })) &&
    isCurrent();
  const resetFlow = () => {
    if (!scope || !flow?.hasPlatformDefault) return;
    confirmDeletion({
      title: "Restablecer flow",
      confirmLabel: "Restablecer",
      description: `«${flow.name}» volverá a los valores de plataforma. Los cambios sin guardar se perderán.`,
      run: async (isCurrent) => {
        const { reverted } = await api.resetFlow(flow.id);
        if (!isCurrent()) return;
        restoreOperationInput();
        if (await reloadRestoredFlow(isCurrent))
          setNotice(
            reverted
              ? "Flow restablecido a valores de plataforma."
              : "El flow ya usaba los valores de plataforma.",
          );
      },
    });
  };
  const resetVariable = (index: number) =>
    withSubmission(async () => {
      if (!flow) return;
      const variable = flow.variables[index];
      if (
        !scope ||
        !variable?.overridden ||
        !variable.hasPlatformDefault ||
        hasRenamedVariableKey(variable)
      )
        return;
      if (!(await saveCurrentDraft())) return;
      const result = await api.resetVariable(flow.id, variable.key);
      if (await reloadRestoredFlow(isCurrentFlowScope))
        setNotice(
          result.reverted
            ? `«${variable.key}» volvió al valor de plataforma.`
            : `«${variable.key}» ya usaba el valor de plataforma.`,
        );
    });

  if (view === "secretos") {
    return (
      <main className="mx-auto w-full max-w-6xl pb-10">
        <div className="pt-6">
          <SaviaRequestScopeBar />
          <RemoteChangesNotice {...remote} />
        </div>
        <SecretsScreen />
      </main>
    );
  }

  if (!flow) {
    const creationError = currentCreation?.error;
    const formError = error ?? creationError;
    const createLabel = creatingFlow
      ? "Creando flow…"
      : creationError
        ? "Reintentar creación"
        : "Crear flow";
    return (
      <main className="mx-auto w-full max-w-6xl pb-10">
        <div className="pt-6">
          <SaviaRequestScopeBar />
          <RemoteChangesNotice {...remote} />
        </div>
        <header className="py-6">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Workflow className="size-4" aria-hidden="true" />
            Administración
          </div>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            Savia request
          </h1>
        </header>
        {routeLoading ? (
          <RouteLoading label="Cargando flows…" />
        ) : (
          <Card>
            <CardContent className="flex flex-col items-center px-6 py-16 text-center">
              <div className="flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Workflow className="size-6" aria-hidden="true" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold">
                {error
                  ? "No pudimos cargar Savia Request"
                  : "No hay flows todavía"}
              </h2>
              {formError ? (
                <p
                  className="mt-2 max-w-md text-sm text-destructive"
                  role="alert"
                >
                  {formError}
                </p>
              ) : (
                <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
                  Crea el primer flow para organizar requests, variables y
                  ejecuciones desde este espacio.
                </p>
              )}
              <Button
                className="mt-6"
                disabled={working}
                onClick={error ? retryRoute : () => void createFlow()}
                type="button"
              >
                {formError ? <RotateCcw /> : <FilePlus2 />}
                {error ? "Reintentar" : createLabel}
              </Button>
            </CardContent>
          </Card>
        )}
      </main>
    );
  }

  const access = {
    read: async (name: string) => {
      const values = executionInput(input);
      if (Object.hasOwn(values, name)) {
        return {
          value: values[name] ?? "",
          editable: true,
          note: "Entrada del request",
        };
      }
      const variable = flow.variables.find(
        (candidate) => candidate.key === name,
      );
      if (!variable) {
        return {
          value: "",
          editable: false,
          note: "Se calcula durante la ejecución del request.",
        };
      }
      const value =
        variable.secret &&
        variable.configured &&
        !variable.value &&
        !hasRenamedVariableKey(variable)
          ? await readStoredVariable(name)
          : variable.value;
      return {
        value: value ?? "",
        editable: value !== undefined,
        note: variable.secret ? "Variable secreta" : "Variable del flow",
      };
    },
    write: (name: string, value: string) => {
      const values = executionInput(input);
      if (Object.hasOwn(values, name)) {
        setInput(displayInput({ ...values, [name]: value }));
        return;
      }
      const index = flow.variables.findIndex(
        (variable) => variable.key === name,
      );
      if (index >= 0) updateVariable(index, { value });
    },
  };

  return (
    <VariableAccessContext.Provider value={access}>
      <VariableNames.Provider value={variableNames}>
        <main className="mx-auto w-full max-w-6xl pb-10">
          <div className="pt-6">
            <SaviaRequestScopeBar />
            <RemoteChangesNotice {...remote} />
          </div>
          <header className="py-6">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Workflow className="size-4" aria-hidden="true" />
              {flow.provider ?? "Savia request"}
              {scope && flow.customized ? (
                <span className="rounded-full border px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  Personalizado
                </span>
              ) : null}
            </div>
            <div className="mt-2 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0">
                <h1 className="truncate text-3xl font-semibold tracking-tight">
                  {flow.name}
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor="workspace-flow-selector">
                  Flow activo
                </label>
                <select
                  className="h-9 min-w-48 rounded-md border bg-background px-3 text-sm"
                  disabled={working}
                  id="workspace-flow-selector"
                  onChange={(event) => void selectFlow(event.target.value)}
                  value={flow.id}
                >
                  {flows.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={working}
                  onClick={duplicateFlow}
                  type="button"
                  variant="outline"
                >
                  <Copy /> Duplicar
                </Button>
                <Button
                  disabled={working}
                  onClick={removeFlow}
                  type="button"
                  variant="outline"
                >
                  <Trash2 /> Eliminar
                </Button>
                {scope && flow.hasPlatformDefault ? (
                  <Button
                    disabled={working}
                    onClick={resetFlow}
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw /> Restablecer
                  </Button>
                ) : null}
              </div>
            </div>
          </header>

          <Card>
            <CardHeader className="flex flex-col gap-4 border-b pb-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm">
                <strong>{flow.steps.length} pasos</strong>
                <span className="text-muted-foreground">
                  {dirty ? " · Cambios sin guardar" : " · Guardado"}
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Modo de ejecución"
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  disabled={working}
                  onChange={(event) =>
                    setMode(event.target.value as "mock" | "live")
                  }
                  value={effectiveMode}
                >
                  <option
                    value="mock"
                    disabled={flow.id === "dane-city-lookup"}
                  >
                    Simulado
                  </option>
                  <option value="live">Real · {destinationLabel}</option>
                </select>
                <Button disabled={working} onClick={run} type="button">
                  <Play />
                  {working
                    ? "Ejecutando…"
                    : effectiveMode === "mock"
                      ? "Ejecutar simulación"
                      : "Ejecutar real"}
                </Button>
              </div>
            </CardHeader>

            <CardContent className="space-y-5 pt-6">
              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-1.5 text-sm font-medium">
                  Nombre del flow
                  <Input
                    aria-label="Nombre del flow"
                    disabled={working}
                    onChange={(event) =>
                      updateDraft({ ...flow, name: event.target.value })
                    }
                    value={flow.name}
                  />
                </label>
                <label className="grid gap-1.5 text-sm font-medium">
                  Carpeta
                  <Input
                    disabled={working}
                    list="savia-request-folders"
                    onChange={(event) =>
                      updateDraft({ ...flow, folderPath: event.target.value })
                    }
                    value={flow.folderPath ?? ""}
                  />
                  <datalist id="savia-request-folders">
                    {[
                      ...new Set([
                        ...folders,
                        ...flows.map((candidate) => candidate.folderPath ?? ""),
                      ]),
                    ]
                      .filter(Boolean)
                      .map((path) => (
                        <option key={path} value={path} />
                      ))}
                  </datalist>
                </label>
              </div>

              <div className="flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
                <div
                  className="flex flex-wrap gap-1"
                  role="tablist"
                  aria-label="Editor de flow"
                >
                  {(
                    [
                      ["steps", "Pasos", Settings2],
                      ["variables", "Variables", SlidersHorizontal],
                      ["run", "Ejecutar", Play],
                      ["history", "Historial", History],
                    ] as const
                  ).map(([id, label, Icon]) => (
                    <Button
                      aria-selected={tab === id}
                      key={id}
                      onClick={() => setTab(id)}
                      role="tab"
                      size="sm"
                      type="button"
                      variant={tab === id ? "secondary" : "ghost"}
                    >
                      <Icon /> {label}
                      {id === "steps" ? ` ${flow.steps.length}` : ""}
                    </Button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    disabled={working}
                    onClick={() =>
                      void withSubmission(async () => {
                        updateDraft({ ...flow, input: executionInput(input) });
                        if (await saveCurrentDraft())
                          setNotice("Cambios guardados.");
                      })
                    }
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Save /> Guardar
                  </Button>
                  <Button
                    disabled={working}
                    onClick={publish}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    Publicar versión
                  </Button>
                </div>
              </div>

              {notice ? (
                <p
                  className="rounded-md bg-primary/8 px-3 py-2 text-sm text-primary"
                  role="status"
                >
                  {notice}
                </p>
              ) : null}
              {error ? (
                <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm">
                  <p className="text-destructive" role="alert">
                    {error}
                  </p>
                  {routeReadError ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        disabled={working}
                        onClick={retryRoute}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <RotateCcw /> Reintentar selección
                      </Button>
                      <Button
                        disabled={working}
                        onClick={() => void selectFlow(flow.id, stepIndex)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Volver al flow actual
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {tab === "steps" && step ? (
                <StepsEditor
                  editor={editor}
                  flow={flow}
                  onDelete={() =>
                    confirmDeletion({
                      title: "Eliminar paso",
                      description: `¿Eliminar «${step.name}» de la secuencia?`,
                      run: () =>
                        (() => {
                          const steps = flow.steps.filter(
                            (_, index) => index !== stepIndex,
                          );
                          updateDraft({ ...flow, steps });
                          void selectFlow(
                            flow.id,
                            Math.min(stepIndex, steps.length - 1),
                          );
                        })(),
                    })
                  }
                  onAppendStep={() => {
                    const steps = [...flow.steps, emptyStep()];
                    updateDraft({ ...flow, steps });
                    void selectFlow(flow.id, steps.length - 1);
                  }}
                  onEditorChange={setEditor}
                  onReplaceSteps={(steps) => updateDraft({ ...flow, steps })}
                  onSelectStep={(index) => void selectFlow(flow.id, index)}
                  onUpdate={updateStep}
                  selectedIndex={stepIndex}
                  working={working}
                />
              ) : null}

              {tab === "variables" ? (
                <VariablesEditor
                  flow={flow}
                  allowReset={Boolean(scope)}
                  readStoredValue={readStoredVariable}
                  onReset={(index) => {
                    void resetVariable(index);
                  }}
                  onRemove={(index) =>
                    confirmDeletion({
                      title: "Eliminar variable",
                      description: "La variable se retirará del borrador.",
                      run: () =>
                        updateDraft({
                          ...flow,
                          variables: flow.variables.filter(
                            (_, current) => current !== index,
                          ),
                        }),
                    })
                  }
                  onAdd={() =>
                    updateDraft({
                      ...flow,
                      variables: [
                        ...flow.variables,
                        {
                          key: "",
                          value: "",
                          secret: false,
                          draft: { id: `new:${crypto.randomUUID()}` },
                        },
                      ],
                    })
                  }
                  onUpdate={updateVariable}
                  working={working}
                />
              ) : null}

              {tab === "run" ? (
                <RunPanel
                  activeRun={activeRun}
                  flow={flow}
                  input={input}
                  inputRevision={inputRevision}
                  key={JSON.stringify([sessionGeneration, scope, flow.id])}
                  mode={effectiveMode}
                  onInputChange={setInput}
                  onModeChange={setMode}
                  onRestoreInput={restoreOperationInput}
                  onRun={run}
                  readStandardResult={services.requestResults.read.bind(
                    services.requestResults,
                  )}
                  working={working}
                />
              ) : null}

              {tab === "history" ? (
                <HistoryPanel
                  onRefresh={() => void withSubmission(refreshRuns)}
                  onSelect={(run) => {
                    setSelectedRun({ scope: flowScope, run });
                    setTab("run");
                  }}
                  runs={runs}
                  working={working}
                />
              ) : null}
              {deletion ? (
                <DeleteDialog action={deletion} onClose={closeDeletion} />
              ) : null}
            </CardContent>
          </Card>
        </main>
      </VariableNames.Provider>
    </VariableAccessContext.Provider>
  );
}

function StepsEditor({
  flow,
  selectedIndex,
  editor,
  working,
  onSelectStep,
  onEditorChange,
  onReplaceSteps,
  onAppendStep,
  onUpdate,
  onDelete,
}: {
  flow: RequestFlow;
  selectedIndex: number;
  editor: EditorPane;
  working: boolean;
  onSelectStep(index: number): void;
  onEditorChange(value: EditorPane): void;
  onReplaceSteps(steps: RequestStep[]): void;
  onAppendStep(): void;
  onUpdate(patch: Partial<RequestStep>): void;
  onDelete(): void;
}) {
  const step = flow.steps[selectedIndex];
  if (!step) return null;
  const move = (direction: number) => {
    const nextIndex = selectedIndex + direction;
    if (nextIndex < 0 || nextIndex >= flow.steps.length) return;
    const steps = [...flow.steps];
    [steps[selectedIndex], steps[nextIndex]] = [
      steps[nextIndex]!,
      steps[selectedIndex]!,
    ];
    onReplaceSteps(steps);
    onSelectStep(nextIndex);
  };
  const applyBodyType = (bodyType: string) =>
    onUpdate({
      bodyType,
      body: bodyType === "json" && !step.body ? "{}" : step.body,
      headers: {
        ...step.headers,
        "content-type":
          bodyType === "json"
            ? "application/json"
            : bodyType === "xml"
              ? "text/xml; charset=utf-8"
              : "text/plain",
      },
    });
  return (
    <div className="grid min-h-0 gap-5 lg:grid-cols-[minmax(14rem,0.75fr)_minmax(0,1.45fr)]">
      <aside className="min-h-0 rounded-lg border bg-muted/15 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Secuencia de requests</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {flow.steps.length} request(s) en orden.
            </p>
          </div>
          <Button
            disabled={working}
            onClick={onAppendStep}
            size="icon"
            type="button"
            variant="ghost"
            aria-label="Agregar paso"
          >
            <Plus />
          </Button>
        </div>
        <div className="mt-3 space-y-1.5">
          {flow.steps.map((candidate, index) => (
            <Button
              className="h-auto w-full justify-start py-2 text-left"
              key={candidate.id}
              onClick={() => onSelectStep(index)}
              type="button"
              variant={index === selectedIndex ? "secondary" : "ghost"}
            >
              <span className="mr-1 text-xs tabular-nums text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block truncate">{candidate.name}</strong>
                <small className="block truncate text-muted-foreground">
                  {candidate.method} · {candidate.bodyType ?? "xml"}
                </small>
              </span>
            </Button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <label className="grid min-w-0 flex-1 gap-1.5 text-sm font-medium">
            Nombre del paso
            <Input
              disabled={working}
              onChange={(event) => onUpdate({ name: event.target.value })}
              value={step.name}
            />
          </label>
          <div className="flex gap-1">
            <Button
              aria-label="Subir paso"
              disabled={working || selectedIndex === 0}
              onClick={() => move(-1)}
              size="icon"
              type="button"
              variant="outline"
            >
              <ArrowUp />
            </Button>
            <Button
              aria-label="Bajar paso"
              disabled={working || selectedIndex === flow.steps.length - 1}
              onClick={() => move(1)}
              size="icon"
              type="button"
              variant="outline"
            >
              <ArrowDown />
            </Button>
            <Button
              disabled={working || flow.steps.length === 1}
              onClick={onDelete}
              type="button"
              variant="outline"
            >
              <Trash2 /> Eliminar
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm font-medium">
            Método
            <select
              className="h-9 rounded-md border bg-background px-3"
              disabled={working}
              onChange={(event) => onUpdate({ method: event.target.value })}
              value={step.method}
            >
              {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].map(
                (method) => (
                  <option key={method}>{method}</option>
                ),
              )}
            </select>
          </label>
          <label className="grid gap-1.5 text-sm font-medium">
            Tipo de body
            <select
              className="h-9 rounded-md border bg-background px-3"
              disabled={working}
              onChange={(event) => applyBodyType(event.target.value)}
              value={step.bodyType ?? "xml"}
            >
              {["none", "json", "xml", "text"].map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="mt-4 grid gap-1.5 text-sm font-medium">
          Endpoint
          <VariableInput
            aria-label="Endpoint"
            disabled={working}
            onChange={(value) => onUpdate({ url: value })}
            value={step.url}
          />
        </label>
        <div
          className="mt-4 flex flex-wrap gap-1"
          role="tablist"
          aria-label="Editor de request"
        >
          {(["body", "headers", "pre", "post"] as const).map((pane) => (
            <Button
              aria-selected={editor === pane}
              key={pane}
              onClick={() => onEditorChange(pane)}
              role="tab"
              size="sm"
              type="button"
              variant={editor === pane ? "secondary" : "ghost"}
            >
              {pane === "body"
                ? "Body"
                : pane === "headers"
                  ? "Headers / Auth"
                  : pane === "pre"
                    ? "Pre-request JS"
                    : "Post-response JS"}
            </Button>
          ))}
        </div>
        <div className="mt-3">
          {editor === "headers" ? (
            <HeadersEditor step={step} onUpdate={onUpdate} working={working} />
          ) : (
            <CodeEditor
              label={
                editor === "body" ? "Body del request" : "Script JavaScript"
              }
              language={editor === "body" ? bodyLanguage(step) : "javascript"}
              onChange={(value) => onUpdate({ [editor]: value })}
              readOnly={working}
              value={step[editor]}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HeadersEditor({
  step,
  working,
  onUpdate,
}: {
  step: RequestStep;
  working: boolean;
  onUpdate(patch: Partial<RequestStep>): void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  return (
    <div className="space-y-3 rounded-md border bg-muted/15 p-3">
      <fieldset className="grid gap-2 rounded-md border bg-background/70 p-3">
        <legend className="px-1 text-sm font-medium">Autenticación</legend>
        <label className="grid gap-1.5 text-sm font-medium">
          Tipo de autenticación
          <select
            aria-label="Autenticación"
            className="h-9 rounded-md border bg-background px-3"
            disabled={working}
            onChange={(event) =>
              onUpdate({
                auth:
                  event.target.value === "basic"
                    ? (step.auth ?? { username: "", password: "" })
                    : undefined,
              })
            }
            value={step.auth ? "basic" : "none"}
          >
            <option value="none">Sin Basic (Bearer en headers)</option>
            <option value="basic">Basic Auth</option>
          </select>
        </label>
        {step.auth ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="grid gap-1.5 text-sm font-medium">
              Usuario (variable)
              <VariableInput
                aria-label="Usuario (variable)"
                disabled={working}
                onChange={(username) =>
                  onUpdate({ auth: { ...step.auth!, username } })
                }
                value={step.auth.username}
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              Contraseña (variable)
              <VariableInput
                aria-label="Contraseña (variable)"
                disabled={working}
                onChange={(password) =>
                  onUpdate({ auth: { ...step.auth!, password } })
                }
                value={step.auth.password}
              />
            </label>
          </div>
        ) : null}
      </fieldset>
      {Object.entries(step.headers).map(([key, headerValue]) => (
        <div
          className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
          key={key}
        >
          <Input
            aria-label={key}
            disabled={working}
            onChange={(event) =>
              onUpdate({
                headers: Object.fromEntries(
                  Object.entries(step.headers).map(([candidate, value]) =>
                    candidate === key
                      ? [event.target.value, value]
                      : [candidate, value],
                  ),
                ),
              })
            }
            value={key}
          />
          <VariableInput
            aria-label={`Valor de ${key}`}
            disabled={working}
            onChange={(next) =>
              onUpdate({ headers: { ...step.headers, [key]: next } })
            }
            value={headerValue}
          />
          <Button
            aria-label={`Eliminar ${key}`}
            disabled={working}
            onClick={() =>
              onUpdate({
                headers: Object.fromEntries(
                  Object.entries(step.headers).filter(
                    ([candidate]) => candidate !== key,
                  ),
                ),
              })
            }
            size="icon"
            type="button"
            variant="ghost"
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <form
        className="grid gap-2 sm:grid-cols-[10rem_minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          onUpdate({ headers: { ...step.headers, [name.trim()]: value } });
          setName("");
          setValue("");
        }}
      >
        <Input
          aria-label="Nuevo header"
          disabled={working}
          onChange={(event) => setName(event.target.value)}
          placeholder="Header"
          value={name}
        />
        <Input
          aria-label="Valor del nuevo header"
          disabled={working}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Valor / {{variable}}"
          value={value}
        />
        <Button disabled={working} type="submit" variant="outline">
          Agregar
        </Button>
      </form>
    </div>
  );
}

function VariablesEditor({
  flow,
  working,
  allowReset,
  onUpdate,
  onRemove,
  readStoredValue,
  onReset,
  onAdd,
}: {
  flow: RequestFlow;
  working: boolean;
  allowReset: boolean;
  onUpdate(
    index: number,
    patch: Partial<RequestVariable>,
  ): RequestVariable | undefined;
  onRemove(index: number): void;
  readStoredValue(key: string): Promise<string | undefined>;
  onReset(index: number): void;
  onAdd(): void;
}) {
  return (
    <section className="rounded-lg border p-4">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-base font-semibold">Variables del flow</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Un secreto vacío conserva su valor guardado.
            {allowReset &&
            flow.variables.some(
              (variable) =>
                variable.overridden &&
                variable.hasPlatformDefault &&
                !hasRenamedVariableKey(variable),
            )
              ? " Restablecer devuelve una variable al valor de plataforma."
              : null}
          </p>
        </div>
        <Button
          disabled={working}
          onClick={onAdd}
          type="button"
          variant="outline"
        >
          <Plus /> Agregar variable
        </Button>
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-160 text-sm">
          <thead className="border-b text-left text-muted-foreground">
            <tr>
              <th className="pb-2 pr-3 font-medium">Clave</th>
              <th className="pb-2 pr-3 font-medium">Valor</th>
              <th className="pb-2 pr-3 font-medium">Secreto</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {flow.variables.map((variable, index) => (
              <tr
                className="border-b last:border-0"
                key={variable.draft?.id ?? `stored:${variable.key}`}
              >
                <td className="py-2 pr-3">
                  <Input
                    aria-label={`Clave ${index + 1}`}
                    disabled={working}
                    onChange={(event) =>
                      onUpdate(index, { key: event.target.value })
                    }
                    value={variable.key}
                  />
                </td>
                <td className="py-2 pr-3">
                  <VariableValueInput
                    disabled={working}
                    onChange={(value) => onUpdate(index, { value })}
                    readStoredValue={readStoredValue}
                    variable={variable}
                  />
                </td>
                <td className="py-2 pr-3">
                  <input
                    aria-label={`Secreto ${variable.key}`}
                    checked={variable.secret}
                    disabled={working}
                    onChange={(event) =>
                      onUpdate(index, { secret: event.target.checked })
                    }
                    type="checkbox"
                  />
                </td>
                <td className="py-2">
                  <span className="flex gap-1">
                    {allowReset &&
                    variable.overridden &&
                    variable.hasPlatformDefault &&
                    !hasRenamedVariableKey(variable) ? (
                      <Button
                        aria-label={`Restablecer ${variable.key}`}
                        disabled={working}
                        onClick={() => onReset(index)}
                        size="icon"
                        title="Volver al valor de plataforma"
                        type="button"
                        variant="ghost"
                      >
                        <RotateCcw />
                      </Button>
                    ) : null}
                    <Button
                      aria-label={`Eliminar ${variable.key}`}
                      disabled={working}
                      onClick={() => onRemove(index)}
                      size="icon"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 />
                    </Button>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VariableValueInput({
  variable,
  disabled,
  onChange,
  readStoredValue,
}: {
  variable: RequestVariable;
  disabled: boolean;
  onChange(value: string): RequestVariable | undefined;
  readStoredValue(key: string): Promise<string | undefined>;
}) {
  // A stored secret belongs to this field until an explicit edit updates the draft.
  const [preview, setPreview] = useState<{
    variable: RequestVariable;
    read: typeof readStoredValue;
    status: "loading" | "visible" | "error";
    value?: string;
  }>();
  const current =
    preview?.variable === variable && preview.read === readStoredValue
      ? preview
      : undefined;
  const pending = useRef<symbol | null>(null);

  useLayoutEffect(() => {
    setPreview((previous) =>
      previous?.variable === variable && previous.read === readStoredValue
        ? previous
        : undefined,
    );
    return () => {
      pending.current = null;
    };
  }, [variable, readStoredValue]);

  const visible = current?.status === "visible";
  const loading = current?.status === "loading";
  const configuredForKey =
    variable.configured && !hasRenamedVariableKey(variable);
  const toggle = async () => {
    if (visible) {
      setPreview(undefined);
      return;
    }
    const source = { variable, read: readStoredValue };
    if (!configuredForKey || variable.value) {
      setPreview({ ...source, status: "visible" });
      return;
    }
    const request = Symbol();
    pending.current = request;
    setPreview({ ...source, status: "loading" });
    try {
      const value = await readStoredValue(variable.key);
      if (pending.current === request) {
        setPreview(
          value === undefined
            ? undefined
            : { ...source, status: "visible", value },
        );
      }
    } catch {
      if (pending.current === request)
        setPreview({ ...source, status: "error" });
    }
  };

  return (
    <>
      <div className="flex min-w-56 gap-2">
        <Input
          aria-label={`Valor de ${variable.key}`}
          autoComplete="off"
          disabled={disabled}
          onChange={(event) => {
            const next = onChange(event.target.value);
            setPreview(
              visible && next
                ? { variable: next, read: readStoredValue, status: "visible" }
                : undefined,
            );
          }}
          placeholder={
            configuredForKey && variable.secret
              ? "•••••••• · guardado"
              : "Escribe un valor"
          }
          type={variable.secret && !visible ? "password" : "text"}
          value={current?.value ?? variable.value}
        />
        {variable.secret ? (
          <Button
            disabled={disabled || loading}
            onClick={() => void toggle()}
            size="sm"
            type="button"
            variant="outline"
          >
            {visible ? "Ocultar" : loading ? "Mostrando…" : "Mostrar"}
          </Button>
        ) : null}
      </div>
      {current?.status === "error" ? (
        <p className="mt-1 text-sm text-destructive" role="alert">
          No se pudo mostrar el secreto.
        </p>
      ) : null}
    </>
  );
}

function RunPanel({
  flow,
  input,
  inputRevision,
  mode,
  working,
  activeRun,
  onInputChange,
  onModeChange,
  onRestoreInput,
  onRun,
  readStandardResult,
}: {
  flow: RequestFlow;
  input: string;
  inputRevision: number;
  mode: "mock" | "live";
  working: boolean;
  activeRun: RequestRun | null;
  onInputChange(value: string): void;
  onModeChange(mode: "mock" | "live"): void;
  onRestoreInput(): void;
  onRun(): void;
  readStandardResult(flowId: string, runId: string): Promise<RequestResult>;
}) {
  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <section className="rounded-lg border p-4">
        <h2 className="text-base font-semibold">Datos de la operación</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Usa Guardar para conservar estos datos como entrada del flow.
        </p>
        <label className="mt-4 grid gap-1.5 text-sm font-medium">
          Modo de ejecución
          <select
            className="h-9 rounded-md border bg-background px-3"
            disabled={working}
            onChange={(event) =>
              onModeChange(event.target.value as "mock" | "live")
            }
            value={mode}
          >
            <option value="mock" disabled={flow.id === "dane-city-lookup"}>
              Simulado · sin llamadas externas
            </option>
            <option value="live">
              {requestDestinationLabel(flow)} real · ejecuta requests
            </option>
          </select>
        </label>
        <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {mode === "mock"
            ? "El simulador usa respuestas de demostración; no contacta al proveedor."
            : `Se enviarán estos datos a ${requestDestinationLabel(flow)} sin reintentos.`}
        </p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-sm font-medium">Entrada JSON</span>
          <Button
            disabled={working}
            onClick={onRestoreInput}
            size="sm"
            type="button"
            variant="outline"
          >
            Restaurar entrada del flow
          </Button>
        </div>
        <div className="mt-2">
          <CodeEditor
            key={inputRevision}
            label="Entrada JSON"
            onChange={onInputChange}
            value={input}
          />
        </div>
        <Button
          className="mt-4 w-full"
          disabled={working}
          onClick={onRun}
          type="button"
        >
          <Play /> {mode === "mock" ? "Ejecutar simulación" : "Ejecutar real"}
        </Button>
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="text-base font-semibold">Resultado de la ejecución</h2>
        {!activeRun ? (
          <div className="flex min-h-72 flex-col items-center justify-center text-center">
            <Workflow className="size-8 text-primary" />
            <h3 className="mt-3 font-semibold">Todo listo para empezar</h3>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Al ejecutar verás el estado de cada request y el resultado final.
            </p>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            <StandardResult
              flowId={activeRun.flowId}
              read={readStandardResult}
              runId={activeRun.id}
            />
            <div className="border-t pt-3">
              <p className="text-sm font-medium">
                {activeRun.status === "success"
                  ? "Completado"
                  : "No completado"}{" "}
                · {activeRun.mode === "mock" ? "Simulación" : "Real"}
              </p>
              {activeRun.steps.map((trace) => (
                <article
                  className="mt-3 rounded-md bg-muted/40 p-3 text-sm"
                  key={`${trace.name}-${trace.durationMs}`}
                >
                  <strong>{trace.name}</strong>
                  <p className="mt-1 text-muted-foreground">
                    {trace.httpStatus ? `HTTP ${trace.httpStatus} · ` : ""}
                    {trace.durationMs} ms
                  </p>
                  {trace.error ? (
                    <p className="mt-1 text-destructive">{trace.error}</p>
                  ) : null}
                  {trace.responseJson !== undefined ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer">
                        Ver respuesta JSON
                      </summary>
                      <pre className="mt-2 overflow-auto rounded bg-background p-2 text-xs">
                        {JSON.stringify(trace.responseJson, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function HistoryPanel({
  runs,
  working,
  onRefresh,
  onSelect,
}: {
  runs: RequestRun[];
  working: boolean;
  onRefresh(): void;
  onSelect(run: RequestRun): void;
}) {
  return (
    <section className="rounded-lg border p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Últimas ejecuciones</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Persistidas para este flow.
          </p>
        </div>
        <Button
          disabled={working}
          onClick={onRefresh}
          size="sm"
          type="button"
          variant="outline"
        >
          Actualizar
        </Button>
      </div>
      {runs.length ? (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-150 text-sm">
            <thead className="border-b text-left text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Fecha</th>
                <th className="pb-2 font-medium">Modo</th>
                <th className="pb-2 font-medium">Estado</th>
                <th className="pb-2 font-medium">Pasos</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr className="border-b last:border-0" key={run.id}>
                  <td className="py-3">
                    {new Date(run.createdAt).toLocaleString("es-CO")}
                  </td>
                  <td className="py-3">
                    {run.mode === "mock" ? "Simulado" : "Real"}
                  </td>
                  <td className="py-3">
                    {run.status === "success" ? "Completado" : "No completado"}
                  </td>
                  <td className="py-3">{run.steps.length}</td>
                  <td className="py-3 text-right">
                    <Button
                      onClick={() => onSelect(run)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Ver resultado
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-8 flex flex-col items-center py-10 text-center">
          <History className="size-7 text-muted-foreground" />
          <h3 className="mt-3 font-semibold">Aún no hay ejecuciones</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Lanza el flow desde la pestaña Ejecutar.
          </p>
        </div>
      )}
    </section>
  );
}

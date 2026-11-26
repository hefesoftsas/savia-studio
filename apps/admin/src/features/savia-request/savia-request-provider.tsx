import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import { useCanAccess } from "ra-core";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiClientError } from "@/api/api-client";
import { useAppServices } from "@/features/assistant/assistant-context";
import {
  createSaviaRequestApi,
  type SaviaRequestApi,
  type SaviaRequestScope,
} from "./savia-request-api";
import {
  clearCachedTenantOptions,
  useSaviaRequestScope,
} from "./savia-request-scope";
import {
  clearAllSaviaRequestSnapshots,
  clearSaviaRequestSnapshot,
  readSaviaRequestSnapshot,
  writeSaviaRequestSnapshot,
} from "./savia-request-cache";
import {
  hasRenamedVariableKey,
  type FlowSummary,
  type RequestFlow,
} from "./types";
import {
  getSessionGeneration,
  useSessionGeneration,
} from "@/auth/session-scope";
import { isReadAccessDenied } from "@/queries/read-state";

type WorkspaceValue = {
  active: boolean;
  view: SaviaRequestView;
  flows: FlowSummary[];
  folders: string[];
  flow: RequestFlow | null;
  stepIndex: number;
  dirty: boolean;
  busy: boolean;
  routeLoading: boolean;
  routeReadError: string | undefined;
  error: string | null;
  api: SaviaRequestApi;
  scope: string | undefined;
  scopeLabel: string;
  scopeReady: boolean;
  canOverrideScope: boolean;
  scopeOptions: string[];
  isPlatformAdmin: boolean;
  applyScopeOverride(scope: string | null): void;
  createAndSelectFlow(
    draft: RequestFlow,
    checkExisting: boolean,
  ): Promise<boolean>;
  duplicateAndSelectFlow(id: string): Promise<void>;
  selectFlow(id: string, stepIndex?: number): Promise<void>;
  reloadFlow(options?: { discardOnFailure?: boolean }): Promise<boolean>;
  retryRoute(): void;
  openSecrets(): void;
  saveDraft(): Promise<boolean>;
  updateDraft(next: RequestFlow): void;
  discardDraft(): void;
  clearSelection(): void;
  refreshNavigation(): Promise<FlowSummary[]>;
};

const SaviaRequestWorkspaceContext = createContext<WorkspaceValue | null>(null);

export type SaviaRequestView = "flow" | "secretos";

function requestedView(search: string): SaviaRequestView {
  return new URLSearchParams(search).get("view") === "secretos"
    ? "secretos"
    : "flow";
}

function requestedStep(search: string): number {
  const value = Number(new URLSearchParams(search).get("step") ?? "0");
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function flowSelection(id: string, step: number) {
  return `/savia-request?flow=${encodeURIComponent(id)}&step=${step}`;
}

function secretsSelection() {
  return "/savia-request?view=secretos";
}

function safeStepIndex(flow: RequestFlow, step: number) {
  return Math.min(Math.max(step, 0), Math.max(flow.steps.length - 1, 0));
}

function readNavigationLists(
  api: SaviaRequestApi,
  onDenied: (cause: unknown) => void,
) {
  const reportFailure = (cause: unknown): never => {
    if (isReadAccessDenied(cause)) onDenied(cause);
    throw cause;
  };
  // Each read can report denied access after the combined read has failed.
  return Promise.all([
    api.listFlows().catch(reportFailure),
    api.listFolders().catch(reportFailure),
  ]);
}

export function SaviaRequestProvider({ children }: PropsWithChildren) {
  const services = useAppServices();
  const principalGeneration = useSessionGeneration();
  const scopeState = useSaviaRequestScope();
  const scope: SaviaRequestScope | undefined = scopeState.scope
    ? { tenant: scopeState.scope }
    : undefined;
  const scopeKey = scopeState.scope ?? "__platform__";
  const api = useMemo(
    () => createSaviaRequestApi(services.apiClient, scope),
    [services.apiClient, scopeState.scope],
  );
  const { canAccess, isPending } = useCanAccess({
    resource: "savia-request",
    action: "list",
  });
  const location = useLocation();
  const navigate = useNavigate();
  const onRoute = location.pathname.startsWith("/savia-request");
  const authorized = Boolean(canAccess) && !isPending && scopeState.ready;
  const active = authorized && onRoute;
  const workspace = useMemo(
    () => ({ api, authorized, principalGeneration }),
    [api, authorized, principalGeneration],
  );
  const view = requestedView(location.search);
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [flow, setFlow] = useState<RequestFlow | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pendingActions, setPendingActions] = useState(0);
  const [routeAttempt, setRouteAttempt] = useState(0);
  const routeReadScope = useMemo(
    () => ({
      workspace,
      active,
      pathname: location.pathname,
      search: location.search,
      key: location.key,
      routeAttempt,
    }),
    [
      workspace,
      active,
      location.pathname,
      location.search,
      location.key,
      routeAttempt,
    ],
  );
  const [routeRead, setRouteRead] = useState<{
    scope: typeof routeReadScope;
    loading: boolean;
    error?: string;
  }>();
  const routeReadError =
    routeRead?.scope === routeReadScope ? routeRead.error : undefined;
  const routeLoading =
    onRoute &&
    (isPending ||
      !scopeState.ready ||
      (active &&
        (routeRead?.scope === routeReadScope ? routeRead.loading : !flow)));
  const busy = pendingActions > 0 || routeLoading;
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<RequestFlow | null>(null);
  const savedVariables = useRef<RequestFlow["variables"] | undefined>(
    undefined,
  );
  const dirtyRef = useRef(false);
  const scopeRef = useRef<string | undefined>(scopeState.scope);
  const requestRef = useRef(0);
  const committedWorkspace = useRef<typeof workspace | null>(null);
  const committedRouteRead = useRef<typeof routeReadScope | null>(null);
  const navigationOrigin = useRef<{ location: typeof location } | null>(null);
  const actionEpoch = useRef(0);
  const identityRef = useRef<string | null>(null);
  const identityGenerationRef = useRef(principalGeneration);
  // Evita revalidar la navegación dos veces seguidas: tras sincronizar la
  // URL el efecto se re-ejecuta y caería en la rama temprana con datos
  // recién revalidados.
  const navRevalidatedAtRef = useRef(0);
  // La revalidación en segundo plano corre una vez por activación
  // (ámbito+URL+vista): los re-renders por cambios de estado no refetchean.
  const revalidatedRef = useRef("");

  useLayoutEffect(() => {
    committedRouteRead.current = routeReadScope;
    return () => {
      committedRouteRead.current = null;
    };
  }, [routeReadScope]);

  useLayoutEffect(() => {
    committedWorkspace.current = workspace;
    setPendingActions(0);
    return () => {
      committedWorkspace.current = null;
      actionEpoch.current += 1;
    };
  }, [workspace]);

  useLayoutEffect(() => {
    navigationOrigin.current = { location };
    return () => {
      navigationOrigin.current = null;
    };
  }, [location]);

  const captureWorkspace = useCallback(() => {
    const epoch = actionEpoch.current;
    return () =>
      workspace.authorized &&
      committedWorkspace.current === workspace &&
      workspace.principalGeneration === getSessionGeneration() &&
      actionEpoch.current === epoch;
  }, [workspace]);

  const beginNavigation = useCallback(() => {
    const isCurrentWorkspace = captureWorkspace();
    if (
      !isCurrentWorkspace() ||
      navigationOrigin.current?.location !== location
    )
      return null;
    // A new navigation action supersedes a selection waiting for a save.
    const origin = { location };
    navigationOrigin.current = origin;
    return () => isCurrentWorkspace() && navigationOrigin.current === origin;
  }, [captureWorkspace, location]);

  const invalidateWorkspaceActions = useCallback(() => {
    actionEpoch.current += 1;
    setPendingActions(0);
  }, []);

  const replaceFlow = useCallback(
    (next: RequestFlow | null, edited = false) => {
      if (!edited) savedVariables.current = next?.variables;
      draftRef.current = next;
      setFlow(next);
    },
    [],
  );

  const clearAfterDeniedRead = useCallback(
    (cause: unknown) => {
      if (!isReadAccessDenied(cause)) return;
      requestRef.current += 1;
      dirtyRef.current = false;
      setDirty(false);
      replaceFlow(null);
      setFlows([]);
      setFolders([]);
      setStepIndex(0);
      clearAllSaviaRequestSnapshots();
      clearCachedTenantOptions();
      invalidateWorkspaceActions();
      if (committedRouteRead.current)
        setRouteRead({ scope: committedRouteRead.current, loading: false });
      setError(
        cause instanceof Error ? cause.message : "No pudimos cargar los flows.",
      );
    },
    [invalidateWorkspaceActions, replaceFlow],
  );

  const persistSnapshot = useCallback(() => {
    writeSaviaRequestSnapshot(scopeState.scope, {
      flows,
      folders,
      flow: draftRef.current,
      stepIndex,
      error,
      updatedAt: Date.now(),
    });
  }, [error, flows, folders, scopeState.scope, stepIndex]);

  // Al salir de la ruta se conserva en memoria; al cambiar de tenant,
  // perder permisos o cerrar sesión se limpia inmediatamente.
  useEffect(() => {
    if (onRoute) return;
    if (!authorized) return;
    persistSnapshot();
  }, [authorized, onRoute, persistSnapshot]);

  // Aislamiento entre usuarios: si cambia la identidad, vacía estado y caché.
  useEffect(() => {
    let active = true;
    if (identityGenerationRef.current !== principalGeneration) {
      identityGenerationRef.current = principalGeneration;
      requestRef.current += 1;
      identityRef.current = null;
      dirtyRef.current = false;
      setDirty(false);
      replaceFlow(null);
      setFlows([]);
      setFolders([]);
      setStepIndex(0);
      setError(null);
      clearAllSaviaRequestSnapshots();
      clearCachedTenantOptions();
    }
    try {
      const session = (
        services as { authSession?: { getIdentity?: () => Promise<unknown> } }
      ).authSession;
      if (!session?.getIdentity) return;
      void session
        .getIdentity()
        .then((identity) => {
          if (!active) return;
          const id = String((identity as { id?: unknown }).id ?? "anon");
          if (identityRef.current === null) {
            identityRef.current = id;
            return;
          }
          if (identityRef.current !== id) {
            identityRef.current = id;
            requestRef.current += 1;
            invalidateWorkspaceActions();
            dirtyRef.current = false;
            setDirty(false);
            replaceFlow(null);
            setFlows([]);
            setFolders([]);
            setStepIndex(0);
            setError(null);
            clearAllSaviaRequestSnapshots();
            clearCachedTenantOptions();
          }
        })
        .catch(() => undefined);
    } catch {
      // Fuera del proveedor de servicios (tests): sin aislamiento por usuario.
    }
    return () => {
      active = false;
    };
  }, [invalidateWorkspaceActions, principalGeneration, replaceFlow, services]);

  const refreshNavigation = useCallback(
    async (confirmedFlow?: RequestFlow) => {
      const isCurrentWorkspace = captureWorkspace();
      if (!isCurrentWorkspace()) return [];
      const readGeneration = requestRef.current;
      const isCurrentRead = () =>
        isCurrentWorkspace() && readGeneration === requestRef.current;
      let denial: unknown;
      try {
        const [nextFlows, nextFolders] = await readNavigationLists(
          api,
          (cause) => {
            if (!isCurrentRead()) return;
            denial = cause;
            clearAfterDeniedRead(cause);
          },
        );
        if (!isCurrentRead()) return [];
        setFlows(nextFlows);
        setFolders(nextFolders);
        return nextFlows;
      } catch (cause) {
        if (denial !== undefined) throw denial;
        if (!isCurrentRead()) return [];
        if (confirmedFlow) {
          if (draftRef.current === confirmedFlow) {
            const { id, name, folderPath, steps, customized } = confirmedFlow;
            const fields = {
              name,
              folderPath,
              steps: steps.map(({ id, name, method }) => ({
                id,
                name,
                method,
              })),
            };
            setFlows((current) =>
              current.map((summary) =>
                summary.id === id
                  ? {
                      ...summary,
                      ...fields,
                      customized: customized ?? summary.customized,
                    }
                  : summary,
              ),
            );
          }
          return [];
        }
        throw cause;
      }
    },
    [api, captureWorkspace, clearAfterDeniedRead],
  );

  const saveDraft = useCallback(async () => {
    const isCurrent = captureWorkspace();
    if (!isCurrent()) return false;
    const draft = draftRef.current;
    if (!draft || !dirtyRef.current) return true;
    if (
      draft.variables.some(
        (variable) =>
          hasRenamedVariableKey(variable) &&
          variable.draft?.originalSecretConfigured &&
          !variable.value,
      )
    ) {
      setError(
        "Escribe un valor para cambiar la clave de un secreto guardado.",
      );
      return false;
    }
    let acknowledged = draft;
    setPendingActions((count) => count + 1);
    setError(null);
    try {
      const variablesChanged = draft.variables !== savedVariables.current;
      let persistedVariables: RequestFlow["variables"] | undefined;
      if (variablesChanged) {
        const saved = await api.saveVariables(draft.id, draft.variables, draft);
        persistedVariables = saved?.variables;
      } else {
        await api.saveFlow(draft);
      }
      // The acknowledgement only covers the draft sent in this request.
      if (!isCurrent() || draftRef.current !== draft) return false;
      let variables = draft.variables;
      if (variablesChanged) {
        variables = (persistedVariables ?? draft.variables).map((row) => {
          const { draft: _draft, ...variable } = row;
          if (hasRenamedVariableKey(row)) {
            delete variable.hasPlatformDefault;
            variable.configured = Boolean(variable.value);
            variable.overridden = Boolean(scopeState.scope);
          }
          if (variable.secret && variable.value) {
            variable.value = "";
            variable.configured = true;
            variable.overridden = Boolean(scopeState.scope);
          }
          return variable;
        });
      }
      const customized = scopeState.scope ? true : draft.customized;
      if (variablesChanged || customized !== draft.customized) {
        acknowledged = { ...draft, variables, customized };
        replaceFlow(acknowledged);
      }
      dirtyRef.current = false;
      setDirty(false);
      await refreshNavigation(acknowledged);
      return (
        isCurrent() && draftRef.current === acknowledged && !dirtyRef.current
      );
    } catch (exception) {
      if (isCurrent() && draftRef.current === acknowledged)
        setError(
          exception instanceof Error
            ? exception.message
            : "No pudimos guardar el flow.",
        );
      return false;
    } finally {
      if (isCurrent()) setPendingActions((count) => count - 1);
    }
  }, [api, captureWorkspace, refreshNavigation, replaceFlow, scopeState.scope]);

  const updateDraft = useCallback(
    (next: RequestFlow) => {
      dirtyRef.current = true;
      setDirty(true);
      replaceFlow(next, true);
    },
    [replaceFlow],
  );

  const discardDraft = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
    replaceFlow(null);
    setStepIndex(0);
  }, [replaceFlow]);

  const clearSelection = useCallback(() => {
    if (!beginNavigation()) return;
    discardDraft();
    navigate("/savia-request", { replace: true });
  }, [beginNavigation, discardDraft, navigate]);

  const createAndSelectFlow = useCallback(
    async (draft: RequestFlow, checkExisting: boolean) => {
      const isCurrent = beginNavigation();
      if (!isCurrent) return false;
      const existing = checkExisting
        ? await api.readFlow(draft.id).catch((cause) => {
            if (cause instanceof ApiClientError && cause.status === 404)
              return null;
            throw cause;
          })
        : null;
      if (!isCurrent()) return false;
      if (!existing) await api.saveFlow(draft);
      if (!isCurrent()) return false;
      navigate(flowSelection(draft.id, 0));
      return true;
    },
    [api, beginNavigation, navigate],
  );

  const duplicateAndSelectFlow = useCallback(
    async (id: string) => {
      const isCurrent = beginNavigation();
      if (!isCurrent || draftRef.current?.id !== id) return;
      if (!(await saveDraft()) || !isCurrent() || draftRef.current?.id !== id)
        return;
      const copy = await api.duplicateFlow(id);
      if (isCurrent()) {
        navigate(flowSelection(copy.id, 0));
      } else {
        await refreshNavigation().catch(() => undefined);
      }
    },
    [api, beginNavigation, navigate, refreshNavigation, saveDraft],
  );

  const selectFlow = useCallback(
    async (id: string, requested = 0) => {
      const isCurrent = beginNavigation();
      if (!isCurrent) return;
      const address = location.pathname + location.search;
      if (id === draftRef.current?.id) {
        const current = draftRef.current;
        const nextStep = safeStepIndex(current, requested);
        const target = flowSelection(id, nextStep);
        if (target === address && nextStep === stepIndex) return;
        setStepIndex(nextStep);
        navigate(target, {
          replace: nextStep === stepIndex && view === "flow",
        });
        return;
      }
      if (!(await saveDraft()) || !isCurrent()) return;
      const target = flowSelection(id, requested);
      navigate(target, { replace: target === address });
    },
    [
      beginNavigation,
      location.pathname,
      location.search,
      navigate,
      saveDraft,
      stepIndex,
      view,
    ],
  );

  const openSecrets = useCallback(() => {
    if (beginNavigation()) navigate(secretsSelection());
  }, [beginNavigation, navigate]);

  const retryRoute = useCallback(() => {
    if (!active) return;
    revalidatedRef.current = "";
    setRouteAttempt((attempt) => attempt + 1);
  }, [active]);

  const reloadFlow = useCallback(
    async (options?: { discardOnFailure?: boolean }) => {
      const isCurrent = captureWorkspace();
      if (!isCurrent()) return false;
      const route = committedRouteRead.current;
      const isCurrentRead = () =>
        isCurrent() && committedRouteRead.current === route;
      const current = draftRef.current;
      if (!current) {
        await refreshNavigation();
        return isCurrentRead() && draftRef.current === null;
      }
      setPendingActions((count) => count + 1);
      setError(null);
      try {
        const fresh = await api.readFlow(current.id);
        // Do not replace a newer draft or a selection made while this read was pending.
        if (!isCurrentRead() || draftRef.current !== current) return false;
        dirtyRef.current = false;
        setDirty(false);
        replaceFlow(fresh);
        setStepIndex((index) => safeStepIndex(fresh, index));
        await refreshNavigation(fresh);
        return isCurrent() && draftRef.current === fresh;
      } catch (exception) {
        if (!isCurrentRead() || draftRef.current?.id !== current.id)
          return false;
        if (isReadAccessDenied(exception)) clearAfterDeniedRead(exception);
        else if (draftRef.current === current) {
          if (options?.discardOnFailure) discardDraft();
          setError(
            exception instanceof Error
              ? exception.message
              : "No pudimos recargar el flow.",
          );
        }
        return false;
      } finally {
        if (isCurrent()) setPendingActions((count) => count - 1);
      }
    },
    [
      api,
      captureWorkspace,
      clearAfterDeniedRead,
      discardDraft,
      refreshNavigation,
      replaceFlow,
    ],
  );

  useEffect(() => {
    if (scopeRef.current === scopeState.scope) return;
    const previous = scopeRef.current;
    scopeRef.current = scopeState.scope;
    // Cambiar de tenant limpia el estado visible y su caché de inmediato;
    // nunca mezcla ámbitos.
    if (previous !== undefined) clearSaviaRequestSnapshot(previous);
    clearSaviaRequestSnapshot(scopeState.scope);
    dirtyRef.current = false;
    setDirty(false);
    navRevalidatedAtRef.current = 0;
    revalidatedRef.current = "";
    replaceFlow(null);
    setFlows([]);
    setFolders([]);
    setStepIndex(0);
    setError(null);
    if (onRoute) navigate("/savia-request", { replace: true });
  }, [navigate, onRoute, replaceFlow, scopeState.scope]);

  // Perder permisos limpia estado y caché de inmediato (no es "salir").
  useEffect(() => {
    if (isPending) return;
    if (canAccess) return;
    dirtyRef.current = false;
    setDirty(false);
    navRevalidatedAtRef.current = 0;
    revalidatedRef.current = "";
    replaceFlow(null);
    setFlows([]);
    setFolders([]);
    setStepIndex(0);
    setError(null);
    clearAllSaviaRequestSnapshots();
    clearCachedTenantOptions();
  }, [canAccess, isPending, replaceFlow]);

  useEffect(() => {
    if (!active) {
      revalidatedRef.current = "";
      return;
    }

    const effectScope = scopeState.scope;
    const effectKey = scopeKey;
    const requestId = ++requestRef.current;
    let cancelled = false;
    const cancelRead = () => {
      cancelled = true;
    };
    const isCurrent = () =>
      !cancelled &&
      committedRouteRead.current === routeReadScope &&
      requestRef.current === requestId &&
      scopeRef.current === effectScope;
    const setRoutePending = (loading: boolean) =>
      setRouteRead({ scope: routeReadScope, loading });
    const finishRouteRead = () =>
      setRouteRead((current) =>
        current?.scope === routeReadScope && current.loading
          ? { ...current, loading: false }
          : current,
      );
    const failRouteRead = (cause: unknown) => {
      clearAfterDeniedRead(cause);
      setRouteRead({
        scope: routeReadScope,
        loading: false,
        error:
          cause instanceof Error
            ? cause.message
            : "No pudimos cargar los flows.",
      });
    };
    const readRouteNavigation = () =>
      readNavigationLists(api, (cause) => {
        if (isCurrent()) failRouteRead(cause);
      });
    const readFolders = () => {
      // A folder response can settle before the flow list or detail.
      void api
        .listFolders()
        .then((nextFolders) => {
          if (isCurrent()) setFolders(nextFolders);
        })
        .catch((cause) => {
          if (isCurrent()) clearAfterDeniedRead(cause);
        });
    };

    const requestedFlowId = new URLSearchParams(location.search).get("flow");
    const step = requestedStep(location.search);
    const returnToDraft = () => {
      const current = draftRef.current;
      if (current)
        navigate(flowSelection(current.id, safeStepIndex(current, stepIndex)), {
          replace: true,
        });
    };

    // Al regresar al mismo ámbito, muestra lo conservado de inmediato.
    // Salir de la ruta conserva el estado visible, así que normalmente ya
    // está en pantalla y solo se revalida en segundo plano. Hidratar desde
    // el snapshot solo si el estado está vacío (p. ej. remontaje).
    const snapshot = readSaviaRequestSnapshot(effectScope);
    const hasSnapshot =
      Boolean(snapshot) &&
      (snapshot!.flows.length > 0 ||
        snapshot!.flow != null ||
        snapshot!.folders.length > 0);
    if (
      hasSnapshot &&
      snapshot &&
      flows.length === 0 &&
      !draftRef.current &&
      !dirtyRef.current
    ) {
      setFlows(snapshot.flows);
      setFolders(snapshot.folders);
      if (
        view === "secretos" ||
        !requestedFlowId ||
        snapshot.flow?.id === requestedFlowId
      ) {
        replaceFlow(snapshot.flow);
        setStepIndex(snapshot.stepIndex);
        if (snapshot.error) setError(snapshot.error);
      }
    }
    const isChangingFlow =
      view === "flow" &&
      requestedFlowId &&
      requestedFlowId !== draftRef.current?.id;
    if (hasSnapshot && snapshot && !isChangingFlow) {
      if (requestedFlowId && requestedFlowId === draftRef.current?.id) {
        setRoutePending(false);
        const nextStep = safeStepIndex(draftRef.current, step);
        setStepIndex(nextStep);
        if (nextStep !== step) {
          navigate(flowSelection(requestedFlowId, nextStep), {
            replace: true,
          });
        }
        // Revalida navegación en segundo plano sin bloquear, salvo que se
        // acabe de revalidar (p. ej. tras sincronizar la URL).
        if (Date.now() - navRevalidatedAtRef.current > 15_000) {
          navRevalidatedAtRef.current = Date.now();
          void (async () => {
            try {
              const [nextFlows, nextFolders] = await readRouteNavigation();
              if (!isCurrent()) return;
              setFlows(nextFlows);
              setFolders(nextFolders);
            } catch {
              // Conserva lo mostrado tras fallos transitorios.
            }
          })();
        }
        return cancelRead;
      }
      // Revalidación en segundo plano: no sustituye el contenido por una
      // pantalla de carga y nunca sobrescribe un borrador con cambios.
      // Corre una vez por activación; los re-renders por cambios de estado
      // (p. ej. stepIndex) no refetchean. Marca el instante para que la
      // re-ejecución tras sincronizar la URL no dispare otra revalidación.
      const activationKey = `${effectKey}|${location.search}|${view}`;
      if (revalidatedRef.current === activationKey && draftRef.current) {
        setRoutePending(false);
        return;
      }
      revalidatedRef.current = activationKey;
      navRevalidatedAtRef.current = Date.now();
      const retainedDraft = draftRef.current;
      const needsInitialRead = !retainedDraft;
      setRoutePending(needsInitialRead);
      if (needsInitialRead) setError(null);
      void (async () => {
        try {
          if (view === "secretos") {
            const [nextFlows, nextFolders] = await readRouteNavigation();
            if (!isCurrent()) return;
            setFlows(nextFlows);
            setFolders(nextFolders);
            return;
          }
          const flowsPromise = api.listFlows();
          readFolders();
          const nextFlows = await flowsPromise;
          if (!isCurrent()) return;
          const summary =
            nextFlows.find((candidate) => candidate.id === requestedFlowId) ??
            nextFlows.find(
              (candidate) => candidate.id === draftRef.current?.id,
            ) ??
            nextFlows[0];
          const flowPromise = summary
            ? api.readFlow(summary.id)
            : Promise.resolve(null);
          const nextFlow = await flowPromise;
          if (!isCurrent()) return;
          setFlows(nextFlows);
          if (draftRef.current === retainedDraft && !dirtyRef.current) {
            if (nextFlow) {
              replaceFlow(nextFlow);
              const navStep = requestedFlowId
                ? safeStepIndex(nextFlow, step)
                : safeStepIndex(nextFlow, snapshot.stepIndex);
              setStepIndex(navStep);
              dirtyRef.current = false;
              setDirty(false);
              if (!isCurrent()) return;
              // La URL debe reflejar la selección visible, como en la
              // primera carga (sin flow= el regreso quedaría sin enlace).
              if (
                requestedFlowId !== summary.id ||
                (requestedFlowId != null && navStep !== step)
              ) {
                navigate(flowSelection(summary.id, navStep), {
                  replace: true,
                });
              }
            } else if (!summary) {
              replaceFlow(null);
              setStepIndex(0);
            }
          }
          if (!isCurrent()) return;
          setError(null);
        } catch (cause) {
          if (!isCurrent()) return;
          if (needsInitialRead) failRouteRead(cause);
          else clearAfterDeniedRead(cause);
        } finally {
          if (needsInitialRead && isCurrent()) finishRouteRead();
        }
      })();
      return cancelRead;
    }

    if (requestedFlowId && requestedFlowId === draftRef.current?.id) {
      setRoutePending(false);
      const nextStep = safeStepIndex(draftRef.current, step);
      setStepIndex(nextStep);
      if (nextStep !== step) {
        navigate(flowSelection(requestedFlowId, nextStep), { replace: true });
      }
      return;
    }
    // Sin estado conservado: primera carga con listas en paralelo y detalle
    // en cuanto se conoce el ID, sin que carpetas bloquee el detalle.
    setRoutePending(true);
    setError(null);

    if (view === "secretos") {
      // La pantalla de secretos es independiente del flow: solo carga la
      // navegación y conserva intacto cualquier borrador en curso.
      void (async () => {
        try {
          const [nextFlows, nextFolders] = await readRouteNavigation();
          if (!isCurrent()) return;
          setFlows(nextFlows);
          setFolders(nextFolders);
        } catch (exception) {
          if (isCurrent()) failRouteRead(exception);
        } finally {
          if (isCurrent()) finishRouteRead();
        }
      })();

      return cancelRead;
    }

    void (async () => {
      try {
        if (dirtyRef.current) {
          const saved = await saveDraft();
          if (!isCurrent()) return;
          if (!saved) {
            returnToDraft();
            return;
          }
        }
        const flowsPromise = api.listFlows();
        readFolders();
        const nextFlows = await flowsPromise;
        if (!isCurrent()) return;
        setFlows(nextFlows);
        const summary =
          nextFlows.find((candidate) => candidate.id === requestedFlowId) ??
          nextFlows[0];
        const flowPromise = summary
          ? api.readFlow(summary.id)
          : Promise.resolve(null);
        const nextFlow = await flowPromise;
        if (!isCurrent()) return;
        if (dirtyRef.current) {
          returnToDraft();
          return;
        }
        if (!summary || !nextFlow) {
          replaceFlow(null);
          setStepIndex(0);
          dirtyRef.current = false;
          setDirty(false);
          return;
        }
        const nextStep = safeStepIndex(nextFlow, step);
        replaceFlow(nextFlow);
        dirtyRef.current = false;
        setDirty(false);
        setStepIndex(nextStep);
        if (requestedFlowId !== summary.id || nextStep !== step) {
          navigate(flowSelection(summary.id, nextStep), { replace: true });
        }
      } catch (exception) {
        if (isCurrent()) failRouteRead(exception);
      } finally {
        if (isCurrent()) finishRouteRead();
      }
    })();
    return cancelRead;
  }, [
    active,
    api,
    clearAfterDeniedRead,
    principalGeneration,
    scopeKey,
    location.search,
    navigate,
    replaceFlow,
    routeReadScope,
    saveDraft,
    scopeState.scope,
    stepIndex,
    view,
  ]);

  const value = useMemo<WorkspaceValue>(
    () => ({
      active,
      view,
      flows,
      folders,
      flow,
      stepIndex,
      dirty,
      busy,
      routeLoading,
      routeReadError,
      error: routeReadError ?? error,
      api,
      scope: scopeState.scope,
      scopeLabel: scopeState.label,
      scopeReady: scopeState.ready,
      canOverrideScope: scopeState.canOverride,
      scopeOptions: scopeState.options,
      isPlatformAdmin: scopeState.isPlatformAdmin,
      applyScopeOverride: scopeState.applyOverride,
      createAndSelectFlow,
      duplicateAndSelectFlow,
      selectFlow,
      reloadFlow,
      retryRoute,
      openSecrets,
      saveDraft,
      updateDraft,
      discardDraft,
      clearSelection,
      refreshNavigation,
    }),
    [
      active,
      view,
      api,
      busy,
      routeLoading,
      routeReadError,
      error,
      flow,
      flows,
      folders,
      refreshNavigation,
      createAndSelectFlow,
      duplicateAndSelectFlow,
      saveDraft,
      selectFlow,
      reloadFlow,
      retryRoute,
      openSecrets,
      stepIndex,
      dirty,
      updateDraft,
      discardDraft,
      clearSelection,
      scopeState.scope,
      scopeState.label,
      scopeState.ready,
      scopeState.canOverride,
      scopeState.options,
      scopeState.isPlatformAdmin,
      scopeState.applyOverride,
    ],
  );

  return (
    <SaviaRequestWorkspaceContext.Provider value={value}>
      {children}
    </SaviaRequestWorkspaceContext.Provider>
  );
}

export function useSaviaRequestWorkspace() {
  const value = useContext(SaviaRequestWorkspaceContext);
  if (!value) {
    throw new Error(
      "SaviaRequestProvider is required to use the Savia Request workspace.",
    );
  }
  return value;
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import type { ApiClient } from "@/api/api-client";
import { getSessionReadsPaused } from "@/auth/logout-progress";
type Availability = { enabled: boolean; loading: boolean; error: boolean };
const unavailable: Availability = {
  enabled: false,
  loading: true,
  error: false,
};
export const OfficeAvailabilityContext =
  createContext<Availability>(unavailable);
export function useOfficeAvailability() {
  return useContext(OfficeAvailabilityContext);
}
export function OfficeAvailabilityProvider({
  apiClient,
  tenantId,
  children,
}: PropsWithChildren<{ apiClient: ApiClient; tenantId?: number }>) {
  const path =
    tenantId === undefined
      ? "/v1/office-settings"
      : `/v1/tenants/${tenantId}/office-settings`;
  const generation = useRef(0);
  const [state, setState] = useState<Availability & { path: string }>({
    ...unavailable,
    path,
  });
  const refresh = useCallback(
    async (scope: AbortSignal) => {
      const request = ++generation.current;
      try {
        const response = await apiClient.get<{ data: { enabled: boolean } }>(
          path,
          { signal: AbortSignal.any([scope, AbortSignal.timeout(15_000)]) },
        );
        if (!scope.aborted && request === generation.current)
          setState({
            path,
            enabled: response.data.enabled === true,
            loading: false,
            error: false,
          });
      } catch {
        if (!scope.aborted && request === generation.current)
          setState({ path, enabled: false, loading: false, error: true });
      }
    },
    [apiClient, path],
  );
  useEffect(() => {
    const scope = new AbortController();
    const update = () => {
      if (!scope.signal.aborted && !getSessionReadsPaused())
        void refresh(scope.signal);
    };
    const reset = () => {
      setState({ ...unavailable, path });
      update();
    };
    const clearSession = () => {
      scope.abort();
      setState({ ...unavailable, path });
    };
    const principalChanged = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.reason === "logout") {
        clearSession();
      } else {
        reset();
      }
    };
    window.addEventListener("focus", update);
    window.addEventListener("savia:office-settings-changed", update);
    window.addEventListener("savia:identity-changed", update);
    window.addEventListener("savia:principal-changed", principalChanged);
    window.addEventListener("savia:active-tenant-changed", reset);
    window.addEventListener("savia:session-cleared", clearSession);
    reset();
    return () => {
      scope.abort();
      window.removeEventListener("focus", update);
      window.removeEventListener("savia:office-settings-changed", update);
      window.removeEventListener("savia:identity-changed", update);
      window.removeEventListener("savia:principal-changed", principalChanged);
      window.removeEventListener("savia:active-tenant-changed", reset);
      window.removeEventListener("savia:session-cleared", clearSession);
    };
  }, [refresh, path]);
  return (
    <OfficeAvailabilityContext.Provider
      value={state.path === path ? state : unavailable}
    >
      {children}
    </OfficeAvailabilityContext.Provider>
  );
}

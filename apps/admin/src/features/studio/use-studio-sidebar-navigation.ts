import { useRealtimeRefresh } from "@/realtime/use-realtime-refresh";
import {
  getSessionReadsPaused,
  useSessionReadsPaused,
} from "@/auth/logout-progress";
import {
  getSessionGeneration,
  useSessionGeneration,
} from "@/auth/session-scope";
import { useAppLocale } from "@/i18n/core";
import { localizedExtensionObjectLabel } from "@/features/studio-engine/extension-screens";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useAppServices } from "@/features/assistant/assistant-context";
import { isReadAccessDenied } from "@/queries/read-state";
import {
  STUDIO_TENANTS_CHANGED,
  listStudioTenants,
  selectStudioTenant,
  type StudioTenant,
} from "./studio-tenants";
import {
  studioSidebarChildren,
  isStudioNavigationMessage,
  parseStudioSearch,
  summarizeStudioObject,
  type StudioNavigationObject,
  type StudioSidebarChild,
} from "./studio-navigation";

export function useStudioSidebarNavigation(enabled: boolean): {
  tenantId?: number;
  children: StudioSidebarChild[];
  metadataReadFailed: boolean;
  metadataRetrying: boolean;
  retryMetadata: () => void;
} {
  const services = useAppServices();
  const readsPaused = useSessionReadsPaused();
  const sessionGeneration = useSessionGeneration();
  const canLoad = enabled && !readsPaused;
  const locale = useAppLocale();
  const location = useLocation();
  const { object: activeObject, tenantId: requestedTenantId } =
    parseStudioSearch(location.search);
  const catalogScope = useMemo(
    () => (canLoad ? { services, sessionGeneration } : undefined),
    [canLoad, services, sessionGeneration],
  );
  const [catalog, setCatalog] = useState<{
    scope: NonNullable<typeof catalogScope>;
    tenants: StudioTenant[];
    revision: number;
  }>();
  const currentCatalog = catalog?.scope === catalogScope ? catalog : undefined;
  const tenants = currentCatalog?.tenants ?? [];
  const catalogRevision = currentCatalog?.revision ?? 0;
  const tenant = selectStudioTenant(tenants, requestedTenantId);
  const tenantId = tenant?.tenantId;
  const apiBasePath = tenant?.apiBasePath;
  const tenantScope = useMemo(
    () =>
      catalogScope && tenantId !== undefined && apiBasePath
        ? { ...catalogScope, tenantId, apiBasePath }
        : undefined,
    [catalogScope, tenantId, apiBasePath],
  );
  const [catalogVersion, setCatalogVersion] = useState(0);
  type TenantScope = NonNullable<typeof tenantScope>;
  const [snapshot, setSnapshot] = useState<
    { scope: TenantScope } & (
      | {
          status: "ready";
          objects: StudioNavigationObject[];
          hubspotCount?: { name: string; total: number };
        }
      | { status: "denied" }
    )
  >();
  const [metadataFailure, setMetadataFailure] = useState<{
    scope: TenantScope;
    retrying: boolean;
  }>();
  const metadataRead = useRef<{
    scope: TenantScope;
    controller: AbortController;
  }>(undefined);
  useEffect(() => {
    const refresh = () => setCatalogVersion((value) => value + 1);
    window.addEventListener(STUDIO_TENANTS_CHANGED, refresh);
    return () => window.removeEventListener(STUDIO_TENANTS_CHANGED, refresh);
  }, []);
  useEffect(() => {
    if (!catalogScope) return;
    let active = true;
    void listStudioTenants(catalogScope.services).then(
      (result) => {
        if (active)
          setCatalog((previous) => ({
            scope: catalogScope,
            tenants: result,
            revision:
              previous?.scope === catalogScope ? previous.revision + 1 : 0,
          }));
      },
      (error: unknown) => {
        if (active && isReadAccessDenied(error))
          setCatalog({ scope: catalogScope, tenants: [], revision: 0 });
      },
    );
    return () => {
      active = false;
    };
  }, [catalogScope, catalogVersion]);
  const [refresh, setRefresh] = useState<{
    scope: TenantScope;
    revision: number;
  }>();
  const refreshRevision =
    refresh?.scope === tenantScope ? (refresh?.revision ?? 0) : 0;
  const retryMetadata = () => {
    if (!tenantScope) return;
    setRefresh((previous) => ({
      scope: tenantScope,
      revision: previous?.scope === tenantScope ? previous.revision + 1 : 1,
    }));
  };
  useRealtimeRefresh({
    topics: ["studio", "records"],
    tenantId,
    enabled: Boolean(tenantScope),
    refreshScope: tenantScope,
    refreshOnInitialConnect: Boolean(services.localData),
    refresh: retryMetadata,
  });
  useEffect(() => {
    if (!tenantScope) return;
    const { services, apiBasePath } = tenantScope;
    const controller = new AbortController();
    const { signal } = controller;
    const request = { scope: tenantScope, controller };
    metadataRead.current = request;
    setMetadataFailure((previous) =>
      previous?.scope === tenantScope
        ? { scope: tenantScope, retrying: true }
        : previous,
    );
    const load = () =>
      services.apiClient.get<{ data: unknown[] }>(
        `${apiBasePath}/api/objects`,
        { signal },
      );
    void (
      services.localData && refreshRevision === 0 && catalogRevision === 0
        ? services.localData.cachedMetadata(`navigation:${apiBasePath}`, load)
        : load()
    )
      .then((response) => {
        if (signal.aborted) return;
        const objects = response.data
          .map((row) =>
            summarizeStudioObject(
              (row ?? {}) as Parameters<typeof summarizeStudioObject>[0],
            ),
          )
          .filter((row): row is StudioNavigationObject => Boolean(row));
        setSnapshot((previous) => ({
          scope: tenantScope,
          status: "ready",
          objects,
          hubspotCount:
            previous?.scope === tenantScope && previous.status === "ready"
              ? previous.hubspotCount
              : undefined,
        }));
        setMetadataFailure(undefined);
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        if (isReadAccessDenied(error)) {
          setSnapshot({ scope: tenantScope, status: "denied" });
          setMetadataFailure(undefined);
        } else {
          setMetadataFailure({ scope: tenantScope, retrying: false });
        }
      });
    return () => {
      controller.abort();
      if (metadataRead.current === request) metadataRead.current = undefined;
    };
  }, [tenantScope, refreshRevision, catalogRevision]);
  useEffect(() => {
    if (!tenantScope) return;
    const scope = tenantScope;
    function onMessage(event: MessageEvent) {
      if (
        event.origin !== window.location.origin ||
        !isStudioNavigationMessage(event.data) ||
        getSessionReadsPaused() ||
        getSessionGeneration() !== scope.sessionGeneration ||
        event.data.sessionGeneration !== scope.sessionGeneration ||
        event.data.tenantId !== scope.tenantId
      )
        return;
      if (event.data.accessDenied === true) {
        if (metadataRead.current?.scope === scope)
          metadataRead.current.controller.abort();
        setSnapshot({ scope, status: "denied" });
        setMetadataFailure(undefined);
        return;
      }
      const objects = event.data.objects
        .map((row) => summarizeStudioObject(row))
        .filter((row): row is StudioNavigationObject => Boolean(row));
      const count = event.data.hubspotCount;
      const hubspotCount =
        count &&
        typeof count.name === "string" &&
        Number.isSafeInteger(count.total) &&
        count.total >= 0
          ? count
          : undefined;
      setSnapshot((previous) =>
        previous?.scope === scope && previous.status === "denied"
          ? previous
          : { scope, status: "ready", objects, hubspotCount },
      );
      setMetadataFailure(undefined);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [tenantScope]);
  const children = useMemo(() => {
    if (!canLoad) return [];
    const current = snapshot?.scope === tenantScope ? snapshot : undefined;
    const objects = current?.status === "ready" ? current.objects : [];
    const hubspotCount =
      current?.status === "ready" ? current.hubspotCount : undefined;
    return studioSidebarChildren(
      objects.map((object) => ({
        ...object,
        ...(object.hubspot && hubspotCount?.name === object.name
          ? { count: hubspotCount.total }
          : {}),
        label: localizedExtensionObjectLabel(object.name, object.label, locale),
      })),
      tenantId,
      tenantScope && current?.status !== "denied" ? activeObject : undefined,
    ).map((item) =>
      item.id === "studio:admin"
        ? {
            ...item,
            label:
              locale === "en"
                ? "Manage"
                : locale === "pt"
                  ? "Administrar"
                  : "Administrar",
          }
        : item,
    );
  }, [canLoad, snapshot, tenantId, tenantScope, activeObject, locale]);
  const currentFailure =
    metadataFailure?.scope === tenantScope ? metadataFailure : undefined;
  return {
    tenantId,
    children,
    metadataReadFailed: Boolean(currentFailure),
    metadataRetrying: currentFailure?.retrying ?? false,
    retryMetadata,
  };
}

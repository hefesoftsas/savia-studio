import { useRealtimeRefresh } from "@/realtime/use-realtime-refresh";
import { matchTenantApiBasePath } from "@/features/studio/studio-navigation";
import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { ApiClientError, type ApiClient } from "@/api/api-client";
import { useSessionReadsPaused } from "@/auth/logout-progress";
import { useSessionGeneration } from "@/auth/session-scope";
import { useAppLocale, useMessages } from "@/i18n/core";
import { isReadAccessDenied } from "@/queries/read-state";
import type { MyDayWidget } from "@savia/studio-shared/my-day-widgets";
import { ReadRefreshStatus } from "@/components/admin/read-refresh-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isPluginWidgetEnabled,
  listWidgetExtensions,
  parsePluginKind,
  pluginApiFor,
  pluginContributionFor,
  storeWidgetDeclarationFor,
  storeWidgetFor,
  type ExtensionInstallation,
} from "./plugins";
import { CustomPluginFrame } from "../studio-engine/custom-plugin-frame";
import { widgetMessages } from "./widget-messages";

function PluginWidgetSkeleton() {
  const t = useMessages(widgetMessages);
  return (
    <div role="status" aria-label={t("Loading widget…")} className="space-y-2">
      <span className="sr-only">{t("Loading widget…")}</span>
      <Skeleton className="h-8 w-24" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}

class WidgetErrorBoundary extends Component<
  {
    children: React.ReactNode;
    title: string;
    translate: ReturnType<typeof useMessages<typeof widgetMessages>>;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            {this.props.translate("This widget could not be displayed.")}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => this.setState({ failed: false })}
            aria-label={this.props.translate("Retry widget %{title}", {
              title: this.props.title,
            })}
          >
            {this.props.translate("Retry")}
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function PluginWidgetBody({
  apiClient,
  widget,
}: {
  apiClient: ApiClient | undefined;
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>;
}) {
  const locale = useAppLocale();
  const t = useMessages(widgetMessages);
  const sessionGeneration = useSessionGeneration();
  const readsPaused = useSessionReadsPaused();
  const { apiBasePath } = widget;
  const scope = useMemo(
    () => ({ apiClient, apiBasePath, sessionGeneration, readsPaused }),
    [apiClient, apiBasePath, sessionGeneration, readsPaused],
  );
  const [verification, setVerification] = useState<{
    scope: typeof scope;
    revision: number;
    extensions?: ExtensionInstallation[];
    failed: boolean;
  }>();
  const [revision, setRevision] = useState(0);
  const retry = () => setRevision((value) => value + 1);
  const tenantId = matchTenantApiBasePath(apiBasePath);
  useRealtimeRefresh({
    topics: ["studio"],
    tenantId: Number(tenantId),
    enabled: tenantId !== undefined && Boolean(apiClient) && !readsPaused,
    refreshScope: scope,
    refresh: retry,
  });

  const ref = useMemo(() => parsePluginKind(widget.kind), [widget.kind]);
  useEffect(() => {
    const { apiClient, apiBasePath, readsPaused } = scope;
    if (!apiClient || !ref || readsPaused) return;
    const controller = new AbortController();
    const { signal } = controller;
    void listWidgetExtensions(apiClient, apiBasePath, { signal }).then(
      (extensions) => {
        if (!signal.aborted)
          setVerification({ scope, revision, extensions, failed: false });
      },
      (reason: unknown) => {
        if (signal.aborted) return;
        const catalogUnavailable =
          isReadAccessDenied(reason) ||
          (reason instanceof ApiClientError &&
            (reason.status === 404 || reason.status === 410));
        setVerification((previous) => ({
          scope,
          revision,
          extensions:
            !catalogUnavailable && previous?.scope === scope
              ? previous.extensions
              : undefined,
          failed: true,
        }));
      },
    );
    return () => controller.abort();
  }, [scope, ref, revision]);

  const savia = useMemo(
    () =>
      apiClient && ref
        ? pluginApiFor(ref.extensionId, apiClient, apiBasePath)
        : undefined,
    [apiClient, ref, apiBasePath],
  );

  const current = verification?.scope === scope ? verification : undefined;
  if (!ref || !current) return <PluginWidgetSkeleton />;
  if (!current.extensions) {
    if (current.revision !== revision) return <PluginWidgetSkeleton />;
    const message = t("Could not verify this widget extension.");
    return (
      <Alert aria-label={message}>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
          <span>{message}</span>
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t("Retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  const { extensions } = current;
  const contribution = pluginContributionFor(ref);
  // Tenant store installations take precedence over bundled contributions.
  const storeWidget = storeWidgetFor(ref, extensions);
  const storeDeclared = storeWidgetDeclarationFor(ref, extensions);
  let content: ReactNode;
  if (storeWidget) {
    content = (
      <CustomPluginFrame
        pluginId={storeWidget.extensionId}
        installationVersion={
          extensions.find(
            (entry) => entry.manifest.id === storeWidget.extensionId,
          )?.installed?.version
        }
        title={storeWidget.title[locale] ?? storeWidget.title.es}
        src={`${apiBasePath}/api/plugin-store/${encodeURIComponent(storeWidget.extensionId)}/widget?widget=${encodeURIComponent(storeWidget.id)}&collection=${encodeURIComponent(storeWidget.collection)}`}
        heightClassName="h-[320px]"
      />
    );
  } else if (storeDeclared) {
    content = (
      <p className="text-sm text-muted-foreground">
        {t("Enable the %{extension} extension to see this widget.", {
          extension: storeDeclared.title[locale] ?? storeDeclared.title.es,
        })}
      </p>
    );
  } else if (!contribution) {
    content = (
      <p className="text-sm text-muted-foreground">
        {t(
          "This widget type will be available soon. In the meantime, open the full collection.",
        )}
      </p>
    );
  } else if (!savia) {
    content = <PluginWidgetSkeleton />;
  } else if (!isPluginWidgetEnabled(contribution, extensions)) {
    content = (
      <p className="text-sm text-muted-foreground">
        {t("Enable the %{extension} extension to see this widget.", {
          extension: contribution.title[locale] ?? contribution.title.es,
        })}
      </p>
    );
  } else {
    const Widget = contribution.Widget;
    content = (
      <WidgetErrorBoundary
        title={contribution.title[locale] ?? contribution.title.es}
        translate={t}
      >
        <Widget savia={savia} widget={widget} />
      </WidgetErrorBoundary>
    );
  }

  return (
    <>
      <ReadRefreshStatus
        refreshing={current.revision !== revision}
        error={
          current.failed
            ? t("Could not verify this widget extension.")
            : undefined
        }
        onRetry={retry}
      />
      {content}
    </>
  );
}

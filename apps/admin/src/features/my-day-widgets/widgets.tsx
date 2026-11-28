import { MailWidgetBody } from "./mail-widget";
import type { MailState } from "./use-my-day-mail";
import { useRealtimeRefresh } from "@/realtime/use-realtime-refresh";
import { matchTenantApiBasePath } from "@/features/studio/studio-navigation";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useState,
} from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { ApiClientError, type ApiClient } from "@/api/api-client";
import { RequestTimeoutError } from "@/api/request-timeout";
import { formatRetryTime } from "@/api/retry-after";
import { retryIsBlocked, useRetryBlocked } from "@/hooks/use-retry-blocked";
import { isOfflineError } from "@/offline/offline-error";
import { ReadRefreshStatus } from "@/components/admin/read-refresh-status";
import { getLogoutPending } from "@/auth/logout-progress";
import { useSessionGeneration } from "@/auth/session-scope";
import { intlLocale, useAppLocale, useMessages } from "@/i18n/core";
import type { MyDayWidget } from "@savia/studio-shared/my-day-widgets";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import {
  describeWidgetCollection,
  listWidgetRecords,
  listWidgetRecordsForReview,
  loadWidgetSummary,
  summarizeWidgetRecords,
  widgetDeepLink,
} from "./data";
import {
  autoDetectWidgetConfig,
  bucketActionItems,
  recordStatus,
  recordTitle,
} from "./summarize";
import { PluginWidgetBody } from "./plugin-widget";
import { parsePluginKind, pluginContributionFor } from "./plugins";
import { AgendaWidgetBody, QuickTaskWidgetBody } from "./agenda-widget";
import { OfficeDocumentsWidgetBody } from "./office-documents-widget";
import type {
  WidgetCollectionSchema,
  WidgetRecord,
  WidgetSummaryGroup,
} from "./types";
import { widgetMessages } from "./widget-messages";

function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatAmount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
    value,
  );
}

function formatRecordDate(
  record: WidgetRecord,
  dateField: string | undefined,
  locale: string,
): string | undefined {
  const raw =
    (dateField ? record[dateField] : undefined) ??
    record.updated_at ??
    record.created_at;
  if (typeof raw !== "string" || !raw) return undefined;
  const date = new Date(raw.length === 10 ? `${raw}T12:00:00` : raw);
  return Number.isNaN(date.getTime())
    ? undefined
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function formatActionDay(day: string, locale: string): string {
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime())
    ? day
    : new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function WidgetError({
  message,
  onRetry,
  retryDisabled = false,
}: {
  message: string;
  onRetry: () => void;
  retryDisabled?: boolean;
}) {
  const t = useMessages(widgetMessages);
  return (
    <Alert aria-label={message}>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
        <span>{message}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onRetry}
          disabled={retryDisabled}
        >
          <RefreshCw className="size-3.5" />
          {t("Retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function WidgetSkeleton() {
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

type WidgetSchemaResult =
  | { status: "pending" | "missing" | "failed"; schemaRevision?: never }
  | { status: "ready"; schema: WidgetCollectionSchema; schemaRevision: number };

type WidgetReadScope = {
  apiClient: ApiClient | undefined;
  apiBasePath: string;
  collection: string;
  sessionGeneration: number;
};

type WidgetSchemaRequest = {
  scope: WidgetReadScope;
  revision: number;
  result: WidgetSchemaResult;
  refreshFailed?: boolean;
};

function isTemporaryWidgetError(error: unknown): boolean {
  return error instanceof ApiClientError
    ? error.status >= 500 || error.status === 408 || error.status === 429
    : error instanceof RequestTimeoutError || isOfflineError(error);
}

function WidgetSchemaFallback({
  status,
  retry,
}: {
  status: "pending" | "missing" | "failed";
  retry: () => void;
}) {
  const t = useMessages(widgetMessages);
  if (status === "failed")
    return (
      <WidgetError
        message={t("Could not read this collection.")}
        onRetry={retry}
      />
    );
  if (status === "missing")
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          "This collection is no longer available. Remove it from your dashboard.",
        )}
      </p>
    );
  return <WidgetSkeleton />;
}

function useWidgetSchema(
  apiClient: ApiClient | undefined,
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>,
): WidgetSchemaResult & {
  scope: WidgetReadScope;
  retry: () => void;
  refreshFailed: boolean;
} {
  const [request, setRequest] = useState<WidgetSchemaRequest | null>(null);
  const [revision, setRevision] = useState(0);
  const sessionGeneration = useSessionGeneration();
  const { apiBasePath, collection } = widget;
  const scope = useMemo(
    () => ({ apiClient, apiBasePath, collection, sessionGeneration }),
    [apiClient, apiBasePath, collection, sessionGeneration],
  );
  const retry = () => setRevision((value) => value + 1);
  const tenantId = matchTenantApiBasePath(apiBasePath);
  useRealtimeRefresh({
    topics: ["studio"],
    tenantId: Number(tenantId),
    enabled: tenantId !== undefined,
    refreshScope: scope,
    refresh: retry,
  });
  useEffect(() => {
    const { apiClient, apiBasePath, collection } = scope;
    if (!apiClient || getLogoutPending()) return;
    const controller = new AbortController();
    const { signal } = controller;
    void describeWidgetCollection(apiClient, apiBasePath, collection, {
      signal,
    }).then(
      (schema) => {
        if (signal.aborted) return;
        setRequest((previous) => {
          if (!schema) return { scope, revision, result: { status: "missing" } };
          const prior = previous?.scope === scope ? previous.result : undefined;
          // A metadata reread still refreshes data. Only reuse a result from
          // the same schema when no missing or denied read intervened.
          const schemaRevision =
            prior?.status === "ready" &&
            JSON.stringify(prior.schema) === JSON.stringify(schema)
              ? prior.schemaRevision
              : revision;
          return {
            scope,
            revision,
            result: { status: "ready", schema, schemaRevision },
          };
        });
      },
      (error: unknown) => {
        if (signal.aborted) return;
        setRequest((previous) => {
          if (
            previous?.scope === scope &&
            previous.result.status === "ready" &&
            isTemporaryWidgetError(error)
          )
            return { ...previous, revision, refreshFailed: true };
          return { scope, revision, result: { status: "failed" } };
        });
      },
    );
    return () => controller.abort();
  }, [scope, revision]);
  const current = request?.scope === scope ? request : null;
  const result =
    current &&
    (current.revision === revision || current.result.status === "ready")
      ? current.result
      : { status: "pending" as const };
  return {
    ...result,
    scope,
    retry,
    refreshFailed:
      current?.revision === revision && current.refreshFailed === true,
  };
}

function WidgetRefreshStatus({
  metadata,
  error,
  onRetry,
  retryDisabled,
}: {
  metadata: { refreshFailed: boolean; retry: () => void };
  error?: string;
  onRetry: () => void;
  retryDisabled?: boolean;
}) {
  const t = useMessages(widgetMessages);
  return (
    <ReadRefreshStatus
      error={
        metadata.refreshFailed ? t("Could not read this collection.") : error
      }
      onRetry={metadata.refreshFailed ? metadata.retry : onRetry}
      retryDisabled={!metadata.refreshFailed && retryDisabled}
    />
  );
}

type WidgetReadFailure = {
  status?: number;
  retryAt?: number;
  partial: boolean;
};

function useWidgetResult<T extends object>(
  scope: WidgetReadScope,
  schemaRevision: number | undefined,
  selectionKey: string,
) {
  const [request, setRequest] = useState<{
    scope: WidgetReadScope;
    schemaRevision: number | undefined;
    selectionKey: string;
    data?: T;
    failure?: WidgetReadFailure;
  }>();
  const setResult = useCallback(
    (result?: { data: T } | { error: unknown; data?: T }) => {
      setRequest((previous) => {
        const current =
          previous?.scope === scope &&
          previous.schemaRevision === schemaRevision &&
          previous.selectionKey === selectionKey
            ? previous
            : undefined;
        if (!result)
          return current?.failure
            ? { ...current, failure: undefined }
            : current;
        if (!("error" in result))
          return { scope, schemaRevision, selectionKey, data: result.data };
        const { error, data } = result;
        return {
          scope,
          schemaRevision,
          selectionKey,
          failure: {
            ...(error instanceof ApiClientError
              ? { status: error.status, retryAt: error.retryAt }
              : {}),
            partial: data !== undefined,
          },
          data:
            data ?? (isTemporaryWidgetError(error) ? current?.data : undefined),
        };
      });
    },
    [scope, schemaRevision, selectionKey],
  );
  const current = request?.scope === scope ? request : undefined;
  const result =
    current &&
    current.schemaRevision === schemaRevision &&
    current.selectionKey === selectionKey
      ? current
      : undefined;
  // A new selection invalidates the data but still reads the same source.
  const failure =
    result?.failure ??
    (current?.failure?.status === 429 && current.failure.retryAt !== undefined
      ? current.failure
      : undefined);
  return [result?.data, Boolean(failure), setResult, failure] as const;
}

function useWidgetRefresh(
  scope: WidgetReadScope,
  {
    failure,
    hubspot,
    uiLocale,
  }: {
    failure: WidgetReadFailure | undefined;
    hubspot?: boolean;
    uiLocale: string;
  },
) {
  const t = useMessages(widgetMessages);
  const [nonce, setNonce] = useState(0);
  const retryAt = failure?.status === 429 ? failure.retryAt : undefined;
  const retryDisabled = useRetryBlocked(retryAt);
  const retry = () => {
    if (!retryIsBlocked(retryAt)) setNonce((value) => value + 1);
  };
  const tenantId = matchTenantApiBasePath(scope.apiBasePath);
  useRealtimeRefresh({
    topics: ["records"],
    tenantId: Number(tenantId),
    enabled: tenantId !== undefined,
    refreshScope: scope,
    accepts: (event) => event.collection === scope.collection,
    refresh: retry,
  });
  const retryTime = formatRetryTime(failure, uiLocale);
  const rateLimitMessage = retryTime
    ? t(
        hubspot
          ? "HubSpot reached its request limit. You can retry from %{p0}."
          : "You can retry from %{p0}.",
        { p0: retryTime },
      )
    : hubspot && failure?.status === 429
      ? t("HubSpot reached its request limit. Try again later.")
      : undefined;
  return { nonce, retryAt, retryDisabled, retry, rateLimitMessage };
}

type SummaryWidgetResult = {
  total: number | undefined;
  groups: WidgetSummaryGroup[] | null;
  breakdownUnavailable?: boolean;
};

export function SummaryWidgetBody({
  apiClient,
  widget,
}: {
  apiClient: ApiClient | undefined;
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>;
}) {
  const t = useMessages(widgetMessages);
  const uiLocale = intlLocale(useAppLocale());
  const metadata = useWidgetSchema(apiClient, widget);
  const schema = metadata.status === "ready" ? metadata.schema : null;
  const detected = schema ? autoDetectWidgetConfig(schema) : {};
  const statusField =
    schema?.summarySupported === false
      ? undefined
      : (widget.config?.statusField ?? detected.statusField);
  const amountField = widget.config?.amountField ?? detected.amountField;
  const limit = widget.config?.limit ?? 5;
  const [result, failed, setResult, failure] =
    useWidgetResult<SummaryWidgetResult>(
      metadata.scope,
      metadata.schemaRevision,
      JSON.stringify([statusField, amountField]),
    );
  const { nonce, retryAt, retryDisabled, retry, rateLimitMessage } =
    useWidgetRefresh(metadata.scope, {
      failure,
      hubspot: schema?.hubspot,
      uiLocale,
    });
  const isRateLimited = useEffectEvent(() => retryIsBlocked(retryAt));

  useEffect(() => {
    if (!apiClient || !schema || isRateLimited()) return;
    const controller = new AbortController();
    const { signal } = controller;
    setResult();
    const finish = (data: SummaryWidgetResult, error?: unknown) => {
      if (!signal.aborted)
        setResult(error === undefined ? { data } : { data, error });
    };
    void (async () => {
      try {
        const effective: MyDayWidget = {
          ...widget,
          config: { ...widget.config, amountField },
        };
        if (schema.hubspot) {
          let fallbackToTotal = false;
          const summary = await loadWidgetSummary(
            apiClient,
            effective,
            statusField,
            { signal },
          ).catch((error: unknown) => {
            if (
              signal.aborted ||
              !statusField ||
              !(error instanceof ApiClientError) ||
              error.status !== 422
            )
              throw error;
            fallbackToTotal = true;
            return loadWidgetSummary(apiClient, effective, undefined, {
              signal,
            });
          });
          if (
            summary.total === undefined ||
            !Number.isSafeInteger(summary.total) ||
            summary.total < 0
          )
            throw new Error("HubSpot collection total is unavailable");
          finish({
            total: summary.total,
            groups:
              statusField && !fallbackToTotal ? (summary.groups ?? null) : null,
            breakdownUnavailable:
              Boolean(statusField) &&
              (fallbackToTotal || summary.groups === undefined),
          });
          return;
        }
        const [page, breakdown] = await Promise.all([
          listWidgetRecords(
            apiClient,
            { ...widget, config: { ...widget.config, limit: 1 } },
            { signal, sortSupported: schema.sortSupported },
          ),
          statusField
            ? loadWidgetSummary(apiClient, effective, statusField, {
                signal,
              }).then(
                ({ groups }) => ({ groups, error: undefined }),
                (error: unknown) => {
                  if (error instanceof ApiClientError && error.status === 422)
                    return null;
                  if (!isTemporaryWidgetError(error)) throw error;
                  return { groups: undefined, error };
                },
              )
            : Promise.resolve(null),
        ]);
        finish(
          {
            total: page.total,
            groups: breakdown?.groups ?? null,
            breakdownUnavailable:
              Boolean(statusField) && breakdown?.groups === undefined,
          },
          breakdown?.error,
        );
      } catch (error) {
        if (!signal.aborted) setResult({ error });
      }
    })();
    return () => controller.abort();
  }, [apiClient, widget, schema, statusField, amountField, nonce, setResult]);

  if (metadata.status !== "ready")
    return <WidgetSchemaFallback {...metadata} />;
  const error = rateLimitMessage ?? t("Could not load this summary.");
  if (failed && !result)
    return (
      <WidgetError
        message={error}
        onRetry={retry}
        retryDisabled={retryDisabled}
      />
    );
  if (!result) return <WidgetSkeleton />;
  const { total, groups, breakdownUnavailable } = result;
  const breakdownError = t("The status breakdown is unavailable.");
  const refreshError = failure?.partial ? breakdownError : error;

  return (
    <div className="space-y-3">
      <WidgetRefreshStatus
        metadata={metadata}
        error={failed ? refreshError : undefined}
        onRetry={retry}
        retryDisabled={retryDisabled}
      />
      {total === undefined ? (
        <p className="text-sm text-muted-foreground">
          {t("The record total is unavailable.")}
        </p>
      ) : (
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-semibold tabular-nums">
            {formatCount(total, uiLocale)}
          </span>
          <span className="text-sm text-muted-foreground">{t("records")}</span>
        </div>
      )}
      {breakdownUnavailable && !failure?.partial ? (
        <p className="text-sm text-muted-foreground">{breakdownError}</p>
      ) : groups?.length ? (
        <ul className="divide-y rounded-lg border">
          {groups.slice(0, limit).map((group) => (
            <li
              key={group.value}
              className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {group.value}
              </span>
              {amountField ? (
                <span className="tabular-nums text-muted-foreground">
                  {formatAmount(group.amount, uiLocale)}
                </span>
              ) : null}
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold tabular-nums">
                {formatCount(group.count, uiLocale)}
              </span>
            </li>
          ))}
        </ul>
      ) : total === undefined ||
        metadata.schema.summarySupported === false ||
        statusField ? null : (
        <p className="text-sm text-muted-foreground">
          {t("No status field: showing the collection total.")}
        </p>
      )}
    </div>
  );
}

export function ItemsWidgetBody({
  apiClient,
  widget,
}: {
  apiClient: ApiClient | undefined;
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>;
}) {
  const t = useMessages(widgetMessages);
  const uiLocale = intlLocale(useAppLocale());
  const metadata = useWidgetSchema(apiClient, widget);
  const schema = metadata.status === "ready" ? metadata.schema : null;
  const { limit, sort, order, statusField, dateField } = widget.config ?? {};
  const [records, failed, setRecords, failure] = useWidgetResult<
    { id: string; title: string; status?: string; date?: string }[]
  >(
    metadata.scope,
    metadata.schemaRevision,
    JSON.stringify([limit, sort, order, statusField, dateField, uiLocale]),
  );
  const { nonce, retryAt, retryDisabled, retry, rateLimitMessage } =
    useWidgetRefresh(metadata.scope, {
      failure,
      hubspot: schema?.hubspot,
      uiLocale,
    });
  const isRateLimited = useEffectEvent(() => retryIsBlocked(retryAt));

  useEffect(() => {
    if (!apiClient || !schema || isRateLimited()) return;
    const controller = new AbortController();
    const { signal } = controller;
    setRecords();
    void listWidgetRecords(apiClient, widget, {
      signal,
      sortSupported: schema.sortSupported,
    }).then(
      (page) => {
        if (signal.aborted) return;
        setRecords({
          data: page.data.map((record) => ({
            id: String(record.id),
            title: recordTitle(record, schema),
            status: recordStatus(record, statusField) ?? undefined,
            date: formatRecordDate(record, dateField, uiLocale),
          })),
        });
      },
      (error: unknown) => {
        if (!signal.aborted) setRecords({ error });
      },
    );
    return () => controller.abort();
  }, [
    apiClient,
    widget,
    schema,
    nonce,
    uiLocale,
    statusField,
    dateField,
    setRecords,
  ]);

  if (metadata.status !== "ready")
    return <WidgetSchemaFallback {...metadata} />;
  const error = rateLimitMessage ?? t("Could not load these items.");
  if (failed && !records)
    return (
      <WidgetError
        message={error}
        onRetry={retry}
        retryDisabled={retryDisabled}
      />
    );
  if (!records) return <WidgetSkeleton />;
  const refreshStatus = (
    <WidgetRefreshStatus
      metadata={metadata}
      error={failed ? error : undefined}
      onRetry={retry}
      retryDisabled={retryDisabled}
    />
  );
  if (records.length === 0)
    return (
      <>
        {refreshStatus}
        <p className="text-sm text-muted-foreground">
          {t("There are no records in this collection yet.")}
        </p>
      </>
    );

  return (
    <div className="space-y-3">
      {refreshStatus}
      <ul className="divide-y rounded-lg border">
        {records.map((record) => (
          <li key={record.id} className="px-3 py-2">
            <p className="truncate text-sm font-medium">{record.title}</p>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
              {record.status ? <span>{record.status}</span> : null}
              {record.date ? <span>{record.date}</span> : null}
              {!record.status && !record.date ? (
                <span>{t("No details")}</span>
              ) : null}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartWidgetBody({
  apiClient,
  widget,
}: {
  apiClient: ApiClient | undefined;
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>;
}) {
  const t = useMessages(widgetMessages);
  const uiLocale = intlLocale(useAppLocale());
  const metadata = useWidgetSchema(apiClient, widget);
  const schema = metadata.status === "ready" ? metadata.schema : null;
  const detected = schema ? autoDetectWidgetConfig(schema) : {};
  const groupField = widget.config?.groupField ?? detected.statusField;
  const amountField = widget.config?.amountField ?? detected.amountField;
  const limit = widget.config?.limit ?? 5;
  const unsupported = schema?.summarySupported === false;
  const [groups, failed, setGroups, failure] = useWidgetResult<
    WidgetSummaryGroup[]
  >(
    metadata.scope,
    metadata.schemaRevision,
    JSON.stringify([groupField, amountField]),
  );
  const { nonce, retryAt, retryDisabled, retry, rateLimitMessage } =
    useWidgetRefresh(metadata.scope, {
      failure,
      hubspot: schema?.hubspot,
      uiLocale,
    });
  const isRateLimited = useEffectEvent(() => retryIsBlocked(retryAt));

  useEffect(() => {
    if (!apiClient || !schema || unsupported || !groupField || isRateLimited())
      return;
    const controller = new AbortController();
    const { signal } = controller;
    setGroups();
    void summarizeWidgetRecords(
      apiClient,
      { ...widget, config: { ...widget.config, amountField } },
      groupField,
      { signal },
    ).then(
      (breakdown) => {
        if (!signal.aborted) setGroups({ data: breakdown });
      },
      (error: unknown) => {
        if (!signal.aborted) setGroups({ error });
      },
    );
    return () => controller.abort();
  }, [
    apiClient,
    widget,
    schema,
    unsupported,
    groupField,
    amountField,
    nonce,
    setGroups,
  ]);

  if (metadata.status !== "ready")
    return <WidgetSchemaFallback {...metadata} />;
  if (unsupported)
    return (
      <p className="text-sm text-muted-foreground">
        {t("This source does not support charts by status.")}
      </p>
    );
  if (!groupField)
    return (
      <p className="text-sm text-muted-foreground">
        {t(
          "This collection has no grouping field for a chart. Try a summary or items widget.",
        )}
      </p>
    );
  const error = rateLimitMessage ?? t("Could not load this chart.");
  if (failed && !groups)
    return (
      <WidgetError
        message={error}
        onRetry={retry}
        retryDisabled={retryDisabled}
      />
    );
  if (!groups) return <WidgetSkeleton />;
  const refreshStatus = (
    <WidgetRefreshStatus
      metadata={metadata}
      error={failed ? error : undefined}
      onRetry={retry}
      retryDisabled={retryDisabled}
    />
  );
  if (groups.length === 0)
    return (
      <>
        {refreshStatus}
        <p className="text-sm text-muted-foreground">
          {t("No data to chart yet.")}
        </p>
      </>
    );

  const visible = groups.slice(0, limit);
  const max = Math.max(1, ...visible.map((group) => group.count));

  return (
    <div className="space-y-3">
      {refreshStatus}
      <ul className="space-y-2.5">
        {visible.map((group) => (
          <li key={group.value}>
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-medium">
                {group.value}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {amountField
                  ? `${formatAmount(group.amount, uiLocale)} · `
                  : ""}
                {formatCount(group.count, uiLocale)}
              </span>
            </div>
            <div
              className="mt-1 h-2 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${group.value}: ${formatCount(group.count, uiLocale)}`}
            >
              <div
                className="h-full rounded-full bg-primary/70"
                style={{ width: `${Math.round((group.count / max) * 100)}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ActionsWidgetBody({
  apiClient,
  widget,
}: {
  apiClient: ApiClient | undefined;
  widget: Extract<MyDayWidget, { apiBasePath: string; collection: string }>;
}) {
  const locale = useAppLocale();
  const uiLocale = intlLocale(locale);
  const t = useMessages(widgetMessages);
  const metadata = useWidgetSchema(apiClient, widget);
  const schema = metadata.status === "ready" ? metadata.schema : null;
  const detected = schema ? autoDetectWidgetConfig(schema) : {};
  const dateField = widget.config?.dateField ?? detected.dateField;
  const limit = widget.config?.limit ?? 5;
  const unsupported = schema?.sortSupported === false;
  const [items, failed, setItems, failure] = useWidgetResult<
    {
      id: string;
      title: string;
      day: string;
      bucket: "overdue" | "today" | "week";
    }[]
  >(metadata.scope, metadata.schemaRevision, dateField ?? "");
  const { nonce, retryAt, retryDisabled, retry, rateLimitMessage } =
    useWidgetRefresh(metadata.scope, {
      failure,
      hubspot: schema?.hubspot,
      uiLocale,
    });
  const isRateLimited = useEffectEvent(() => retryIsBlocked(retryAt));

  useEffect(() => {
    if (!apiClient || !schema || unsupported || !dateField || isRateLimited())
      return;
    const controller = new AbortController();
    const { signal } = controller;
    setItems();
    void listWidgetRecordsForReview(apiClient, widget, dateField, {
      signal,
    }).then(
      (page) => {
        if (signal.aborted) return;
        setItems({
          data: bucketActionItems(page.data, dateField).map((entry) => ({
            id: String(entry.record.id),
            title: recordTitle(entry.record, schema),
            day: entry.day,
            bucket: entry.bucket,
          })),
        });
      },
      (error: unknown) => {
        if (!signal.aborted) setItems({ error });
      },
    );
    return () => controller.abort();
  }, [apiClient, widget, schema, unsupported, dateField, nonce, setItems]);

  if (metadata.status !== "ready")
    return <WidgetSchemaFallback {...metadata} />;
  if (!dateField)
    return (
      <p className="text-sm text-muted-foreground">
        {t("This collection has no date field for due dates.")}
      </p>
    );
  if (unsupported)
    return (
      <p className="text-sm text-muted-foreground">
        {t("This source cannot sort records by due date.")}
      </p>
    );
  const error = rateLimitMessage ?? t("Could not load these actions.");
  if (failed && !items)
    return (
      <WidgetError
        message={error}
        onRetry={retry}
        retryDisabled={retryDisabled}
      />
    );
  if (!items) return <WidgetSkeleton />;
  const refreshStatus = (
    <WidgetRefreshStatus
      metadata={metadata}
      error={failed ? error : undefined}
      onRetry={retry}
      retryDisabled={retryDisabled}
    />
  );
  if (items.length === 0)
    return (
      <>
        {refreshStatus}
        <p className="text-sm text-muted-foreground">
          {t("Nothing is due in the next 7 days.")}
        </p>
      </>
    );

  const overdue = items.filter((item) => item.bucket === "overdue").length;

  return (
    <div className="space-y-3">
      {refreshStatus}
      {overdue > 0 ? (
        <p className="text-sm font-medium text-destructive">
          {new Intl.NumberFormat(uiLocale).format(overdue)}{" "}
          {overdue === 1 ? t("overdue_one") : t("overdue_many")}
        </p>
      ) : null}
      <ul className="divide-y rounded-lg border">
        {items.slice(0, limit).map((item) => (
          <li
            key={item.id}
            className="flex items-center justify-between gap-2 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{item.title}</p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {formatActionDay(item.day, uiLocale)}
              </p>
            </div>
            <Badge
              variant={
                item.bucket === "overdue"
                  ? "destructive"
                  : item.bucket === "today"
                    ? "default"
                    : "secondary"
              }
              className="shrink-0"
            >
              {t(
                item.bucket === "overdue"
                  ? "Overdue"
                  : item.bucket === "today"
                    ? "Today"
                    : "This week",
              )}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

function isBuiltInWidget(widget: MyDayWidget): boolean {
  return (
    widget.kind === "summary" ||
    widget.kind === "items" ||
    widget.kind === "chart" ||
    widget.kind === "actions"
  );
}

function isCollectionWidget(
  widget: MyDayWidget,
): widget is Extract<MyDayWidget, { apiBasePath: string }> {
  return "apiBasePath" in widget && "collection" in widget;
}

export function WidgetCard({
  apiClient,
  widget,
  collectionLabel,
  agenda,
  quickTask,
  mail,
  onCompose,
  onRemove,
  onMove,
  isFirst,
  isLast,
  disabled,
  dragHandle,
}: {
  apiClient: ApiClient | undefined;
  widget: MyDayWidget;
  collectionLabel: string;
  mail?: MailState;
  onCompose?: () => void;
  agenda?: React.ComponentProps<typeof AgendaWidgetBody>;
  quickTask?: React.ComponentProps<typeof QuickTaskWidgetBody>;
  onRemove: (id: string) => void;
  onMove: (id: string, direction: -1 | 1) => void;
  isFirst: boolean;
  isLast: boolean;
  disabled: boolean;
  dragHandle?: React.ReactNode;
}) {
  const locale = useAppLocale();
  const t = useMessages(widgetMessages);
  const title = widget.title ?? collectionLabel;
  const pluginRef =
    typeof widget.kind === "string" ? parsePluginKind(widget.kind) : null;
  const pluginContribution = pluginRef
    ? pluginContributionFor(pluginRef)
    : undefined;
  const pluginTitle = pluginContribution
    ? (pluginContribution.title[locale] ?? pluginContribution.title.es)
    : undefined;
  const kindLabel =
    widget.kind === "summary"
      ? t("Summary")
      : widget.kind === "items"
        ? t("Items")
        : widget.kind === "chart"
          ? t("Chart")
          : widget.kind === "actions"
            ? t("Actions")
            : widget.kind === "agenda"
              ? t("Agenda")
              : widget.kind === "quick_task"
                ? t("Quick task")
                : widget.kind === "mail"
                  ? t("Inbox")
                  : widget.kind === "office_documents"
                    ? t("Office documents")
                    : t("Preview");
  const isPlugin =
    typeof widget.kind === "string" && parsePluginKind(widget.kind) !== null;
  const isSystem =
    widget.kind === "agenda" ||
    widget.kind === "quick_task" ||
    widget.kind === "mail" ||
    widget.kind === "office_documents";
  const supported = isBuiltInWidget(widget) || isSystem || isPlugin;

  return (
    <Card
      data-testid={`my-day-widget-${widget.id}`}
      className="min-w-0 gap-3 rounded-2xl border-border/60 py-4 shadow-sm transition-shadow hover:shadow-md sm:gap-6 sm:py-6"
    >
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 px-4 pb-0 sm:px-6 sm:pb-3">
        <div className="flex min-w-0 items-start gap-1.5">
          {dragHandle}
          <div className="min-w-0">
            <CardTitle className="truncate text-[15px] font-semibold tracking-tight">
              {title}
            </CardTitle>
            <p
              className={`mt-0.5 truncate text-xs text-muted-foreground ${isSystem ? "hidden" : ""}`}
            >
              {collectionLabel} · {pluginTitle ?? kindLabel}
            </p>
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground max-sm:size-11"
              aria-label={t("Widget options for %{title}", { title })}
              disabled={disabled}
            >
              ⋯
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isCollectionWidget(widget) ? (
              <DropdownMenuItem asChild>
                <a href={widgetDeepLink(widget)}>{t("Open collection")}</a>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={isFirst}
              onSelect={() => onMove(widget.id, -1)}
            >
              {t("Move before")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={isLast}
              onSelect={() => onMove(widget.id, 1)}
            >
              {t("Move after")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => onRemove(widget.id)}
              className="text-destructive"
            >
              {t("Remove widget")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </CardHeader>
      <CardContent className="px-4 pt-0 sm:px-6">
        {!supported ? (
          <p className="text-sm text-muted-foreground">
            {t(
              "This widget type will be available soon. In the meantime, open the full collection.",
            )}
          </p>
        ) : widget.kind === "mail" && mail ? (
          <MailWidgetBody mail={mail} onCompose={onCompose ?? (() => {})} />
        ) : widget.kind === "agenda" ? (
          agenda ? (
            <AgendaWidgetBody agenda={agenda.agenda} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("Connect your calendar to see your agenda here.")}
            </p>
          )
        ) : widget.kind === "quick_task" ? (
          quickTask ? (
            <QuickTaskWidgetBody
              agenda={quickTask.agenda}
              personalIntegrations={quickTask.personalIntegrations}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("Connect your calendar to create tasks here.")}
            </p>
          )
        ) : widget.kind === "office_documents" ? (
          <OfficeDocumentsWidgetBody apiClient={apiClient} />
        ) : isPlugin && isCollectionWidget(widget) ? (
          <PluginWidgetBody apiClient={apiClient} widget={widget} />
        ) : widget.kind === "summary" && isCollectionWidget(widget) ? (
          <SummaryWidgetBody apiClient={apiClient} widget={widget} />
        ) : widget.kind === "items" && isCollectionWidget(widget) ? (
          <ItemsWidgetBody apiClient={apiClient} widget={widget} />
        ) : widget.kind === "chart" && isCollectionWidget(widget) ? (
          <ChartWidgetBody apiClient={apiClient} widget={widget} />
        ) : isCollectionWidget(widget) ? (
          <ActionsWidgetBody apiClient={apiClient} widget={widget} />
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("Could not show this widget.")}
          </p>
        )}
      </CardContent>
      {isCollectionWidget(widget) ? (
        <CardFooter className="pt-1">
          <a
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            href={widgetDeepLink(widget)}
            aria-label={t("View all %{collection}", {
              collection: collectionLabel,
            })}
          >
            {t("View all")} <ExternalLink className="size-3.5" />
          </a>
        </CardFooter>
      ) : null}
    </Card>
  );
}

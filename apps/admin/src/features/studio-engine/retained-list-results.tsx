import { intlLocale, useAppLocale, useMessages } from "@/i18n/core";
import { recordsMessages } from "@/i18n/locales/records";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useReducer, type ReactNode } from "react";
import { ListContextProvider, useListContext, type RaRecord } from "ra-core";
import { Button } from "@/components/ui/button";
import { formatRetryTime, retryDeadlineFromError } from "@/api/retry-after";
import { retryIsBlocked, useRetryBlocked } from "@/hooks/use-retry-blocked";

export type RecordListTotal =
  | { status: "verified"; total: number | undefined }
  | { status: "unavailable" | "rate-limited" | "revoked" };

/** Retain one successful page within its authorization/collection scope. */
export function RetainedListResults({
  scope,
  children,
  onListTotal,
}: {
  scope: string;
  children: ReactNode;
  onListTotal?: (result: RecordListTotal) => void;
}) {
  const t = useMessages(recordsMessages);
  const locale = useAppLocale();

  const context = useListContext();
  const saved = useRef<
    { scope: string; data: RaRecord[]; total: number | undefined } | undefined
  >(undefined);
  const queryClient = useQueryClient();
  const revoked = useRef(new WeakSet<RaRecord[]>());
  const currentData = useRef(context.data);
  currentData.current = context.data;
  const [, refresh] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const cache = queryClient.getQueryCache();
    const resource = context.resource;
    // Keep the origin of each result after a reset clears the query's data.
    const sourceByRows = new WeakMap<RaRecord[], string>();
    for (const query of cache.findAll({ queryKey: [resource, "getList"] })) {
      const result = query.state.data as { data?: RaRecord[] } | undefined;
      if (result?.data) sourceByRows.set(result.data, query.queryHash);
    }
    return cache.subscribe((event) => {
      const { query } = event;
      if (query.queryKey[0] !== resource || query.queryKey[1] !== "getList")
        return;
      const result = query.state.data as { data?: RaRecord[] } | undefined;
      if (result?.data) sourceByRows.set(result.data, query.queryHash);
      if (
        event.type === "updated" &&
        event.action.type === "success" &&
        !event.action.manual &&
        result?.data &&
        revoked.current.delete(result.data)
      )
        refresh();

      const reset =
        event.type === "updated" &&
        event.action.type === "setState" &&
        query.state.data === undefined;
      if (event.type !== "removed" && !reset) return;
      // RA can expose a placeholder after its source query has been cleared.
      const affected = [currentData.current, saved.current?.data].filter(
        (rows): rows is RaRecord[] =>
          rows !== undefined && sourceByRows.get(rows) === query.queryHash,
      );
      if (!affected.length) return;
      for (const rows of affected) revoked.current.add(rows);
      if (saved.current && revoked.current.has(saved.current.data))
        saved.current = undefined;
      refresh();
    });
  }, [queryClient, context.resource]);
  const currentRevoked =
    context.data !== undefined && revoked.current.has(context.data);
  const failure = context.error as
    { status?: number; code?: string } | undefined;
  const status = failure?.status;
  const retryAt = retryDeadlineFromError(context.error);
  const retryBlocked = useRetryBlocked(retryAt);
  const retryTime = retryBlocked
    ? formatRetryTime(context.error, intlLocale(locale))
    : undefined;
  const denied = status === 401 || status === 403;
  const disconnected = failure?.code === "HUBSPOT_CONNECTION_UNAVAILABLE";
  const invalidated = denied || disconnected;
  // Only invalidate on a new failure or data change. The query cache can
  // report a successful retry before the list context clears its error.
  useEffect(() => {
    if (!invalidated) return;
    if (context.data) revoked.current.add(context.data);
    if (saved.current) revoked.current.add(saved.current.data);
    saved.current = undefined;
  }, [invalidated, scope, context.data, context.error]);
  useEffect(() => {
    // Clear the reported total when the records that verified it are inaccessible.
    if (invalidated || currentRevoked) onListTotal?.({ status: "revoked" });
    else if (context.error)
      onListTotal?.({
        status: status === 429 ? "rate-limited" : "unavailable",
      });
    if (saved.current?.scope !== scope) saved.current = undefined;
    if (
      !currentRevoked &&
      !invalidated &&
      !context.error &&
      !context.isPending &&
      !context.isPlaceholderData &&
      context.data !== undefined
    ) {
      saved.current = { scope, data: context.data, total: context.total };
      const validTotal =
        typeof context.total === "number" &&
        Number.isSafeInteger(context.total) &&
        context.total >= 0;
      onListTotal?.({
        status: "verified",
        total: validTotal ? context.total : undefined,
      });
    }
  }, [
    scope,
    currentRevoked,
    invalidated,
    onListTotal,
    status,
    context.data,
    context.total,
    context.error,
    context.isPending,
    context.isPlaceholderData,
  ]);
  if (denied) return <p role="alert">{context.error?.message}</p>;
  const previous = saved.current?.scope === scope ? saved.current : undefined;
  const current = currentRevoked ? undefined : context.data;
  const retained = current === undefined && previous !== undefined;
  const data = current ?? previous?.data;
  const updating = context.isFetching || context.isPlaceholderData;
  const readOnly = Boolean(
    context.error || context.isPlaceholderData || retained,
  );
  return (
    <>
      <div
        role="status"
        aria-live="polite"
        className="min-h-6 text-xs text-muted-foreground"
      >
        {updating
          ? t("Actualizando resultados…")
          : readOnly && !disconnected
            ? t("Mostrando los últimos resultados disponibles.")
            : ""}
      </div>
      {context.error && (
        <div
          role="alert"
          className="flex items-center gap-2 py-2 text-sm text-destructive"
        >
          <span>
            {context.error.message}
            {retryTime && (
              <>
                {" "}
                {t("Puedes reintentar a partir de %{p0}.", {
                  p0: retryTime,
                })}
              </>
            )}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={context.isFetching || retryBlocked}
            onClick={() => {
              if (!context.isFetching && !retryIsBlocked(retryAt))
                void context.refetch();
            }}
          >
            {t("Reintentar")}
          </Button>
        </div>
      )}
      <ListContextProvider
        value={
          {
            ...context,
            ...(currentRevoked
              ? {
                  data: undefined,
                  total: undefined,
                  isPending: !context.error,
                  isLoading: !context.error,
                }
              : {}),
            ...(data !== undefined
              ? {
                  data,
                  total: retained ? previous?.total : context.total,
                  isPending: false,
                  isLoading: false,
                  error: null,
                }
              : {}),
          } as typeof context
        }
      >
        <div aria-busy={Boolean(updating)} inert={readOnly || undefined}>
          {!disconnected && children}
        </div>
      </ListContextProvider>
    </>
  );
}

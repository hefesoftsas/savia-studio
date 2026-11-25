import type { QueryClient } from "@tanstack/react-query";
import type { RealtimeChangeEvent } from "./use-realtime";

type ListPage = {
  data: unknown[];
  total?: number;
  pageInfo?: { hasNextPage?: boolean; hasPreviousPage?: boolean };
};

function rowId(row: unknown): string | undefined {
  if (typeof row !== "object" || row === null) return undefined;
  const id = (row as { id?: unknown }).id;
  return id === undefined || id === null ? undefined : String(id);
}

/**
 * Removes known deleted rows from cached lists immediately. Complete lists
 * need no refetch. Partial pages are invalidated so the server can backfill
 * shifted rows and correct totals on pages that did not contain the deletion.
 * Other events invalidate the affected resource prefix.
 *
 * Never throws: on any doubt it falls back to invalidating.
 */
export function applyRealtimeListEvent(
  queryClient: QueryClient,
  queryKeyPrefix: string,
  event: RealtimeChangeEvent,
): void {
  const invalidate = () => {
    void queryClient
      .invalidateQueries({ queryKey: [queryKeyPrefix] })
      .catch(() => undefined);
  };
  try {
    if (event.type !== "deleted" || event.id === undefined) {
      invalidate();
      return;
    }
    const targetId = String(event.id);
    let removed = false;
    let needsRefetch = false;
    queryClient.setQueriesData<ListPage>(
      { queryKey: [queryKeyPrefix, "getList"] },
      (previous) => {
        if (!previous || !Array.isArray(previous.data)) {
          needsRefetch = true;
          return previous;
        }
        if (
          previous.total !== previous.data.length ||
          previous.pageInfo?.hasNextPage ||
          previous.pageInfo?.hasPreviousPage
        )
          needsRefetch = true;
        const data = previous.data.filter((row) => rowId(row) !== targetId);
        if (data.length === previous.data.length) return previous;
        removed = true;
        return {
          ...previous,
          data,
          ...(typeof previous.total === "number"
            ? { total: previous.total - (previous.data.length - data.length) }
            : {}),
        };
      },
    );
    if (!removed || needsRefetch) invalidate();
  } catch {
    invalidate();
  }
}

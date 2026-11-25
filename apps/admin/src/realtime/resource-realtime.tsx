import { useQueryClient } from "@tanstack/react-query";
import { useDataProvider, useRecordContext, useRedirect } from "ra-core";
import { useEffect, useRef } from "react";
import { useFormContext, useFormState } from "react-hook-form";
import { isReadAccessDenied } from "@/queries/read-state";
import type { RealtimeChangeEvent } from "./use-realtime";
import {
  useRealtimeRefresh,
  RemoteChangesNotice,
} from "./use-realtime-refresh";

type ResourceSyncProps = {
  resource: "users" | "tenants";
  subscription?: Pick<
    Parameters<typeof useRealtimeRefresh>[0],
    "topics" | "tenantId" | "enabled" | "accepts"
  >;
};

function useRecordSubscription({ resource, subscription }: ResourceSyncProps) {
  const recordId = useRecordContext()?.id;
  return {
    topics: [resource],
    ...subscription,
    refreshScope: recordId === undefined ? undefined : String(recordId),
    accepts: (event: RealtimeChangeEvent) => {
      if (
        recordId !== undefined &&
        event.id !== undefined &&
        String(event.id) !== String(recordId)
      )
        return false;
      return subscription?.accepts?.(event) ?? true;
    },
  };
}

export function ResourceReadSync({
  resource,
  subscription,
}: ResourceSyncProps) {
  const cache = useQueryClient();
  const recordSubscription = useRecordSubscription({ resource, subscription });
  useRealtimeRefresh({
    ...recordSubscription,
    refresh: () => cache.invalidateQueries({ queryKey: [resource] }),
  });
  return null;
}
export function ResourceEditSync({
  resource,
  subscription,
}: ResourceSyncProps) {
  const cache = useQueryClient();
  const form = useFormContext();
  const dataProvider = useDataProvider();
  const redirect = useRedirect();
  const recordId = useRecordContext()?.id;
  const recordQueryKey = [resource, "getOne", { id: String(recordId) }];
  const recordRead = useRef<AbortController>(null);
  useEffect(() => {
    const controller = new AbortController();
    recordRead.current = controller;
    return () => controller.abort();
  }, [resource, recordId]);
  const { isDirty, isSubmitting } = useFormState();
  const recordSubscription = useRecordSubscription({ resource, subscription });
  const remote = useRealtimeRefresh({
    ...recordSubscription,
    blocked: isDirty || isSubmitting,
    refresh: async () => {
      const signal = recordRead.current?.signal;
      if (recordId === undefined || !signal || signal.aborted) return;
      try {
        // A failed read must not replace the active edit query with an error.
        const { data } = await dataProvider.getOne(resource, {
          id: recordId,
          signal,
        });
        if (signal.aborted) return;
        void cache.invalidateQueries({
          queryKey: [resource],
          refetchType: "none",
        });
        cache.setQueryData(recordQueryKey, data);
      } catch (error) {
        if (signal.aborted) return;
        if (
          isReadAccessDenied(error) ||
          (typeof error === "object" &&
            error !== null &&
            "status" in error &&
            error.status === 404)
        )
          redirect("list", resource);
        throw error;
      }
    },
  });
  return (
    <RemoteChangesNotice
      key={recordId}
      changed={remote.changed}
      disabled={isSubmitting}
      reload={async () => {
        let editedDuringReload = false;
        const unsubscribe = form.subscribe({
          formState: { values: true },
          callback: ({ type }) => {
            if (type === "change") editedDuringReload = true;
          },
        });
        try {
          if ((await remote.reload()) && !editedDuringReload) {
            form.reset(cache.getQueryData(recordQueryKey));
          }
        } finally {
          unsubscribe();
        }
      }}
    />
  );
}

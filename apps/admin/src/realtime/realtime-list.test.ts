import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { applyRealtimeListEvent } from "./realtime-list";

function clientWithList() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(["users", "getList", {}], {
    data: [
      { id: "p-1", displayName: "Uno" },
      { id: "p-2", displayName: "Dos" },
    ],
    total: 2,
  });
  return queryClient;
}

describe("applyRealtimeListEvent", () => {
  it("removes a deleted row surgically without refetching", () => {
    const queryClient = clientWithList();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    applyRealtimeListEvent(queryClient, "users", {
      topic: "users",
      type: "deleted",
      id: "p-1",
    });

    expect(queryClient.getQueryData(["users", "getList", {}])).toEqual({
      data: [{ id: "p-2", displayName: "Dos" }],
      total: 1,
    });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("matches numeric and string ids interchangeably", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["tenants", "getList", {}], {
      data: [{ id: 101, name: "Acme" }],
      total: 1,
    });

    applyRealtimeListEvent(queryClient, "tenants", {
      topic: "tenants",
      type: "deleted",
      id: "101",
    });

    expect(queryClient.getQueryData(["tenants", "getList", {}])).toEqual({
      data: [],
      total: 0,
    });
  });

  it("backfills the visible tenant page and invalidates the other pages after a deletion", async () => {
    const queryClient = new QueryClient();
    const firstPage = [
      "tenants",
      "getList",
      { pagination: { page: 1, perPage: 2 } },
    ];
    const secondPage = [
      "tenants",
      "getList",
      { pagination: { page: 2, perPage: 2 } },
    ];
    const deleted = { id: 101 };
    const second = { id: 102 };
    const third = { id: 103 };
    queryClient.setQueryData(firstPage, { data: [deleted, second], total: 3 });
    queryClient.setQueryData(secondPage, { data: [third], total: 3 });
    const loadPage = vi
      .fn()
      .mockResolvedValue({ data: [second, third], total: 2 });
    const observer = new QueryObserver(queryClient, {
      queryKey: firstPage,
      queryFn: loadPage,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      applyRealtimeListEvent(queryClient, "tenants", {
        topic: "tenants",
        type: "deleted",
        id: deleted.id,
      });

      expect(queryClient.getQueryData(firstPage)).toEqual({
        data: [second],
        total: 2,
      });
      expect(queryClient.getQueryState(secondPage)?.isInvalidated).toBe(true);
      await vi.waitFor(() =>
        expect(queryClient.getQueryData(firstPage)).toEqual({
          data: [second, third],
          total: 2,
        }),
      );
      expect(loadPage).toHaveBeenCalledTimes(1);
    } finally {
      unsubscribe();
      queryClient.clear();
    }
  });

  it("refetches once for creates, updates and unknown ids", () => {
    const queryClient = clientWithList();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    applyRealtimeListEvent(queryClient, "users", {
      topic: "users",
      type: "created",
      id: "p-3",
    });
    applyRealtimeListEvent(queryClient, "users", {
      topic: "users",
      type: "updated",
      id: "p-2",
    });
    applyRealtimeListEvent(queryClient, "users", {
      topic: "users",
      type: "deleted",
      id: "missing",
    });

    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["users"] });
    // Unknown shapes are left untouched for the refetch to fix.
    expect(queryClient.getQueryData(["users", "getList", {}])).toEqual({
      data: [
        { id: "p-1", displayName: "Uno" },
        { id: "p-2", displayName: "Dos" },
      ],
      total: 2,
    });
  });

  it("never throws on malformed caches", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["users", "getList", {}], {
      data: "not-an-array",
      total: 1,
    });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(() =>
      applyRealtimeListEvent(queryClient, "users", {
        topic: "users",
        type: "deleted",
        id: "p-1",
      }),
    ).not.toThrow();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

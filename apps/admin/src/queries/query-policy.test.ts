import { describe, expect, it, vi } from "vitest";
import { readKey } from "./query-keys";
import { createAdminQueryClient } from "./query-policy";

describe("createAdminQueryClient", () => {
  it("preserves the shared admin query and mutation defaults", () => {
    const client = createAdminQueryClient();
    const defaults = client.getDefaultOptions();

    expect(defaults.queries).toMatchObject({
      networkMode: "always",
      retry: expect.any(Function),
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
    });
    expect(defaults.mutations).toMatchObject({
      networkMode: "always",
      retry: false,
    });
  });

  it("shares one in-flight read for identical scoped keys", async () => {
    const client = createAdminQueryClient();
    const queryKey = readKey(
      { sessionGeneration: 1, kind: "tenant", id: "tenant-2" },
      "records",
      { page: 1 },
    );
    let resolveRead: ((value: string[]) => void) | undefined;
    let calls = 0;
    const queryFn = () => {
      calls += 1;
      return new Promise<string[]>((resolve) => {
        resolveRead = resolve;
      });
    };

    const first = client.fetchQuery({ queryKey, queryFn });
    const second = client.fetchQuery({ queryKey: [...queryKey], queryFn });
    expect(calls).toBe(1);

    resolveRead?.([]);
    await expect(Promise.all([first, second])).resolves.toEqual([[], []]);
  });
});

it.each([401, 403, 429])(
  "stops after status %s without automatically repeating the request",
  async (status) => {
    const client = createAdminQueryClient();
    const queryKey = readKey(
      { sessionGeneration: 1, kind: "tenant", id: "2" },
      "records",
    );
    client.setQueryData(queryKey, ["protected row"]);
    const error = Object.assign(new Error("Request rejected"), { status });
    const queryFn = vi.fn().mockRejectedValue(error);
    await expect(
      client.fetchQuery({
        queryKey,
        staleTime: 0,
        retryDelay: 0,
        queryFn,
      }),
    ).rejects.toBe(error);
    expect(queryFn).toHaveBeenCalledOnce();
    expect(client.getQueryData(queryKey)).toEqual(
      status === 429 ? ["protected row"] : undefined,
    );
    expect(client.getQueryState(queryKey)?.error).toBe(error);
    client.clear();
  },
);

it("still retries an ordinary temporary failure once", async () => {
  const client = createAdminQueryClient();
  const queryFn = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("Unavailable"), { status: 503 }),
    )
    .mockResolvedValueOnce(["recovered"]);
  await expect(
    client.fetchQuery({
      queryKey: ["records", "transient-retry"],
      retryDelay: 0,
      queryFn,
    }),
  ).resolves.toEqual(["recovered"]);
  expect(queryFn).toHaveBeenCalledTimes(2);
  client.clear();
});

it("retains loaded data on a temporary read failure", async () => {
  const client = createAdminQueryClient();
  const queryKey = ["records", "temporary"];
  client.setQueryData(queryKey, ["last successful row"]);
  await expect(
    client.fetchQuery({
      queryKey,
      staleTime: 0,
      retry: false,
      queryFn: async () => {
        throw Object.assign(new Error("Offline"), { status: 503 });
      },
    }),
  ).rejects.toThrow("Offline");
  expect(client.getQueryData(queryKey)).toEqual(["last successful row"]);
  client.clear();
});

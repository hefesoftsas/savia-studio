import { beforeEach, describe, expect, it, vi } from "vitest";
import { rotateSessionScope } from "@/auth/session-scope";
import type { ApiClient } from "./api-client";
import {
  fetchTenantWorkspaces,
  invalidateTenantWorkspaces,
  type TenantWorkspace,
} from "./tenant-workspaces-client";

const workspaces: TenantWorkspace[] = [
  {
    id: "tenant:0",
    tenantId: 0,
    label: "Platform",
    kind: "platform",
    apiBasePath: "/v1/studio/0",
  },
  {
    id: "tenant:7",
    tenantId: 7,
    label: "North",
    kind: "tenant",
    apiBasePath: "/v1/studio/7",
  },
];

describe("tenant workspace catalog", () => {
  beforeEach(invalidateTenantWorkspaces);

  it("fetches the authorized tenant workspace catalog", async () => {
    const get = vi.fn().mockResolvedValue({ data: workspaces });
    const client = { get } as unknown as ApiClient;

    await expect(fetchTenantWorkspaces(client)).resolves.toEqual(workspaces);
    expect(get).toHaveBeenCalledWith("/v1/tenant-workspaces");
  });

  it("deduplicates concurrent catalog requests and caches the result", async () => {
    let resolveGet!: (value: { data: TenantWorkspace[] }) => void;
    const get = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    const client = { get } as unknown as ApiClient;

    const first = fetchTenantWorkspaces(client);
    const second = fetchTenantWorkspaces(client);
    resolveGet({ data: workspaces });

    await expect(Promise.all([first, second])).resolves.toEqual([
      workspaces,
      workspaces,
    ]);
    await fetchTenantWorkspaces(client);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("only shares the cached workspace list with callers using the same client", async () => {
    const first = {
      get: vi.fn().mockResolvedValue({ data: workspaces }),
    } as unknown as ApiClient;
    const second = {
      get: vi.fn().mockResolvedValue({ data: [] }),
    } as unknown as ApiClient;

    await expect(fetchTenantWorkspaces(first)).resolves.toEqual(workspaces);
    await expect(fetchTenantWorkspaces(second)).resolves.toEqual([]);
    await expect(fetchTenantWorkspaces(first)).resolves.toEqual(workspaces);
    expect(first.get).toHaveBeenCalledTimes(1);
    expect(second.get).toHaveBeenCalledTimes(1);
  });

  it.each(["invalidation", "account change"])(
    "discards a pending workspace read from before %s",
    async (change) => {
      let resolveOld!: (result: { data: TenantWorkspace[] }) => void;
      let resolveCurrent!: (result: { data: TenantWorkspace[] }) => void;
      const oldResponse = new Promise<{ data: TenantWorkspace[] }>(
        (resolve) => {
          resolveOld = resolve;
        },
      );
      const newResponse = new Promise<{ data: TenantWorkspace[] }>(
        (resolve) => {
          resolveCurrent = resolve;
        },
      );
      const get = vi
        .fn()
        .mockReturnValueOnce(oldResponse)
        .mockReturnValue(newResponse);
      const client = { get } as unknown as ApiClient;

      const previous = fetchTenantWorkspaces(client);
      const obsolete = expect(previous).rejects.toMatchObject({
        name: "AbortError",
      });
      if (change === "invalidation") invalidateTenantWorkspaces();
      else rotateSessionScope("principal-change");
      const current = fetchTenantWorkspaces(client);
      resolveOld({ data: workspaces });
      await obsolete;

      const concurrent = fetchTenantWorkspaces(client);
      resolveCurrent({ data: [] });
      await expect(Promise.all([current, concurrent])).resolves.toEqual([
        [],
        [],
      ]);
      await expect(fetchTenantWorkspaces(client)).resolves.toEqual([]);
      expect(get).toHaveBeenCalledTimes(2);
    },
  );
});

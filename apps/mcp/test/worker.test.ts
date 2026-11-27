import { describe, expect, it, vi } from "vitest";
import worker from "../src/worker";

describe("Savia MCP Cloudflare Worker", () => {
  it("exposes tools over stateless HTTP after legacy initialization", async () => {
    const env = {
      SAVIA_API_URL: "https://api.test",
      SAVIA_MCP_SHARED_SECRET: "discovery-test-secret",
    };
    const send = (body: unknown) =>
      worker.fetch(
        new Request("https://savia-mcp.internal/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-03-26",
            "x-savia-mcp-secret": env.SAVIA_MCP_SHARED_SECRET,
            "x-savia-user-authorization": "Bearer discovery-user",
          },
          body: JSON.stringify(body),
        }),
        env,
      );
    const initialized = await send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "discovery-test", version: "1" },
      },
    });
    expect(initialized.status).toBe(200);
    expect(await initialized.text()).toContain("capabilities");
    const listed = await send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.text();
    expect(listedBody).toContain("savia_list_studio_collections");
    expect(listedBody).toContain("savia_list_crm_collections");
  });

  it("rejects requests when credentials are missing or invalid", async () => {
    const env = {
      SAVIA_API_URL: "https://api.test",
      SAVIA_MCP_SHARED_SECRET: "test-secret-123",
    };

    // Missing headers
    const res1 = await worker.fetch(
      new Request("https://savia-mcp.internal/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(res1.status).toBe(401);

    // Bad secret
    const res2 = await worker.fetch(
      new Request("https://savia-mcp.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-savia-mcp-secret": "wrong-secret",
          "x-savia-user-authorization": "Bearer user-token-abc",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      env,
    );
    expect(res2.status).toBe(401);
  });

  it("authenticates delegated requests and executes CRM tools with the user token", async () => {
    let capturedAuth: string | undefined;
    const mockApiFetch = vi.fn().mockImplementation((url, init) => {
      capturedAuth =
        init?.headers?.get?.("authorization") ?? init?.headers?.authorization;
      return new Response(
        JSON.stringify({
          data: [
            {
              name: "customers",
              label: "Clientes",
              total: 5,
              kind: "crm",
              installed: true,
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const env = {
      SAVIA_API_URL: "https://savia.hefesoft.com",
      SAVIA_MCP_SHARED_SECRET: "test-secret-123",
      API: { fetch: mockApiFetch as typeof fetch },
    };

    const res = await worker.fetch(
      new Request("https://savia-mcp.internal/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-savia-mcp-secret": "test-secret-123",
          "x-savia-user-authorization": "Bearer my-secret-jwt-token",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "savia_list_crm_collections",
            arguments: { all: true },
          },
        }),
      }),
      env,
    );

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("customers");
    expect(capturedAuth).toBe("Bearer my-secret-jwt-token");
  });

  it("keeps a trusted tenant fixed across calls when the active tenant changes", async () => {
    let activeTenantId = 12;
    let originalTenantAccessible = true;
    const paths: string[] = [];
    const apiFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer scoped-user-token",
        );
        if (url.pathname === "/v1/assistant/active-tenant") {
          return Response.json({ activeTenantId });
        }
        if (url.pathname === "/v1/studio/12/api/objects")
          return originalTenantAccessible
            ? Response.json({ data: [{ name: "original-tenant-objects" }] })
            : Response.json({ error: "Tenant access denied" }, { status: 403 });
        expect(url.pathname).toBe("/v1/studio/44/api/objects");
        return Response.json({ data: [{ name: "new-tenant-objects" }] });
      },
    );
    const env = {
      SAVIA_API_URL: "https://savia.test",
      SAVIA_MCP_SHARED_SECRET: "tenant-secret",
      API: { fetch: apiFetch as typeof fetch },
    };
    const invoke = (studioTenantId: number) =>
      worker.fetch(
        new Request("https://savia-mcp.internal/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-savia-mcp-secret": "tenant-secret",
            "x-savia-user-authorization": "Bearer scoped-user-token",
            "x-savia-mcp-tenant-id": String(studioTenantId),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "savia_list_crm_collections",
              arguments: { all: true },
            },
          }),
        }),
        env,
      );

    const first = await invoke(12);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("original-tenant-objects");

    activeTenantId = 44;
    originalTenantAccessible = false;
    const second = await invoke(12);
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Tenant access denied");

    const nextTurn = await invoke(44);
    expect(nextTurn.status).toBe(200);
    expect(await nextTurn.text()).toContain("new-tenant-objects");
    expect(paths).toEqual([
      "/v1/studio/12/api/objects",
      "/v1/studio/12/api/objects",
      "/v1/studio/44/api/objects",
    ]);
  });
});

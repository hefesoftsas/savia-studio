import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

const migrationSqls = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
)
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([, sql]) => sql);

function migrationStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) =>
      statement
        .replace(/^--.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

async function applyMigrations() {
  for (const migration of migrationSqls) {
    for (const statement of migrationStatements(migration)) {
      await env.DB.exec(statement);
    }
  }
}

const adminClient = {
  clientId: "savia-admin-client",
  redirectUri: "http://127.0.0.1:5173/auth/callback",
  resource: "http://127.0.0.1:8787",
  scopes: ["openid", "profile", "email", "savia.api.read", "savia.api.write"],
};

describe("admin OAuth bridge", () => {
  beforeAll(applyMigrations);
  beforeEach(async () => {
    await env.DB.exec("DELETE FROM admin_oauth_transactions");
    await env.DB.exec("DELETE FROM admin_oauth_session_origins");
  });

  it("rotates an HttpOnly refresh cookie for the admin OAuth session", async () => {
    const authFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/_internal/oauth/admin-client") {
        return Response.json(adminClient);
      }
      if (url.pathname === "/api/auth/oauth2/authorize") {
        return Response.json({
          redirect: true,
          url: `/api/auth/login?${url.searchParams.toString()}`,
        });
      }
      if (url.pathname === "/api/auth/oauth2/token") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("content-type")).toContain(
          "application/x-www-form-urlencoded",
        );
        const input = await request.formData();
        expect(input.get("client_id")).toBe(adminClient.clientId);
        if (input.get("grant_type") === "authorization_code") {
          expect(input.get("code")).toBe("authorization-code");
          expect(input.get("redirect_uri")).toBe(adminClient.redirectUri);
          expect(input.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
          expect(input.get("resource")).toBe(adminClient.resource);
          return Response.json({
            access_token: "access-token",
            refresh_token: "refresh-token",
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid savia.api.read savia.api.write",
          });
        }
        expect(input.get("grant_type")).toBe("refresh_token");
        expect(input.get("refresh_token")).toBe("refresh-token");
        expect(input.get("resource")).toBe(adminClient.resource);
        return Response.json({
          access_token: "renewed-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid savia.api.read savia.api.write",
        });
      }
      if (url.pathname === "/api/auth/sign-out") {
        expect(request.method).toBe("POST");
        expect(request.headers.get("cookie")).toContain(
          "savia.session_token=provider-session",
        );
        expect(request.headers.get("origin")).toBe("http://127.0.0.1:5173");
        expect(request.headers.get("content-type")).toContain(
          "application/json",
        );
        expect(await request.json()).toEqual({});
        return Response.json({ success: true });
      }
      return new Response("Not found", { status: 404 });
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      { fetch: authFetch },
    );

    const authorization = await app.request(
      "http://127.0.0.1:8787/api/auth/admin/authorize",
    );

    expect(authorization.status).toBe(302);
    expect(authorization.headers.get("cache-control")).toBe("no-store");
    const timing = authorization.headers.get("server-timing");
    expect(typeof timing).toBe("string");
    expect(timing).toMatch(
      /^oauth_client;dur=\d+(?:\.\d+)?, oauth_transaction;dur=\d+(?:\.\d+)?, oauth_authorize;dur=\d+(?:\.\d+)?$/,
    );
    expect(timing).not.toMatch(/https?:|token|cookie|state=/i);
    const location = new URL(authorization.headers.get("location") ?? "");
    expect(location.pathname).toBe("/api/auth/login");
    expect(location.searchParams.get("client_id")).toBe(adminClient.clientId);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("redirect_uri")).toBe(
      adminClient.redirectUri,
    );
    expect(location.searchParams.get("resource")).toBe(adminClient.resource);
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe(
      adminClient.scopes.join(" "),
    );
    const state = location.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(location.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );

    const callback = await app.request(
      "http://127.0.0.1:8787/api/auth/admin/callback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({ code: "authorization-code", state }),
      },
    );

    expect(callback.status).toBe(200);
    expect(callback.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(callback.headers.get("cache-control")).toBe("no-store");
    expect(await callback.json()).toEqual({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 300,
      scope: "openid savia.api.read savia.api.write",
    });
    const refreshCookie = callback.headers.get("set-cookie");
    expect(refreshCookie).toContain("savia.admin_refresh_token=refresh-token");
    expect(refreshCookie).toContain("HttpOnly");
    expect(refreshCookie).toContain("SameSite=Lax");
    expect(refreshCookie).toContain("Path=/api/auth/admin");

    const refresh = await app.request(
      "http://127.0.0.1:8787/api/auth/admin/refresh",
      {
        method: "POST",
        headers: {
          cookie: "savia.admin_refresh_token=refresh-token",
          origin: "http://127.0.0.1:5173",
        },
      },
    );

    expect(refresh.status).toBe(200);
    expect(refresh.headers.get("access-control-allow-origin")).toBe(
      "http://127.0.0.1:5173",
    );
    expect(await refresh.json()).toEqual({
      access_token: "renewed-access-token",
      token_type: "Bearer",
      expires_in: 300,
      scope: "openid savia.api.read savia.api.write",
    });
    expect(refresh.headers.get("set-cookie")).toContain(
      "savia.admin_refresh_token=rotated-refresh-token",
    );

    const logout = await app.request(
      "http://127.0.0.1:8787/api/auth/admin/logout",
      {
        method: "POST",
        headers: {
          cookie:
            "savia.session_token=provider-session; savia.admin_refresh_token=refresh-token",
          origin: "http://127.0.0.1:5173",
        },
      },
    );

    expect(logout.status).toBe(204);
    expect(logout.headers.get("set-cookie")).toContain(
      "savia.admin_refresh_token=",
    );
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(logout.headers.get("set-cookie")).toContain("savia.session_token=");
    expect(logout.headers.get("set-cookie")).toContain("savia.session_data=");
    expect(logout.headers.get("set-cookie")).toContain("savia.dont_remember=");
    expect(logout.headers.get("set-cookie")).toContain("savia_two_factor=");

    const replay = await app.request(
      "http://127.0.0.1:8787/api/auth/admin/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "authorization-code", state }),
      },
    );
    expect(replay.status).toBe(400);
    expect(authFetch).toHaveBeenCalledTimes(9);
  });

  it.each([
    "generic",
    "bookings",
    "unavailable",
    "timeout",
    "upstream-503",
  ] as const)("returns a safe authorization error for %s", async (scenario) => {
    const bookings = scenario !== "generic";
    let markExchangeStarted!: () => void;
    const exchangeStarted = new Promise<void>((resolve) => {
      markExchangeStarted = resolve;
    });
    const authFetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/_internal/oauth/admin-client") {
        return Response.json(adminClient);
      }
      if (path === "/api/auth/oauth2/authorize") {
        return Response.json({
          redirect: true,
          url: `/api/auth/login?${new URL(request.url).searchParams.toString()}`,
        });
      }
      if (path === "/api/auth/oauth2/token") {
        markExchangeStarted();
        if (scenario === "unavailable") throw new Error("Auth binding offline");
        if (scenario === "timeout") return new Promise<Response>(() => {});
        if (scenario === "upstream-503")
          return new Response("Auth service offline", { status: 503 });
        return Response.json(
          {
            error: "invalid_request",
            error_description: "code verification failed",
          },
          { status: 400 },
        );
      }
      return new Response("Not found", { status: 404 });
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      { fetch: authFetch },
    );

    const tenant = "https://clinic.savia-preview.hefesoft.com";
    const authorize = new URL("http://127.0.0.1:8787/api/auth/admin/authorize");
    if (bookings) {
      authorize.searchParams.set("return_to", tenant);
      authorize.searchParams.set("resume", "bookings");
      authorize.searchParams.set(
        "booking_query",
        "tab=reservations&date=2026-11-25&ignored=1",
      );
    }
    const authorization = await app.request(authorize.href);
    const state = new URL(
      authorization.headers.get("location") ?? "",
    ).searchParams.get("state");
    if (scenario === "timeout") vi.useFakeTimers();
    let callback: Response;
    try {
      const pending = app.request(
        "http://127.0.0.1:8787/api/auth/admin/callback",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code: "authorization-code", state }),
        },
      );
      if (scenario === "timeout") {
        await exchangeStarted;
        await vi.advanceTimersByTimeAsync(10_000);
      }
      callback = await pending;
    } finally {
      if (scenario === "timeout") vi.useRealTimers();
    }

    const unavailable = scenario !== "generic" && scenario !== "bookings";
    expect(callback.status).toBe(unavailable ? 503 : 401);
    await expect(callback.json()).resolves.toEqual({
      error: {
        code: unavailable
          ? "AUTHENTICATION_UNAVAILABLE"
          : "OAUTH_TOKEN_EXCHANGE_FAILED",
        message: unavailable
          ? "Authentication service is temporarily unavailable"
          : "Better Auth rejected the authorization code (invalid_request)",
      },
      ...(bookings && {
        returnOrigin: tenant,
        returnRoute: "bookings",
        returnBookingQuery: "tab=reservations&date=2026-11-25",
      }),
    });
  });

  it.each([
    [
      "client lookup fails",
      "/_internal/oauth/admin-client",
      () => Promise.reject(new Error("provider offline")),
    ],
    [
      "client metadata is not JSON",
      "/_internal/oauth/admin-client",
      () => new Response("{"),
    ],
    [
      "client callback is malformed",
      "/_internal/oauth/admin-client",
      () => Response.json({ ...adminClient, redirectUri: "invalid" }),
    ],
    [
      "client callback is not an HTTP URL",
      "/_internal/oauth/admin-client",
      () =>
        Response.json({
          ...adminClient,
          redirectUri: "mailto:admin@example.test",
        }),
    ],
    [
      "authorization request fails",
      "/api/auth/oauth2/authorize",
      () => Promise.reject(new Error("provider offline")),
    ],
    [
      "authorization destination is malformed",
      "/api/auth/oauth2/authorize",
      () => Response.json({ redirect: true, url: "https://[" }),
    ],
  ] as const)(
    "returns a retryable authorization response when %s",
    async (_name, failurePath, failure) => {
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          fetch: async (request) => {
            const path = new URL(request.url).pathname;
            if (path === failurePath) return failure();
            if (path === "/_internal/oauth/admin-client")
              return Response.json(adminClient);
            return Response.json({ redirect: true, url: "/api/auth/login" });
          },
        },
      );

      const result = await app.request(
        "http://127.0.0.1:8787/api/auth/admin/authorize",
      );
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect(result.headers.get("location")).toBeNull();
      await expect(result.json()).resolves.toMatchObject({
        error: { code: "AUTHENTICATION_UNAVAILABLE" },
      });
    },
  );

  it("times out a stalled admin-client lookup before creating a transaction", async () => {
    const authFetch = vi.fn(() => new Promise<Response>(() => {}));
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      { fetch: authFetch },
    );

    vi.useFakeTimers();
    try {
      const pending = app.request(
        "http://127.0.0.1:8787/api/auth/admin/authorize",
      );
      await vi.advanceTimersByTimeAsync(4_000);
      const response = await pending;
      expect(response.status).toBe(503);
      expect(authFetch).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
    const transaction = await env.DB.prepare(
      "SELECT state FROM admin_oauth_transactions LIMIT 1",
    ).first();
    expect(transaction).toBeNull();
  });

  it("permits CORS and scopes cookies for allowed tenant subdomains", async () => {
    const authFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/_internal/oauth/admin-client") {
        return Response.json(adminClient);
      }
      return new Response("Not found", { status: 404 });
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      { fetch: authFetch },
    );

    // OPTIONS preflight from tenant subdomain
    const preflight = await app.request(
      "https://example-organization.savia.hefesoft.com/api/auth/admin/refresh",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://example-organization.savia.hefesoft.com",
        },
      },
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      "https://example-organization.savia.hefesoft.com",
    );
    expect(preflight.headers.get("access-control-allow-credentials")).toBe(
      "true",
    );

    // OPTIONS preflight from untrusted origin
    const rejected = await app.request(
      "https://example-organization.savia.hefesoft.com/api/auth/admin/refresh",
      {
        method: "OPTIONS",
        headers: {
          origin: "https://evil.com",
        },
      },
    );
    expect(rejected.status).toBe(204);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();

    // Refresh without token clears cookies with Domain=.savia.hefesoft.com
    const refresh = await app.request(
      "https://example-organization.savia.hefesoft.com/api/auth/admin/refresh",
      {
        method: "POST",
        headers: {
          origin: "https://example-organization.savia.hefesoft.com",
        },
      },
    );
    expect(refresh.status).toBe(401);
    const setCookie = refresh.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("Domain=.savia.hefesoft.com");
  });

  it("preserves and returns initiated tenant origin via savia.return_origin cookie", async () => {
    const authFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/_internal/oauth/admin-client") {
        return Response.json(adminClient);
      }
      if (url.pathname === "/api/auth/oauth2/authorize") {
        return Response.json({
          redirect: true,
          url: `/api/auth/login?${url.searchParams.toString()}`,
        });
      }
      if (url.pathname === "/api/auth/oauth2/token") {
        return Response.json({
          access_token: "access-token",
          refresh_token: "refresh-token",
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid savia.api.read savia.api.write",
        });
      }
      return new Response("Not found", { status: 404 });
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      { fetch: authFetch },
    );

    // 1. Authorize from tenant subdomain sets return_origin cookie with shared domain
    const authorize = await app.request(
      "https://example-organization.savia.hefesoft.com/api/auth/admin/authorize",
      {
        headers: {
          host: "example-organization.savia.hefesoft.com",
        },
      },
    );
    expect(authorize.status).toBe(302);
    const authSetCookie = authorize.headers.get("set-cookie") ?? "";
    expect(authSetCookie).toContain("savia.return_origin=");
    expect(authSetCookie).toContain(
      encodeURIComponent("https://example-organization.savia.hefesoft.com"),
    );
    expect(authSetCookie).toContain("Domain=.savia.hefesoft.com");

    const location = new URL(authorize.headers.get("location")!);
    const state = location.searchParams.get("state")!;

    // 2. Callback returns returnOrigin and clears the cookie
    const callback = await app.request(
      "https://savia.hefesoft.com/api/auth/admin/callback",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://savia.hefesoft.com",
          cookie: `savia.return_origin=${encodeURIComponent("https://example-organization.savia.hefesoft.com")}`,
        },
        body: JSON.stringify({ code: "authorization-code", state }),
      },
    );
    expect(callback.status).toBe(200);
    const payload = (await callback.json()) as { returnOrigin?: string };
    expect(payload.returnOrigin).toBe(
      "https://example-organization.savia.hefesoft.com",
    );
    const callbackSetCookie = callback.headers.get("set-cookie") ?? "";
    expect(callbackSetCookie).toContain("savia.return_origin=");
    expect(callbackSetCookie).toContain("Max-Age=0");
  });
  describe("URL-scoped sessions", () => {
    const tenantOrigin = "https://savia-team.savia-preview.hefesoft.com";
    const canonicalOrigin = "https://savia-preview.hefesoft.com";

    function fixture(callbackOrigin = canonicalOrigin) {
      let tokenNumber = 0;
      let nextRefreshResponse: (() => Response | Promise<Response>) | undefined;
      const authFetch = vi.fn(async (request: Request) => {
        const url = new URL(request.url);
        if (url.pathname === "/_internal/oauth/admin-client")
          return Response.json({
            ...adminClient,
            redirectUri: `${callbackOrigin}/auth/callback`,
          });
        if (url.pathname === "/api/auth/oauth2/authorize")
          return Response.json({
            redirect: true,
            url: `/api/auth/login?${url.searchParams}`,
          });
        if (url.pathname === "/api/auth/oauth2/token") {
          tokenNumber += 1;
          if (tokenNumber > 1 && nextRefreshResponse)
            return nextRefreshResponse();
          return Response.json({
            access_token: `access-${tokenNumber}`,
            refresh_token: `refresh-${crypto.randomUUID()}`,
            token_type: "Bearer",
            expires_in: 300,
          });
        }
        if (url.pathname === "/api/auth/sign-out")
          return Response.json({ success: true });
        return new Response("Not found", { status: 404 });
      });
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        undefined,
        undefined,
        undefined,
        { fetch: authFetch },
      );
      const cookieFrom = (response: Response) => {
        const cookie = response.headers
          .getSetCookie()
          .find(
            (value) =>
              value.startsWith("savia.admin_refresh_token") &&
              !value.includes("Max-Age=0"),
          );
        expect(cookie).toBeDefined();
        return cookie!.split(";")[0];
      };
      const signIn = async (origin: string, cookie = "", search = "") => {
        const authorize = await app.request(
          `${origin}/api/auth/admin/authorize${search}`,
        );
        expect(authorize.status).toBe(302);
        const state = new URL(
          authorize.headers.get("location")!,
        ).searchParams.get("state");
        return app.request(`${callbackOrigin}/api/auth/admin/callback`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: callbackOrigin,
            cookie,
          },
          body: JSON.stringify({ code: "authorization-code", state }),
        });
      };
      const refresh = (origin: string, cookie: string) =>
        app.request(`${origin}/api/auth/admin/refresh`, {
          method: "POST",
          headers: { origin, cookie },
        });
      const respondToNextRefresh = (
        response: () => Response | Promise<Response>,
      ) => {
        nextRefreshResponse = response;
      };
      return {
        app,
        authFetch,
        cookieFrom,
        signIn,
        refresh,
        respondToNextRefresh,
      };
    }

    it.each([
      [tenantOrigin, canonicalOrigin],
      [canonicalOrigin, tenantOrigin],
      [tenantOrigin, "https://other.savia-preview.hefesoft.com"],
      [tenantOrigin, "https://savia.hefesoft.com"],
    ])(
      "requires a new login when moving from %s to %s",
      async (source, destination) => {
        const f = fixture();
        const callback = await f.signIn(source);
        expect(callback.status).toBe(200);
        const cookie = f.cookieFrom(callback);
        const response = await f.refresh(
          destination,
          `${cookie}; savia.session_token=old-provider-session`,
        );
        expect(response.status).toBe(401);
        // A stale tab must not revoke the valid session shared by another tab.
        expect(
          response.headers
            .getSetCookie()
            .some((value) => value.startsWith(`${cookie.split("=")[0]}=`)),
        ).toBe(false);
        expect(
          f.authFetch.mock.calls.filter(
            ([request]) =>
              new URL(request.url).pathname === "/api/auth/oauth2/token",
          ),
        ).toHaveLength(1);
        expect(
          f.authFetch.mock.calls.some(
            ([request]) =>
              new URL(request.url).pathname === "/api/auth/sign-out",
          ),
        ).toBe(false);
        expect((await f.refresh(source, cookie)).status).toBe(200);
      },
    );

    it("rejects a missing refresh cookie without waiting for the auth provider", async () => {
      const f = fixture();
      f.authFetch.mockResolvedValue(new Response(null, { status: 503 }));
      const response = await f.refresh(tenantOrigin, "");
      expect(response.status).toBe(401);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        tenantOrigin,
      );
      expect(f.authFetch).not.toHaveBeenCalled();
    });

    it.each(["null", "not-an-origin"])(
      "rejects an unauthenticated request with origin %s without crashing",
      async (origin) => {
        const f = fixture();
        const response = await f.app.request(
          `${tenantOrigin}/api/auth/admin/refresh`,
          {
            method: "POST",
            headers: { origin },
          },
        );
        expect(response.status).toBe(403);
        expect(response.headers.get("access-control-allow-origin")).toBeNull();
      },
    );

    it("restores a fresh tenant login even when an older host cookie is sent first", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      expect(callback.status).toBe(200);
      // Browsers can retain a host-only cookie and a parent-domain cookie with
      // the same name. The older host cookie must not shadow the fresh login.
      const cookie = `savia.admin_refresh_token=stale-host-token; ${f.cookieFrom(callback)}`;
      const renewed = await f.refresh(tenantOrigin, cookie);
      expect(renewed.status).toBe(200);
      expect(
        (await f.refresh(tenantOrigin, f.cookieFrom(renewed))).status,
      ).toBe(200);
    });

    it("renews and signs out a tenant session through a different API origin", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      expect(callback.status).toBe(200);
      const request = (action: string, cookie: string) =>
        f.app.request(`${canonicalOrigin}/api/auth/admin/${action}`, {
          method: "POST",
          headers: { origin: tenantOrigin, cookie },
        });
      const renewed = await request("refresh", f.cookieFrom(callback));
      expect(renewed.status).toBe(200);
      expect(renewed.headers.get("access-control-allow-origin")).toBe(
        tenantOrigin,
      );
      const cookie = f.cookieFrom(renewed);
      expect((await request("logout", cookie)).status).toBe(204);
      expect((await request("refresh", cookie)).status).toBe(401);
    });

    it("keeps both workspace sessions usable when another origin signs in", async () => {
      const f = fixture();
      const jar = new Map<string, string>();
      const accept = (response: Response) => {
        for (const value of response.headers.getSetCookie()) {
          const pair = value.split(";")[0];
          const separator = pair.indexOf("=");
          const name = pair.slice(0, separator);
          if (value.includes("Max-Age=0")) jar.delete(name);
          else jar.set(name, pair);
        }
      };
      const cookies = () => [...jar.values()].join("; ");
      accept(await f.signIn(tenantOrigin));
      accept(await f.signIn(canonicalOrigin, cookies()));
      const tenantRefresh = await f.refresh(tenantOrigin, cookies());
      expect(tenantRefresh.status).toBe(200);
      accept(tenantRefresh);
      const canonicalRefresh = await f.refresh(canonicalOrigin, cookies());
      expect(canonicalRefresh.status).toBe(200);
      accept(canonicalRefresh);
      const logout = await f.app.request(
        `${canonicalOrigin}/api/auth/admin/logout`,
        {
          method: "POST",
          headers: { origin: canonicalOrigin, cookie: cookies() },
        },
      );
      expect(logout.status).toBe(204);
      accept(logout);
      expect((await f.refresh(tenantOrigin, cookies())).status).toBe(200);
      expect((await f.refresh(canonicalOrigin, cookies())).status).toBe(401);
    });

    it("keeps the initiating tenant through the canonical callback and token rotation", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      expect(await callback.json()).toMatchObject({
        returnOrigin: tenantOrigin,
      });
      const renewed = await f.refresh(tenantOrigin, f.cookieFrom(callback));
      expect(renewed.status).toBe(200);
      const rotated = f.cookieFrom(renewed);
      expect((await f.refresh(tenantOrigin, rotated)).status).toBe(200);
      expect((await f.refresh(canonicalOrigin, rotated)).status).toBe(401);
    });

    it.each([tenantOrigin, canonicalOrigin])(
      "resumes tenant bookings after authorizing at %s",
      async (origin) => {
        const f = fixture();
        const search = new URLSearchParams({
          resume: "bookings",
          return_to: tenantOrigin,
        });
        const callback = await f.signIn(origin, "", `?${search}`);
        expect(callback.status).toBe(200);
        expect(await callback.json()).toMatchObject({
          returnOrigin: tenantOrigin,
          returnRoute: "bookings",
        });
        const renewed = await f.refresh(tenantOrigin, f.cookieFrom(callback));
        expect(renewed.status).toBe(200);
      },
    );

    it("returns validated booking filters from the initiating transaction", async () => {
      const f = fixture();
      const search = new URLSearchParams({
        resume: "bookings",
        return_to: tenantOrigin,
        booking_query: "tab=reservations&date=2026-11-25&ignored=1",
      });
      const callback = await f.signIn(canonicalOrigin, "", `?${search}`);
      const authorization = f.authFetch.mock.calls
        .map(([request]) => new URL(request.url))
        .find((url) => url.pathname === "/api/auth/oauth2/authorize");
      const state = authorization?.searchParams.get("state");
      const restartQuery = new URLSearchParams(state?.split("?")[1]);
      expect(restartQuery.get("return_to")).toBe(tenantOrigin);
      expect(callback.status).toBe(200);
      expect(await callback.json()).toMatchObject({
        returnOrigin: tenantOrigin,
        returnRoute: "bookings",
        returnBookingQuery: "tab=reservations&date=2026-11-25",
      });
    });

    it("returns Studio screens and retry navigation from the initiating transaction", async () => {
      const f = fixture();
      const search = new URLSearchParams({
        resume: "studio",
        return_to: tenantOrigin,
        studio_query:
          "tenantId=14&object=ventas&view=collection-sources&tab=sources&ignored=1",
      });
      const callback = await f.signIn(canonicalOrigin, "", `?${search}`);
      expect(callback.status).toBe(200);
      const destination = {
        returnOrigin: tenantOrigin,
        returnRoute: "studio",
        returnStudioQuery:
          "tenantId=14&object=ventas&view=collection-sources&tab=sources",
      };
      expect(await callback.json()).toMatchObject(destination);

      const authorize = await f.app.request(
        `${canonicalOrigin}/api/auth/admin/authorize?${search}`,
      );
      const state = new URL(authorize.headers.get("location")!).searchParams.get(
        "state",
      );
      const failure = await f.app.request(
        `${canonicalOrigin}/api/auth/admin/callback`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: canonicalOrigin },
          body: JSON.stringify({ authorizationFailed: true, state }),
        },
      );
      expect(failure.status).toBe(401);
      expect(await failure.json()).toMatchObject(destination);
    });

    it("retains a same-origin Bookings organization through the local OAuth callback", async () => {
      const localOrigin = "http://127.0.0.1:5173";
      const f = fixture(localOrigin);
      const search = new URLSearchParams({
        resume: "bookings",
        booking_query: "tab=availability&date=2026-11-25&tenantId=42&ignored=1",
      });
      const callback = await f.signIn(localOrigin, "", `?${search}`);
      expect(callback.status).toBe(200);
      expect(await callback.json()).toMatchObject({
        returnRoute: "bookings",
        returnBookingQuery: "tab=availability&date=2026-11-25&tenantId=42",
      });
    });

    it("returns the Bookings destination when authorization stops before a code is issued", async () => {
      const f = fixture();
      const search = new URLSearchParams({
        resume: "bookings",
        return_to: tenantOrigin,
        booking_query: "tab=reservations&date=2026-11-25&ignored=1",
      });
      const authorize = await f.app.request(
        `${canonicalOrigin}/api/auth/admin/authorize?${search}`,
      );
      expect(authorize.status).toBe(302);
      const state = new URL(
        authorize.headers.get("location")!,
      ).searchParams.get("state");
      const failure = () =>
        f.app.request(`${canonicalOrigin}/api/auth/admin/callback`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: canonicalOrigin,
          },
          body: JSON.stringify({ authorizationFailed: true, state }),
        });

      const response = await failure();
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "OAUTH_AUTHORIZATION_FAILED",
          message: "The authorization request did not complete",
        },
        returnOrigin: tenantOrigin,
        returnRoute: "bookings",
        returnBookingQuery: "tab=reservations&date=2026-11-25",
      });
      expect(
        response.headers
          .getSetCookie()
          .some((value) => value.startsWith("savia.admin_refresh_token")),
      ).toBe(false);
      const replay = await failure();
      expect(replay.status).toBe(400);
      await expect(replay.json()).resolves.toEqual({
        error: {
          code: "INVALID_OAUTH_STATE",
          message: "The login transaction is invalid or expired",
        },
      });
      expect(
        f.authFetch.mock.calls.some(
          ([request]) =>
            new URL(request.url).pathname === "/api/auth/oauth2/token",
        ),
      ).toBe(false);
    });

    it("recovers the same Bookings destination when the issued login expires", async () => {
      const f = fixture();
      const search = new URLSearchParams({
        resume: "bookings",
        return_to: tenantOrigin,
        booking_query: "tab=reservations&date=2026-11-25",
      });
      const authorize = await f.app.request(
        `${canonicalOrigin}/api/auth/admin/authorize?${search}`,
      );
      expect(authorize.status).toBe(302);
      const state = new URL(
        authorize.headers.get("location")!,
      ).searchParams.get("state");
      await env.DB.prepare(
        "UPDATE admin_oauth_transactions SET expires_at = ? WHERE state = ?",
      )
        .bind(new Date(Date.now() - 1_000).toISOString(), state)
        .run();

      // Starting another login must not overwrite the expired tab's destination.
      const other = "https://other.savia-preview.hefesoft.com";
      expect(
        (await f.app.request(`${other}/api/auth/admin/authorize`)).status,
      ).toBe(302);
      const callback = () =>
        f.app.request(`${canonicalOrigin}/api/auth/admin/callback`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: canonicalOrigin,
            cookie: `savia.return_origin=${encodeURIComponent(other)}`,
          },
          body: JSON.stringify({ code: "authorization-code", state }),
        });
      const expired = await callback();
      expect(expired.status).toBe(400);
      expect(await expired.json()).toMatchObject({
        error: { code: "INVALID_OAUTH_STATE" },
        returnOrigin: tenantOrigin,
        returnRoute: "bookings",
        returnBookingQuery: "tab=reservations&date=2026-11-25",
      });
      const replay = await callback();
      expect(replay.status).toBe(400);
      expect(await replay.json()).not.toHaveProperty("returnRoute");
      expect(
        f.authFetch.mock.calls.some(
          ([request]) =>
            new URL(request.url).pathname === "/api/auth/oauth2/token",
        ),
      ).toBe(false);

      const recovered = await f.signIn(canonicalOrigin, "", `?${search}`);
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({
        returnOrigin: tenantOrigin,
        returnRoute: "bookings",
        returnBookingQuery: "tab=reservations&date=2026-11-25",
      });
      expect(
        (await f.refresh(tenantOrigin, f.cookieFrom(recovered))).status,
      ).toBe(200);
    });

    it.each([canonicalOrigin, "http://127.0.0.1:5173"])(
      "resumes bookings without a cross-origin return at %s",
      async (origin) => {
        const f = fixture(origin);
        const search = new URLSearchParams({
          resume: "bookings",
          booking_query: "tab=availability&date=2026-11-25&ignored=1",
        });
        const callback = await f.signIn(origin, "", `?${search}`);
        expect(callback.status).toBe(200);
        const payload = await callback.json();
        expect(payload).toMatchObject({
          returnRoute: "bookings",
          returnBookingQuery: "tab=availability&date=2026-11-25",
        });
        expect(payload).not.toHaveProperty("returnOrigin");
        expect((await f.refresh(origin, f.cookieFrom(callback))).status).toBe(
          200,
        );
      },
    );

    it("does not let a stale return cookie change the session origin", async () => {
      const f = fixture();
      const callback = await f.signIn(
        canonicalOrigin,
        `savia.return_origin=${encodeURIComponent(tenantOrigin)}`,
      );
      expect((await callback.json()).returnOrigin).toBeUndefined();
      expect(
        (await f.refresh(canonicalOrigin, f.cookieFrom(callback))).status,
      ).toBe(200);
    });

    it("rejects legacy and expired refresh sessions without contacting the token endpoint", async () => {
      const f = fixture();
      const legacy = await f.refresh(
        tenantOrigin,
        "savia.admin_refresh_token=legacy-token",
      );
      expect(legacy.status).toBe(401);
      const callback = await f.signIn(tenantOrigin);
      await env.DB.exec(
        "UPDATE admin_oauth_session_origins SET expires_at = '2000-01-01T00:00:00.000Z'",
      );
      expect(
        (await f.refresh(tenantOrigin, f.cookieFrom(callback))).status,
      ).toBe(401);
      expect(
        f.authFetch.mock.calls.filter(
          ([request]) =>
            new URL(request.url).pathname === "/api/auth/oauth2/token",
        ),
      ).toHaveLength(1);
    });

    it.each([
      [
        "provider rate limits",
        () => new Response("slow down", { status: 429 }),
      ],
      [
        "provider server errors",
        () => new Response("unavailable", { status: 503 }),
      ],
      [
        "malformed successful responses",
        () => Response.json({ unexpected: true }),
      ],
      [
        "malformed successful JSON",
        () =>
          new Response("{", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ],
      [
        "provider transport failures",
        () => Promise.reject(new Error("upstream unavailable")),
      ],
    ])(
      "preserves a refresh session after %s",
      async (_caseName, providerResponse) => {
        const f = fixture();
        const callback = await f.signIn(tenantOrigin);
        const cookie = f.cookieFrom(callback);
        f.respondToNextRefresh(providerResponse);

        const failed = await f.refresh(tenantOrigin, cookie);

        expect(failed.status).toBe(503);
        expect(await failed.json()).toMatchObject({
          error: { code: "AUTHENTICATION_UNAVAILABLE" },
        });
        expect(failed.headers.get("set-cookie")).toBeNull();
        expect(
          f.authFetch.mock.calls.some(
            ([request]) =>
              new URL(request.url).pathname === "/api/auth/sign-out",
          ),
        ).toBe(false);

        f.respondToNextRefresh(() =>
          Response.json({
            access_token: "recovered-access",
            refresh_token: "recovered-refresh",
            token_type: "Bearer",
            expires_in: 300,
          }),
        );
        expect((await f.refresh(tenantOrigin, cookie)).status).toBe(200);
      },
    );

    it("bounds a stalled refresh response body and keeps the session retryable", async () => {
      const f = fixture();
      const cookie = f.cookieFrom(await f.signIn(tenantOrigin));
      let closeBody!: () => void;
      const body = new ReadableStream({
        start(controller) {
          closeBody = () => controller.close();
        },
      });
      let markProviderStarted!: () => void;
      const providerStarted = new Promise<void>((resolve) => {
        markProviderStarted = resolve;
      });
      f.respondToNextRefresh(() => {
        markProviderStarted();
        return new Response(body, {
          headers: { "content-type": "application/json" },
        });
      });

      let completed = false;
      vi.useFakeTimers();
      try {
        const pending = f.refresh(tenantOrigin, cookie).then((response) => {
          completed = true;
          return response;
        });
        await providerStarted;
        await vi.advanceTimersByTimeAsync(10_000);
        const completedByDeadline = completed;
        closeBody();
        const failed = await pending;

        expect(completedByDeadline).toBe(true);
        expect(failed.status).toBe(503);
        expect(failed.headers.get("set-cookie")).toBeNull();
      } finally {
        vi.useRealTimers();
      }

      f.respondToNextRefresh(() =>
        Response.json({
          access_token: "recovered-access",
          refresh_token: "recovered-refresh",
          token_type: "Bearer",
        }),
      );
      expect((await f.refresh(tenantOrigin, cookie)).status).toBe(200);
    });

    it.each([
      ["invalid_grant", 400],
      ["invalid_token", 401],
    ])(
      "clears a refresh cookie when the provider confirms %s",
      async (code, status) => {
        const f = fixture();
        const callback = await f.signIn(tenantOrigin);
        const cookie = f.cookieFrom(callback);
        f.respondToNextRefresh(() =>
          Response.json({ error: code }, { status }),
        );

        const failed = await f.refresh(tenantOrigin, cookie);

        expect(failed.status).toBe(401);
        expect(failed.headers.get("set-cookie")).toContain(
          "savia.admin_refresh_token=",
        );
      },
    );

    it("does not sign out another origin through a shared legacy cookie", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      const pair = f.cookieFrom(callback);
      const legacy = `savia.admin_refresh_token=${pair.slice(pair.indexOf("=") + 1)}`;
      const response = await f.app.request(
        `${canonicalOrigin}/api/auth/admin/logout`,
        {
          method: "POST",
          headers: {
            origin: canonicalOrigin,
            cookie: `${legacy}; savia.session_token=other-origin-provider-session`,
          },
        },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect((await f.refresh(tenantOrigin, legacy)).status).toBe(200);
      expect(
        f.authFetch.mock.calls.some(
          ([request]) => new URL(request.url).pathname === "/api/auth/sign-out",
        ),
      ).toBe(false);
    });

    it("rejects logout from an untrusted origin without revoking the session", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      const cookie = f.cookieFrom(callback);
      const response = await f.app.request(
        `${tenantOrigin}/api/auth/admin/logout`,
        {
          method: "POST",
          headers: { origin: "https://evil.example", cookie },
        },
      );
      expect(response.status).toBe(403);
      expect((await f.refresh(tenantOrigin, cookie)).status).toBe(200);
    });

    it("invalidates the server-side refresh binding on logout", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      const cookie = f.cookieFrom(callback);
      const logout = await f.app.request(
        `${tenantOrigin}/api/auth/admin/logout`,
        {
          method: "POST",
          headers: { origin: tenantOrigin, cookie },
        },
      );
      expect(logout.status).toBe(204);
      expect((await f.refresh(tenantOrigin, cookie)).status).toBe(401);
    });

    it("rejects an untrusted origin without destroying the legitimate session", async () => {
      const f = fixture();
      const callback = await f.signIn(tenantOrigin);
      const cookie = f.cookieFrom(callback);
      const response = await f.app.request(
        `${tenantOrigin}/api/auth/admin/refresh`,
        {
          method: "POST",
          headers: { origin: "https://evil.example", cookie },
        },
      );
      expect(response.status).toBe(403);
      expect((await f.refresh(tenantOrigin, cookie)).status).toBe(200);
    });

    it("requires explicit login even with an existing provider session", async () => {
      const f = fixture();
      const response = await f.app.request(
        `${tenantOrigin}/api/auth/admin/authorize`,
        {
          headers: { cookie: "savia.session_token=old-provider-session" },
        },
      );
      expect(response.status).toBe(302);
      expect(
        new URL(response.headers.get("location")!).searchParams.get("prompt"),
      ).toBe("login");
    });
  });
});

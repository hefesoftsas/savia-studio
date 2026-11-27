import { describe, expect, it, vi } from "vitest";
import { getSessionGeneration } from "./session-scope";
import {
  BetterAuthOAuthSession,
  normalizeAvatarUrl,
} from "./better-auth-oauth-session";

describe("BetterAuthOAuthSession", () => {
  it("starts a first-party OAuth authorization flow through the API", async () => {
    const navigation = {
      currentUrl: () => "http://127.0.0.1:5173/#/login",
      redirect: vi.fn(),
    };
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation,
      fetcher: vi.fn(),
    });

    await session.login();

    expect(navigation.redirect).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/auth/admin/authorize",
    );
  });

  it("restores an access token from the secure server session after a reload", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "refreshed-access-token",
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid savia.api.read savia.api.write",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "principal-1",
              attributes: {
                displayName: "Savia Administrator",
                globalRoles: ["platform_admin"],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      fetcher,
    });

    await Promise.all([session.checkSession(), session.checkSession()]);

    expect(await session.getAccessToken()).toBe("refreshed-access-token");
    await expect(session.getPermissions()).resolves.toEqual({
      canReadDocuments: true,
      canExecuteCommands: true,
      canManageIdentity: true,
      memberships: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/auth/admin/refresh",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("exchanges a callback code once and retains its access token only in memory", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "better-auth-access-token",
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid savia.api.read savia.api.write",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "principal-1",
              attributes: {
                displayName: "Savia Administrator",
                globalRoles: ["platform_admin"],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation: {
        currentUrl: () =>
          "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher,
    });

    await Promise.all([session.handleCallback(), session.handleCallback()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "http://127.0.0.1:8787/api/auth/admin/callback",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ code: "code-1", state: "state-1" }),
      }),
    );
    expect(await session.getAccessToken()).toBe("better-auth-access-token");
    await expect(session.getPermissions()).resolves.toEqual({
      canReadDocuments: true,
      canExecuteCommands: true,
      canManageIdentity: true,
      memberships: [],
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("waits for the callback exchange before early session checks can refresh", async () => {
    let resolveCallback!: (response: Response) => void;
    const callbackResponse = new Promise<Response>((resolve) => {
      resolveCallback = resolve;
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/auth/admin/callback")) {
        return callbackResponse;
      }
      if (String(input).endsWith("/api/auth/admin/refresh")) {
        return Promise.resolve(
          Response.json({ error: { message: "No session" } }, { status: 401 }),
        );
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    const session = new BetterAuthOAuthSession({
      apiUrl: "https://savia.test",
      navigation: {
        currentUrl: () =>
          "https://savia.test/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher,
    });

    const accessToken = session.getAccessToken();
    const sessionCheck = session.checkSession();
    const callback = session.handleCallback();
    resolveCallback(
      Response.json({
        access_token: "exchanged-access-token",
        token_type: "Bearer",
        expires_in: 300,
        scope: "openid savia.api.read",
      }),
    );

    await expect(
      Promise.all([accessToken, sessionCheck, callback]),
    ).resolves.toEqual([
      "exchanged-access-token",
      undefined,
      { returnOrigin: undefined },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://savia.test/api/auth/admin/callback",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("exchanges a callback code and returns the workspace and route", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "better-auth-access-token",
          token_type: "Bearer",
          expires_in: 300,
          scope: "openid savia.api.read savia.api.write",
          returnOrigin:
            "https://example-organization.savia-preview.hefesoft.com",
          returnRoute: "bookings",
          returnBookingQuery: "tab=reservations&date=2026-11-25&ignored=1",
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation: {
        currentUrl: () =>
          "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher,
    });

    const result = await session.handleCallback();

    expect(result).toEqual({
      returnOrigin: "https://example-organization.savia-preview.hefesoft.com",
      returnRoute: "bookings",
      returnBookingQuery: "tab=reservations&date=2026-11-25",
    });
  });

  it.each(["bookings", "bookings/", "BOOKINGS"])(
    "requests a bookings return when signing into a tenant %s link",
    async (route) => {
      const redirect = vi.fn();
      const origin = "https://clinic.savia-preview.hefesoft.com";
      const session = new BetterAuthOAuthSession({
        apiUrl: "https://savia-preview.hefesoft.com",
        navigation: { currentUrl: () => `${origin}/#/${route}`, redirect },
      });

      await session.login();

      const authorize = new URL(redirect.mock.calls[0][0]);
      expect(authorize.searchParams.get("return_to")).toBe(origin);
      expect(authorize.searchParams.get("resume")).toBe("bookings");
    },
  );

  it("starts a fresh authorization for a Bookings recovery link", async () => {
    const redirect = vi.fn();
    const origin = "https://clinic.savia-preview.hefesoft.com";
    const session = new BetterAuthOAuthSession({
      apiUrl: origin,
      navigation: {
        currentUrl: () =>
          `${origin}/#/login?resume=bookings&tab=reservations&date=2026-11-25&next=external`,
        redirect,
      },
    });

    await session.login();

    const authorize = new URL(redirect.mock.calls[0][0]);
    expect(authorize.pathname).toBe("/api/auth/admin/authorize");
    expect(authorize.searchParams.get("return_to")).toBe(origin);
    expect(authorize.searchParams.get("resume")).toBe("bookings");
    expect(authorize.searchParams.get("booking_query")).toBe(
      "tab=reservations&date=2026-11-25",
    );
  });

  it.each(["availability", "reservations", "sharing"])(
    "preserves the %s tab and date on a tenant deep link",
    async (tab) => {
      const redirect = vi.fn();
      const origin = "https://clinic.savia-preview.hefesoft.com";
      const session = new BetterAuthOAuthSession({
        apiUrl: "https://savia-preview.hefesoft.com",
        navigation: {
          currentUrl: () =>
            `${origin}/#/bookings?tab=${tab}&date=2026-11-25&unused=1`,
          redirect,
        },
      });

      await session.login();
      const authorize = new URL(redirect.mock.calls[0][0]);
      expect(authorize.searchParams.get("return_to")).toBe(origin);
      expect(authorize.searchParams.get("resume")).toBe("bookings");
      expect(authorize.searchParams.get("booking_query")).toBe(
        `tab=${tab}&date=2026-11-25`,
      );
    },
  );

  it.each([
    [
      "https://savia-preview.hefesoft.com",
      "https://savia-preview.hefesoft.com",
    ],
    ["http://127.0.0.1:5173", "http://127.0.0.1:8787"],
  ])("resumes bookings after signing in from %s", async (origin, apiUrl) => {
    const redirect = vi.fn();
    const session = new BetterAuthOAuthSession({
      apiUrl,
      navigation: {
        currentUrl: () =>
          `${origin}/#/bookings?tab=reservations&date=2026-11-25`,
        redirect,
      },
    });

    await session.login();
    const authorize = new URL(redirect.mock.calls[0][0]);
    expect(authorize.searchParams.get("return_to")).toBeNull();
    expect(authorize.searchParams.get("resume")).toBe("bookings");
    expect(authorize.searchParams.get("booking_query")).toBe(
      "tab=reservations&date=2026-11-25",
    );
  });

  it("reports the safe OAuth error returned by the callback bridge", async () => {
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation: {
        currentUrl: () =>
          "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher: vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "OAUTH_TOKEN_EXCHANGE_FAILED",
              message:
                "Better Auth rejected the authorization code (invalid_request)",
            },
          },
          { status: 401 },
        ),
      ),
    });

    await expect(session.handleCallback()).rejects.toThrow(
      "Better Auth rejected the authorization code (invalid_request)",
    );
  });

  it.each(["handleCallback", "getAccessToken"] as const)(
    "recovers the Bookings destination on a provider error through %s",
    async (method) => {
      const apiUrl = "https://savia-preview.hefesoft.com";
      const returnOrigin = "https://clinic.savia-preview.hefesoft.com";
      const fetcher = vi.fn().mockResolvedValueOnce(
        Response.json(
          {
            error: {
              code: "OAUTH_AUTHORIZATION_FAILED",
              message: "The authorization request did not complete",
            },
            returnOrigin,
            returnRoute: "bookings",
            returnBookingQuery: "tab=reservations&date=2026-11-25",
          },
          { status: 401 },
        ),
      );
      const session = new BetterAuthOAuthSession({
        apiUrl,
        navigation: {
          currentUrl: () =>
            `${apiUrl}/auth/callback?error=access_denied&state=original-state&error_description=Private+provider+details`,
          redirect: vi.fn(),
        },
        fetcher,
      });
      const retry = new URL("/api/auth/admin/authorize", apiUrl);
      retry.search = new URLSearchParams({
        return_to: returnOrigin,
        resume: "bookings",
        booking_query: "tab=reservations&date=2026-11-25",
      }).toString();
      await expect(session[method]()).rejects.toMatchObject({
        retryHref: retry.href,
      });
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        `${apiUrl}/api/auth/admin/callback`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            state: "original-state",
            authorizationFailed: true,
          }),
        }),
      );
    },
  );

  it.each([undefined, "https://clinic.savia-preview.hefesoft.com"])(
    "starts a fresh authorization to Bookings after a rejected exchange with return origin %s",
    async (returnOrigin) => {
      const apiUrl = "https://savia-preview.hefesoft.com";
      const session = new BetterAuthOAuthSession({
        apiUrl,
        navigation: {
          currentUrl: () =>
            `${apiUrl}/auth/callback?code=old-code&state=old-state`,
          redirect: vi.fn(),
        },
        fetcher: vi.fn().mockResolvedValueOnce(
          Response.json(
            {
              error: { message: "The authorization code was rejected" },
              returnOrigin,
              returnRoute: "bookings",
              returnBookingQuery: "tab=reservations&date=2026-11-25&ignored=1",
            },
            { status: 401 },
          ),
        ),
      });

      const retry = new URL("/api/auth/admin/authorize", apiUrl);
      retry.search = new URLSearchParams({
        ...(returnOrigin ? { return_to: returnOrigin } : {}),
        resume: "bookings",
        booking_query: "tab=reservations&date=2026-11-25",
      }).toString();
      await expect(session.handleCallback()).rejects.toMatchObject({
        message: "The authorization code was rejected",
        retryHref: retry.href,
      });
    },
  );

  it("renews an access token before it expires", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "initial-access-token",
              token_type: "Bearer",
              expires_in: 60,
              scope: "openid savia.api.read",
            }),
            { headers: { "content-type": "application/json" } },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              access_token: "renewed-access-token",
              token_type: "Bearer",
              expires_in: 300,
              scope: "openid savia.api.read",
            }),
            { headers: { "content-type": "application/json" } },
          ),
        );
      const session = new BetterAuthOAuthSession({
        apiUrl: "http://127.0.0.1:8787",
        navigation: {
          currentUrl: () =>
            "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
          redirect: vi.fn(),
        },
        fetcher,
      });

      await session.handleCallback();
      await vi.advanceTimersByTimeAsync(31_000);

      await expect(session.getAccessToken()).resolves.toBe(
        "renewed-access-token",
      );
      expect(fetcher).toHaveBeenLastCalledWith(
        "http://127.0.0.1:8787/api/auth/admin/refresh",
        expect.objectContaining({ method: "POST", credentials: "include" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the OAuth bearer token to resolve the Savia identity", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "better-auth-access-token",
            token_type: "Bearer",
            scope: "savia.api.read",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "principal-1",
              attributes: {
                displayName: "Savia Administrator",
                email: "admin@savia.test",
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          user: {
            id: "better-auth-user",
            image: null,
            name: "Savia Administrator",
            email: "admin@savia.test",
          },
        }),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation: {
        currentUrl: () =>
          "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher,
    });

    await session.handleCallback();

    await expect(session.getIdentity()).resolves.toEqual({
      id: "principal-1",
      fullName: "Savia Administrator",
      email: "admin@savia.test",
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8787/v1/identity/me",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer better-auth-access-token",
        }),
        credentials: "include",
      }),
    );
    const identityRequest = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(identityRequest.headers).get("Authorization")).toBe(
      "Bearer better-auth-access-token",
    );
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8787/api/auth/get-session",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("adds the Better Auth profile image to the React Admin identity", async () => {
    const avatar =
      "http://127.0.0.1:8787/v1/account/avatar?v=11111111-1111-4111-8111-111111111111";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "better-auth-access-token",
          token_type: "Bearer",
          scope: "savia.api.read",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: "principal-1",
            attributes: {
              displayName: "Savia Administrator",
              email: "admin@savia.test",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          user: {
            id: "better-auth-user",
            image: avatar,
            name: "Savia Administrator",
            email: "admin@savia.test",
          },
        }),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      fetcher,
    });

    await expect(session.getIdentity()).resolves.toEqual({
      id: "principal-1",
      fullName: "Savia Administrator",
      email: "admin@savia.test",
      avatar,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8787/api/auth/get-session",
      expect.objectContaining({
        credentials: "include",
        headers: { Accept: "application/json" },
      }),
    );
  });

  it("normalizes loopback avatar URLs to match the remote API origin", async () => {
    const loopbackAvatar =
      "http://127.0.0.1:8787/v1/account/avatar?v=2dbb6efe-1b1f-4462-ae99-8084bf9cd37e";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "better-auth-access-token",
          token_type: "Bearer",
          scope: "savia.api.read",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: "principal-1",
            attributes: {
              displayName: "Savia Administrator",
              email: "admin@savia.test",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          user: {
            id: "better-auth-user",
            image: loopbackAvatar,
            name: "Savia Administrator",
            email: "admin@savia.test",
          },
        }),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "https://savia-preview.hefesoft.com",
      fetcher,
    });

    await expect(session.getIdentity()).resolves.toEqual({
      id: "principal-1",
      fullName: "Savia Administrator",
      email: "admin@savia.test",
      avatar:
        "https://savia-preview.hefesoft.com/v1/account/avatar?v=2dbb6efe-1b1f-4462-ae99-8084bf9cd37e",
    });
  });

  it("coalesces concurrent getIdentity calls to avoid duplicate session requests", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "better-auth-access-token",
          token_type: "Bearer",
          scope: "savia.api.read",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: "principal-1",
            attributes: {
              displayName: "Savia Administrator",
              email: "admin@savia.test",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          user: {
            id: "better-auth-user",
            image: "https://example.com/avatar.png",
            name: "Savia Administrator",
            email: "admin@savia.test",
          },
        }),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "https://savia-preview.hefesoft.com",
      fetcher,
    });

    const [id1, id2, id3, id4] = await Promise.all([
      session.getIdentity(),
      session.getIdentity(),
      session.getIdentity(),
      session.getIdentity(),
    ]);

    expect(id1).toEqual(id2);
    expect(id1.avatar).toBe("https://example.com/avatar.png");
    // Token refresh + identity/me + get-session = exactly 3 calls total
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Sequential subsequent call uses cached avatar and cached identity
    const id5 = await session.getIdentity();
    expect(id5).toEqual(id1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("refreshes avatar and identity when savia:identity-changed is dispatched", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "better-auth-access-token",
          token_type: "Bearer",
          scope: "savia.api.read",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: "principal-1",
            attributes: {
              displayName: "Savia Administrator",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          user: {
            image: "https://example.com/avatar-v1.png",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            id: "principal-1",
            attributes: {
              displayName: "Savia Administrator Updated",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          user: {
            image: "https://example.com/avatar-v2.png",
          },
        }),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "https://savia-preview.hefesoft.com",
      fetcher,
    });

    const first = await session.getIdentity();
    expect(first.avatar).toBe("https://example.com/avatar-v1.png");

    window.dispatchEvent(new Event("savia:identity-changed"));

    const second = await session.getIdentity();
    expect(second.avatar).toBe("https://example.com/avatar-v2.png");
    expect(second.fullName).toBe("Savia Administrator Updated");
  });

  it("exposes active agency memberships with the session permissions", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "better-auth-access-token",
            token_type: "Bearer",
            scope: "savia.api.read savia.api.write",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              id: "principal-1",
              attributes: {
                displayName: "Agency Administrator",
                globalRoles: [],
              },
              relationships: {
                memberships: [
                  {
                    role: "agency_admin",
                    attributes: { isActive: true },
                    relationships: { agency: { id: "101" } },
                  },
                  {
                    role: "viewer",
                    attributes: { isActive: false },
                    relationships: { agency: { id: "102" } },
                  },
                ],
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation: {
        currentUrl: () =>
          "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher,
    });

    await session.handleCallback();

    await expect(session.getPermissions()).resolves.toMatchObject({
      canReadDocuments: true,
      canManageIdentity: false,
      memberships: [{ agencyId: 101, tenantId: 101, role: "agency_admin" }],
    });
  });

  it("clears every browser session through the CORS-enabled admin endpoint", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "better-auth-access-token",
            token_type: "Bearer",
            scope: "savia.api.read",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      navigation: {
        currentUrl: () =>
          "http://127.0.0.1:5173/auth/callback?code=code-1&state=state-1",
        redirect: vi.fn(),
      },
      fetcher,
    });
    await session.handleCallback();

    const redirectUrl = await session.logout();

    expect(redirectUrl).toBe("http://127.0.0.1:8787/api/auth/admin/authorize");
    expect(await session.getAccessToken()).toBeNull();
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8787/api/auth/admin/logout",
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns authorize URL even if the server logout request encounters a network failure", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      fetcher,
    });
    const redirectUrl = await session.logout();
    expect(redirectUrl).toBe("http://127.0.0.1:8787/api/auth/admin/authorize");
  });

  it.each(["refresh", "callback"] as const)(
    "ignores a delayed OAuth %s response after logout",
    async (flow) => {
      let finish!: (response: Response) => void;
      const delayed = new Promise<Response>((resolve) => {
        finish = resolve;
      });
      const fetcher = vi
        .fn<typeof fetch>()
        .mockReturnValueOnce(delayed)
        .mockResolvedValueOnce(new Response(null, { status: 204 }));
      const session = new BetterAuthOAuthSession({
        apiUrl: "https://savia.test",
        navigation: {
          currentUrl: () =>
            flow === "callback"
              ? "https://savia.test/auth/callback?code=code-1&state=state-1"
              : "https://savia.test/",
          redirect: vi.fn(),
        },
        fetcher,
      });
      const pending = session.getAccessToken().catch(() => null);

      await session.logout();
      finish(
        Response.json({
          access_token: "late-token",
          token_type: "Bearer",
          expires_in: 1800,
          scope: "openid savia.api.read",
        }),
      );

      await expect(pending).resolves.toBeNull();
      expect(await session.getAccessToken()).toBeNull();
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("keeps the stale token when a refresh hits a network failure", async () => {
    const refresh = (token: string, expiresIn: number) =>
      new Response(
        JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: "openid savia.api.read savia.api.write",
        }),
        { headers: { "content-type": "application/json" } },
      );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(refresh("stale-token", 1))
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      fetcher,
    });

    // First call refreshes (no token yet); the token expires almost
    // immediately so every later call attempts a refresh that fails.
    await session.checkSession();
    await session.checkSession();
    expect(fetcher).toHaveBeenCalledTimes(2);

    expect(await session.getAccessToken()).toBe("stale-token");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("serves last known permissions when identity lookup goes offline", async () => {
    const identity = new Response(
      JSON.stringify({
        data: {
          id: "principal-1",
          attributes: {
            displayName: "Savia Administrator",
            globalRoles: ["platform_admin"],
          },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const refresh = (token: string, expiresIn: number) =>
      new Response(
        JSON.stringify({
          access_token: token,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: "openid savia.api.read savia.api.write",
        }),
        { headers: { "content-type": "application/json" } },
      );
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(refresh("token-1", 1))
      .mockResolvedValueOnce(identity)
      .mockResolvedValueOnce(refresh("token-2", 300))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      fetcher,
    });

    const online = await session.getPermissions();
    expect(online.canManageIdentity).toBe(true);

    // The second lookup rotates the token (expiring first one) and then the
    // identity request fails: cached permissions keep resources visible.
    const offline = await session.getPermissions();
    expect(offline).toEqual(online);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("degrades without cached permissions on a first offline lookup", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "better-auth-access-token",
            token_type: "Bearer",
            expires_in: 300,
            scope: "openid savia.api.read savia.api.write",
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const session = new BetterAuthOAuthSession({
      apiUrl: "http://127.0.0.1:8787",
      fetcher,
    });

    await expect(session.getPermissions()).resolves.toMatchObject({
      canReadDocuments: true,
      canManageIdentity: false,
      memberships: [],
    });
  });
});

it("requires a fresh identity response for lease verification despite cached credentials", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        access_token: "token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "savia.api.read",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        data: { id: "user", attributes: { displayName: "User" } },
      }),
    )
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher,
  });
  await session.checkSession();
  await session.getPermissions();
  await expect(session.checkSession()).resolves.toBeUndefined();
  await expect(session.verifySession()).rejects.toThrow("Failed to fetch");
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
    "https://savia.test/v1/identity/me",
  );
});

it("preserves the network error on a cold offline start so a persisted workspace lease can be used", async () => {
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher: vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
  });
  await expect(session.checkSession()).rejects.toThrow("Failed to fetch");
});
it("keeps server unavailability distinguishable from rejected credentials during refresh", async () => {
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher: vi
      .fn()
      .mockResolvedValue(
        Response.json({ error: { message: "Unavailable" } }, { status: 503 }),
      ),
  });
  await expect(session.checkSession()).rejects.toMatchObject({ status: 503 });
});

it("allows another refresh after the edge temporarily rate-limits the session", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ error: { message: "Try again later" } }, { status: 429 }),
    )
    .mockResolvedValueOnce(
      Response.json({
        access_token: "recovered-token",
        token_type: "Bearer",
        expires_in: 1800,
        scope: "openid savia.api.read",
      }),
    );
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher,
  });

  await expect(session.getAccessToken()).rejects.toMatchObject({ status: 429 });
  await expect(session.getAccessToken()).resolves.toBe("recovered-token");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("stops refreshing when the API confirms the session is unauthorized", async () => {
  const fetcher = vi.fn(async () =>
    Response.json({ error: { message: "No session" } }, { status: 401 }),
  );
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher,
  });

  await expect(session.getAccessToken()).rejects.toThrow("No session");
  await expect(session.getAccessToken()).resolves.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

describe("normalizeAvatarUrl", () => {
  it("rewrites loopback host to target apiUrl origin", () => {
    expect(
      normalizeAvatarUrl(
        "http://127.0.0.1:8787/v1/account/avatar?v=123",
        "https://savia-preview.hefesoft.com",
      ),
    ).toBe("https://savia-preview.hefesoft.com/v1/account/avatar?v=123");

    expect(
      normalizeAvatarUrl(
        "http://localhost:8787/v1/account/avatar?v=123",
        "https://savia-preview.hefesoft.com",
      ),
    ).toBe("https://savia-preview.hefesoft.com/v1/account/avatar?v=123");
  });

  it("resolves relative avatar path against apiUrl", () => {
    expect(
      normalizeAvatarUrl(
        "/v1/account/avatar?v=456",
        "https://savia-preview.hefesoft.com",
      ),
    ).toBe("https://savia-preview.hefesoft.com/v1/account/avatar?v=456");
  });

  it("leaves external and matching URLs unchanged", () => {
    expect(
      normalizeAvatarUrl(
        "https://cdn.example.com/pic.jpg",
        "https://savia-preview.hefesoft.com",
      ),
    ).toBe("https://cdn.example.com/pic.jpg");

    expect(
      normalizeAvatarUrl(
        "http://127.0.0.1:8787/v1/account/avatar?v=123",
        "http://127.0.0.1:8787",
      ),
    ).toBe("http://127.0.0.1:8787/v1/account/avatar?v=123");
  });

  it("handles empty or whitespace strings safely", () => {
    expect(normalizeAvatarUrl("", "https://savia-preview.hefesoft.com")).toBe(
      "",
    );
    expect(
      normalizeAvatarUrl("   ", "https://savia-preview.hefesoft.com"),
    ).toBe("");
  });
});

it("rotates scope only when an authoritative identity changes principal", async () => {
  let principal = "principal-a";
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/refresh"))
      return Response.json({
        access_token: "token",
        expires_in: 300,
        scope: "savia.api.read",
      });
    if (url.endsWith("/identity/me"))
      return Response.json({
        data: { id: principal, attributes: { displayName: "User" } },
      });
    return Response.json({ user: {} });
  });
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher,
  });
  await session.getIdentity();
  const before = getSessionGeneration();
  window.dispatchEvent(new Event("savia:identity-changed"));
  await session.getIdentity();
  expect(getSessionGeneration()).toBe(before);
  principal = "principal-b";
  window.dispatchEvent(new Event("savia:identity-changed"));
  expect((await session.getIdentity()).id).toBe("principal-b");
  expect(getSessionGeneration()).toBe(before + 1);
});

it("does not return an identity request that settles after logout", async () => {
  let finish!: (response: Response) => void;
  let started!: () => void;
  const identityStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/refresh"))
      return Response.json({
        access_token: "token",
        expires_in: 300,
        scope: "savia.api.read",
      });
    if (url.endsWith("/identity/me")) {
      started();
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    }
    return Response.json({ user: {} });
  });
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher,
  });
  const pending = session.getIdentity();
  const rejected = expect(pending).rejects.toThrow(/session changed/i);
  await identityStarted;
  await session.clearSession();
  finish(
    Response.json({
      data: { id: "old-principal", attributes: { displayName: "Old user" } },
    }),
  );
  await rejected;
});

it("returns signed-out permissions if logout interrupts an identity lookup", async () => {
  let finish!: (response: Response) => void;
  const delayedIdentity = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const identityRequest = vi.fn(() => delayedIdentity);
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher: async (input) => {
      if (String(input).endsWith("/refresh"))
        return Response.json({
          access_token: "token",
          expires_in: 300,
          scope: "savia.api.read savia.api.write",
        });
      return identityRequest();
    },
  });
  const pending = session.getPermissions();
  await vi.waitFor(() => expect(identityRequest).toHaveBeenCalledOnce());
  await session.clearSession();
  finish(
    Response.json({
      data: {
        id: "old-principal",
        attributes: {
          displayName: "Old user",
          globalRoles: ["platform_admin"],
        },
      },
    }),
  );

  await expect(pending).resolves.toEqual({
    canReadDocuments: false,
    canExecuteCommands: false,
    canManageIdentity: false,
    memberships: [],
  });
});

it("keeps the current avatar when an invalidated avatar request finishes late", async () => {
  let finishOldAvatar!: (response: Response) => void;
  const previousAvatar = new Promise<Response>((resolve) => {
    finishOldAvatar = resolve;
  });
  const avatars = vi
    .fn()
    .mockReturnValueOnce(previousAvatar)
    .mockImplementation(async () =>
      Response.json({ user: { image: "https://savia.test/new-avatar.png" } }),
    );
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher: async (input) => {
      const url = String(input);
      if (url.endsWith("/refresh"))
        return Response.json({
          access_token: "token",
          expires_in: 300,
          scope: "savia.api.read",
        });
      if (url.endsWith("/identity/me"))
        return Response.json({
          data: { id: "principal-a", attributes: { displayName: "User" } },
        });
      return avatars();
    },
  });
  const first = session.getIdentity();
  await vi.waitFor(() => expect(avatars).toHaveBeenCalledOnce());

  window.dispatchEvent(new Event("savia:identity-changed"));
  await expect(session.getIdentity()).resolves.toMatchObject({
    avatar: "https://savia.test/new-avatar.png",
  });
  finishOldAvatar(
    Response.json({ user: { image: "https://savia.test/old-avatar.png" } }),
  );
  await first;

  await expect(session.getIdentity()).resolves.toMatchObject({
    avatar: "https://savia.test/new-avatar.png",
  });
  expect(avatars).toHaveBeenCalledTimes(2);
});

it.each(["successful", "failed"] as const)(
  "keeps the current identity after a stale %s identity response",
  async (outcome) => {
    let finishPrevious!: (response: Response) => void;
    const previous = new Promise<Response>((resolve) => {
      finishPrevious = resolve;
    });
    const identityResponse = (id: string) =>
      Response.json({ data: { id, attributes: { displayName: id } } });
    const identities = vi
      .fn()
      .mockReturnValueOnce(previous)
      .mockImplementation(async () => identityResponse("current-principal"));
    const session = new BetterAuthOAuthSession({
      apiUrl: "https://savia.test",
      fetcher: async (input) => {
        const url = String(input);
        if (url.endsWith("/refresh"))
          return Response.json({
            access_token: "token",
            expires_in: 300,
            scope: "savia.api.read",
          });
        if (url.endsWith("/identity/me")) return identities();
        return Response.json({ user: {} });
      },
    });
    const pending = session.getIdentity().catch((error: unknown) => error);
    await vi.waitFor(() => expect(identities).toHaveBeenCalledOnce());
    window.dispatchEvent(new Event("savia:identity-changed"));
    await expect(session.getIdentity()).resolves.toMatchObject({
      id: "current-principal",
    });
    const generation = getSessionGeneration();
    finishPrevious(
      outcome === "successful"
        ? identityResponse("old-principal")
        : new Response(null, { status: 503 }),
    );

    await expect(pending).resolves.toBeInstanceOf(Error);
    await expect(session.getIdentity()).resolves.toMatchObject({
      id: "current-principal",
    });
    expect(getSessionGeneration()).toBe(generation);
    expect(identities).toHaveBeenCalledTimes(2);
  },
);

it("does not reuse the previous principal permissions when token renewal fails", async () => {
  let principal = "principal-a";
  let offline = false;
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (offline) throw new TypeError("Failed to fetch");
    const url = String(input);
    if (url.endsWith("/refresh"))
      return Response.json({
        access_token: "token",
        expires_in: 60,
        scope: "savia.api.read savia.api.write",
      });
    if (url.endsWith("/identity/me"))
      return Response.json({
        data: {
          id: principal,
          attributes: {
            displayName: "User",
            globalRoles: principal === "principal-a" ? ["platform_admin"] : [],
          },
        },
      });
    return Response.json({ user: {} });
  });
  const session = new BetterAuthOAuthSession({
    apiUrl: "https://savia.test",
    fetcher,
  });
  expect((await session.getPermissions()).canManageIdentity).toBe(true);
  principal = "principal-b";
  window.dispatchEvent(new Event("savia:identity-changed"));
  await session.getIdentity();
  window.dispatchEvent(new Event("savia:identity-changed"));
  offline = true;
  const future = Date.now() + 120000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(future);
  try {
    expect((await session.getPermissions()).canManageIdentity).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

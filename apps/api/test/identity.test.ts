import { installExampleSolutionFixture } from "./example-solution-fixtures";
import { env } from "cloudflare:workers";
import { OpenAPIHono } from "@hono/zod-openapi";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./combined-app";
import { createApiShell } from "../src/api-shell";
import { betterAuthUserAdministrator } from "../src/auth/better-auth";
import { authenticationMiddleware } from "../src/auth/middleware";
import { registerIdentityRoutes } from "../src/routes/identity";
import {
  deletePrincipal,
  ensureBootstrapAdministrator,
  findPrincipalBySubject,
  grantMembership,
  setPlatformAdministrator,
  upsertPrincipal,
  setPrincipalActive,
} from "../src/auth/identity-repository";
import { AuthenticationError } from "../src/auth/types";
import { beginPrincipalDeletion } from "../src/auth/tenant-membership-invariants";
import {
  createOAuthResourceAuthenticator,
  serviceBoundOAuthAccessTokenVerifier,
} from "../src/auth/oauth-resource";
import {
  agencyMemberAuthenticator,
  agencyAdministratorAuthenticator,
  platformAdministratorAuthenticator,
} from "./auth-fixtures";

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

async function seedAgency(id = 101): Promise<void> {
  await installExampleSolutionFixture(env.DB, "tenant:0", `tenant:${id}`);
  await env.DB.prepare(
    "INSERT INTO tenants (id, id_slug, name, is_active, created_at, updated_at) VALUES (?, ?, ?, 1, '2026-01-01', '2026-01-01')",
  )
    .bind(id, `identity-acme-${id}`, `Identity Acme ${id}`)
    .run();
}

async function seedPlatformAdministratorForAccessControl(): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO identity_principal(id,issuer,subject,email,display_name,is_active,created_at,updated_at) VALUES('test-platform-admin','savia:better-auth','test-platform-admin','admin@savia.test','Savia Test Administrator',1,'2026-01-01','2026-01-01')",
  ).run();
  await ensureBootstrapAdministrator(env.DB, "test-platform-admin");
}

async function seedCustomAccessRole(
  id: string,
  tenantId: number,
  enabled = true,
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO access_revisions(scope,revision) VALUES(?,0)",
  )
    .bind(`tenant:${tenantId}`)
    .run();
  await env.DB.prepare(
    "INSERT INTO access_roles(id,scope,name,label,description,enabled,protected) VALUES(?,?,?,?,?,?,0)",
  )
    .bind(
      id,
      `tenant:${tenantId}`,
      id.replace(/[^a-z0-9_-]/gi, "_").toLowerCase(),
      id,
      "",
      Number(enabled),
    )
    .run();
}

const oauthIssuer = "https://auth.savia.test/api/auth";
const oauthResource = "https://api.savia.test";
const oauthBearer = "header.payload.signature";

function validOAuthClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: "oauth-administrator",
    scope: "savia.api.read",
    "https://savia.hefesoft.com/roles": ["admin"],
    "https://savia.hefesoft.com/email": "oauth.admin@savia.test",
    "https://savia.hefesoft.com/name": "OAuth Administrator",
    "https://savia.hefesoft.com/two-factor-enabled": true,
    ...overrides,
  };
}

async function signingKey(kid: string) {
  const pair = await generateKeyPair("EdDSA");
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = kid;
  return { ...pair, jwk };
}

async function signedOAuthToken(
  privateKey: CryptoKey,
  kid: string,
  options: {
    issuer?: string;
    audience?: string;
    issuedAt?: number;
  } = {},
) {
  const issuedAt = options.issuedAt ?? Math.floor(Date.now() / 1000);
  return new SignJWT(validOAuthClaims())
    .setProtectedHeader({ alg: "EdDSA", kid })
    .setIssuer(options.issuer ?? oauthIssuer)
    .setAudience(options.audience ?? oauthResource)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 3600)
    .sign(privateKey);
}

function bearerRequest(token: string) {
  return new Request("https://api.savia.test/v1/identity/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function oauthAuthenticator(claims = validOAuthClaims()) {
  return createOAuthResourceAuthenticator({
    issuer: oauthIssuer,
    resource: oauthResource,
    verifyAccessToken: async () => claims,
  });
}

const oauthClientAdministrator = {
  async list() {
    return [
      {
        applicationType: "web",
        clientAuthentication: "none",
        clientId: "existing-public-client",
        clientName: "Existing public client",
        grantTypes: ["authorization_code"],
        redirectUris: ["https://existing.savia.test/callback"],
        scopes: ["openid", "savia.api.read"],
        trusted: false,
      },
    ];
  },
  async create(input: {
    clientAuthentication: string;
    clientName: string;
    redirectUris: string[];
    scopes: string[];
    trusted: boolean;
  }) {
    return {
      applicationType: "web",
      clientAuthentication: input.clientAuthentication,
      clientId: "created-client",
      clientName: input.clientName,
      grantTypes: input.grantTypes ?? ["authorization_code"],
      redirectUris: input.redirectUris,
      scopes: input.scopes,
      trusted: input.trusted,
      ...(input.clientAuthentication === "none"
        ? {}
        : { clientSecret: "returned-once" }),
    };
  },
  async update(
    clientId: string,
    input: { clientName?: string; redirectUris?: string[]; scopes?: string[] },
  ) {
    return {
      applicationType: "web",
      clientAuthentication: "none",
      clientId,
      clientName: input.clientName ?? "Updated client",
      grantTypes: input.grantTypes ?? ["authorization_code"],
      redirectUris: input.redirectUris ?? [
        "https://updated.savia.test/callback",
      ],
      scopes: input.scopes ?? ["openid", "savia.api.read"],
      trusted: false,
    };
  },
  async disable() {},
  async rotateSecret(clientId: string) {
    return { clientId, clientSecret: "rotated-once" };
  },
};

function identityUserAdministrator(
  overrides: Partial<{
    createUser(): Promise<{
      subject: string;
      email: string;
      displayName: string;
    }>;
    listUsers(): Promise<
      Array<{
        subject: string;
        email: string;
        displayName: string;
        role: "admin" | "user";
        isBanned: boolean;
        twoFactorEnabled: boolean;
      }>
    >;
    getUser(subject: string): Promise<{
      subject: string;
      email: string;
      displayName: string;
      role: "admin" | "user";
      isBanned: boolean;
      twoFactorEnabled: boolean;
    }>;
    sendPasswordReset(subject: string): Promise<void>;
  }> = {},
) {
  const accounts = new Map<
    string,
    {
      subject: string;
      email: string;
      displayName: string;
      role: "admin" | "user";
      isBanned: boolean;
      twoFactorEnabled: boolean;
    }
  >();
  return {
    issuer: "savia:better-auth",
    async listUsers() {
      return [...accounts.values()];
    },
    async getUser(subject: string) {
      return {
        subject,
        email: "new.user@acme.test",
        displayName: "New User",
        role: "user" as const,
        isBanned: false,
        twoFactorEnabled: false,
      };
    },
    async createUser(input: {
      email: string;
      firstName: string;
      lastName: string;
      platformAdmin: boolean;
      temporaryPassword?: string;
    }) {
      const account = {
        subject: "better-auth-new-user",
        email: input.email,
        displayName: `${input.firstName} ${input.lastName}`,
        role: input.platformAdmin ? ("admin" as const) : ("user" as const),
        isBanned: false,
        twoFactorEnabled: false,
      };
      accounts.set(account.subject, account);
      return account;
    },
    async updateUser(subject: string) {
      return {
        subject,
        email: "new.user@acme.test",
        displayName: "New User",
        role: "user" as const,
        isBanned: false,
        twoFactorEnabled: false,
      };
    },
    async setAccountActive(subject: string) {
      return {
        subject,
        email: "new.user@acme.test",
        displayName: "New User",
        role: "user" as const,
        isBanned: false,
        twoFactorEnabled: false,
      };
    },
    async revokeSessions() {},
    async sendPasswordReset() {},
    async deleteUser(subject: string) {
      accounts.delete(subject);
    },
    ...overrides,
  };
}

describe("Identity and access", () => {
  it("requires a new MFA-backed sign-in after promoting a tenant member", async () => {
    await seedAgency(101);
    const member = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "promoted-member",
      email: "promoted-member@example.test",
      displayName: "Promoted member",
    });
    const peer = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "promoted-member-peer",
      email: "promoted-member-peer@example.test",
      displayName: "Peer",
    });
    await grantMembership(env.DB, member.id, 101, "viewer");
    await grantMembership(env.DB, peer.id, 101, "viewer");
    const oldSessionStartedAt = Date.now() - 60_000;
    let claims = validOAuthClaims({
      sub: member.subject,
      "https://savia.hefesoft.com/email": member.email,
      "https://savia.hefesoft.com/name": member.displayName,
      "https://savia.hefesoft.com/roles": [],
      "https://savia.hefesoft.com/two-factor-enabled": false,
    });
    const app = createApiShell(
      env.DB,
      undefined,
      undefined,
      createOAuthResourceAuthenticator({
        issuer: oauthIssuer,
        resource: oauthResource,
        verifyAccessToken: async () => claims,
      }),
    );
    registerIdentityRoutes(app, env.DB);
    const identity = () => app.request(bearerRequest(oauthBearer));
    expect((await identity()).status).toBe(200);
    claims = {
      ...claims,
      "https://savia.hefesoft.com/roles": ["admin"],
      "https://savia.hefesoft.com/two-factor-enabled": true,
    };
    // Auth may report the role before the API finishes assigning it.
    expect(await (await identity()).json()).toMatchObject({
      data: { attributes: { globalRoles: [] } },
    });
    await setPlatformAdministrator(env.DB, member.id, true);
    expect((await identity()).status).toBe(401);

    claims = {
      ...claims,
      "https://savia.hefesoft.com/two-factor-enabled": false,
    };
    expect((await identity()).status).toBe(401);

    claims = {
      ...claims,
      "https://savia.hefesoft.com/two-factor-enabled": true,
      "https://savia.hefesoft.com/session-created-at": oldSessionStartedAt,
    };
    expect((await identity()).status).toBe(401);

    claims = {
      ...claims,
      "https://savia.hefesoft.com/roles": [],
      "https://savia.hefesoft.com/two-factor-enabled": false,
    };
    expect((await identity()).status).toBe(401);

    claims = {
      ...claims,
      "https://savia.hefesoft.com/roles": ["admin"],
      "https://savia.hefesoft.com/two-factor-enabled": true,
      "https://savia.hefesoft.com/session-created-at": Date.now() + 1,
    };
    const fresh = await identity();
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(await fresh.json()).toMatchObject({
      data: { attributes: { globalRoles: ["platform_admin"] } },
    });
  });

  it.each(["OAuth", "directory"])(
    "preserves an explicit platform demotion when %s still reports the old role",
    async (source) => {
      await seedAgency(101);
      await seedPlatformAdministratorForAccessControl();
      const issuer = "savia:better-auth";
      const principal = await upsertPrincipal(env.DB, {
        issuer,
        subject: "demoted-administrator",
        email: "demoted-administrator@example.test",
        displayName: "Demoted Administrator",
      });
      await ensureBootstrapAdministrator(env.DB, principal.id);
      const peer = await upsertPrincipal(env.DB, {
        issuer,
        subject: "commercial-peer",
        email: "commercial-peer@example.test",
        displayName: "Commercial Peer",
      });
      await grantMembership(env.DB, peer.id, 101, "viewer");
      const administrator = identityUserAdministrator({
        async listUsers() {
          return [
            {
              subject: principal.subject,
              email: principal.email,
              displayName: principal.displayName,
              role: "admin",
              isBanned: false,
              twoFactorEnabled: true,
            },
          ];
        },
      });
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        platformAdministratorAuthenticator(),
        administrator,
      );
      const changeRole = (body: object) =>
        app.request(`/v1/identity/users/${principal.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const demoted = await changeRole({
        platformAdmin: false,
        membership: { tenantId: 101, role: "viewer" },
      });
      expect(demoted.status, await demoted.clone().text()).toBe(200);

      const appWithOldToken = createApiShell(
        env.DB,
        undefined,
        undefined,
        oauthAuthenticator(
          validOAuthClaims({
            sub: principal.subject,
            "https://savia.hefesoft.com/email": principal.email,
            "https://savia.hefesoft.com/name": principal.displayName,
          }),
        ),
      );
      registerIdentityRoutes(appWithOldToken, env.DB, administrator);
      const response =
        source === "OAuth"
          ? await appWithOldToken.request(bearerRequest(oauthBearer))
          : await app.request("/v1/identity/users");
      expect(response.status, await response.clone().text()).toBe(200);
      const { data } = await response.json<{ data: unknown }>();
      const identity = Array.isArray(data) ? data[0] : data;
      expect(identity).toMatchObject({
        id: principal.id,
        attributes: { globalRoles: [] },
        relationships: {
          memberships: [
            {
              role: "viewer",
              relationships: { tenant: { id: "101" } },
            },
          ],
        },
      });
      expect(
        (
          await appWithOldToken.request("/v1/identity/users", {
            headers: { authorization: `Bearer ${oauthBearer}` },
          })
        ).status,
      ).toBe(403);

      const promoted = await changeRole({ platformAdmin: true });
      expect(promoted.status, await promoted.clone().text()).toBe(200);
      expect(await promoted.json()).toMatchObject({
        data: { attributes: { globalRoles: ["platform_admin"] } },
      });
    },
  );

  it.each(["OAuth token", "session lookup"])(
    "does not restore a permanently deleted principal from an old %s",
    async (credential) => {
      const issuer = "savia:better-auth";
      const account = await upsertPrincipal(env.DB, {
        issuer,
        subject: "removed-oauth-user",
        email: "removed-oauth-user@example.test",
        displayName: "Removed OAuth User",
      });
      await deletePrincipal(env.DB, account.id);
      const authService = {
        fetch: vi.fn(async (request: Request) => {
          if (new URL(request.url).pathname === "/_internal/session")
            return Response.json({
              user: {
                id: account.subject,
                email: account.email,
                name: account.displayName,
                role: "user",
                twoFactorEnabled: false,
              },
            });
          return Response.json({ error: "User not found" }, { status: 404 });
        }),
      };
      const app = createApiShell(
        env.DB,
        undefined,
        authService,
        oauthAuthenticator(
          validOAuthClaims({
            sub: account.subject,
            "https://savia.hefesoft.com/email": account.email,
            "https://savia.hefesoft.com/name": account.displayName,
            "https://savia.hefesoft.com/roles": [],
          }),
        ),
        undefined,
        undefined,
        undefined,
        undefined,
        "local-directory-test",
      );
      registerIdentityRoutes(app, env.DB);

      const response = await (credential === "OAuth token"
        ? app.request(bearerRequest(oauthBearer))
        : app.request("/v1/identity/me", {
            headers: { cookie: "savia.session_token=fixture" },
          }));
      expect(response.status, await response.clone().text()).toBe(401);
      expect(
        await findPrincipalBySubject(env.DB, issuer, account.subject),
      ).toBeUndefined();
    },
  );

  it.each(["active", "deleted during lookup"])(
    "checks a new managed Auth account and only imports it when it is still %s",
    async (state) => {
      const issuer = "savia:better-auth";
      const user = {
        id: "fresh-directory-user",
        email: "fresh-directory-user@example.test",
        name: "Fresh Directory User",
        role: "user",
        isBanned: false,
        twoFactorEnabled: false,
      };
      const fetch = vi.fn(async (request: Request) => {
        expect(new URL(request.url).pathname).toBe(
          `/_internal/users/${user.id}`,
        );
        expect(request.headers.get("x-savia-bridge-key")).toBe(
          "local-directory-test",
        );
        if (state === "deleted during lookup") {
          const imported = await upsertPrincipal(env.DB, {
            issuer,
            subject: user.id,
            email: user.email,
            displayName: user.name,
          });
          await deletePrincipal(env.DB, imported.id);
        }
        return Response.json({ user });
      });
      const app = createApiShell(
        env.DB,
        undefined,
        { fetch },
        oauthAuthenticator(
          validOAuthClaims({
            sub: user.id,
            "https://savia.hefesoft.com/email": user.email,
            "https://savia.hefesoft.com/name": user.name,
            "https://savia.hefesoft.com/roles": [],
          }),
        ),
        undefined,
        undefined,
        undefined,
        undefined,
        "local-directory-test",
      );
      registerIdentityRoutes(app, env.DB);

      const response = await app.request(bearerRequest(oauthBearer));
      const saved = await findPrincipalBySubject(env.DB, issuer, user.id);
      if (state === "active") {
        expect(response.status, await response.clone().text()).toBe(200);
        expect(saved).toMatchObject({
          email: user.email,
          displayName: user.name,
        });
        expect((await app.request(bearerRequest(oauthBearer))).status).toBe(
          200,
        );
      } else {
        expect(response.status, await response.clone().text()).toBe(401);
        expect(saved).toBeUndefined();
      }
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  beforeAll(applyMigrations);
  beforeEach(async () => {
    await env.DB.prepare(
      "DROP TRIGGER IF EXISTS test_identity_capacity_race",
    ).run();
    await env.DB.exec("DELETE FROM identity_tenant_membership");
    await env.DB.exec("DELETE FROM identity_global_role");
    await env.DB.exec("DELETE FROM identity_principal");
    // These fixtures recreate tenant IDs; clear their scoped ACL state as well.
    await env.DB.exec("DELETE FROM access_roles WHERE scope LIKE 'tenant:%'");
    await env.DB.exec(
      "DELETE FROM access_revisions WHERE scope LIKE 'tenant:%'",
    );
    await env.DB.exec("DELETE FROM tenants");
  });

  it("returns only safe identity and active workspaces to recording-scoped OAuth sessions", async () => {
    const actor = {
      principal: {
        id: "mobile-session-principal",
        issuer: "savia:better-auth",
        subject: "mobile-session-subject",
        email: "private@savia.test",
        displayName: "Mobile User",
        isActive: true,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
      credential: {
        kind: "oauth" as const,
        scopes: ["recordings:read", "recordings:upload"],
      },
      globalRoles: [],
      memberships: [
        {
          id: "active-mobile-membership",
          principalId: "mobile-session-principal",
          tenantId: 101,
          agencyId: 101,
          tenantName: "Acme",
          tenantSlug: "acme",
          role: "viewer",
          isActive: true,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
        {
          id: "inactive-mobile-membership",
          principalId: "mobile-session-principal",
          tenantId: 102,
          agencyId: 102,
          tenantName: "Disabled",
          tenantSlug: "disabled",
          role: "viewer",
          isActive: false,
          createdAt: "2026-01-01",
          updatedAt: "2026-01-01",
        },
      ],
    };
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      {
        async authenticate() {
          return actor;
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        enabled: true,
        configuration: {
          effectiveConfigurationFor: async () => ({
            apiKey: "unused",
            model: "unused",
          }),
        },
      },
    );
    const response = await app.request("/v1/companion/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      subject: "mobile-session-subject",
      displayName: "Mobile User",
      workspaces: [{ id: 101, name: "Acme", slug: "acme" }],
      grantedRecordingScopes: ["recordings:read", "recordings:upload"],
    });
    actor.credential.scopes = ["savia.api.read"];
    expect((await app.request("/v1/companion/session")).status).toBe(403);
  });

  it("rejects an API request that has no active Better Auth session", async () => {
    const app = createApp(env.DB, env.DOCUMENTS);

    const response = await app.request("/v1/domains");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTHENTICATION_UNAVAILABLE",
        message: "Authentication is not configured",
      },
    });
  });

  it("proxies Better Auth and accepts its private session service", async () => {
    const authService = {
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/api/auth/sign-in/email") {
          expect(await request.json()).toEqual({
            email: "admin@savia.test",
            password: "session-token",
          });
        }
        if (pathname === "/api/auth/request-password-reset") {
          expect(await request.json()).toEqual({
            email: "admin@savia.test",
          });
        }
        if (pathname === "/_internal/session") {
          expect(request.headers.get("cookie")).toContain(
            "savia.session_token=session-token",
          );
          return Response.json({
            user: {
              id: "better-auth-administrator",
              email: "admin@savia.test",
              name: "Savia Test Administrator",
              role: "admin",
              twoFactorEnabled: true,
            },
          });
        }
        return Response.json({ path: pathname });
      },
    };
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      authService,
    );

    const authResponse = await app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "admin@savia.test",
        password: "session-token",
      }),
    });
    expect(authResponse.status).toBe(200);
    expect(await authResponse.json()).toEqual({
      path: "/api/auth/sign-in/email",
    });

    const passwordResetResponse = await app.request(
      "/api/auth/request-password-reset",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "admin@savia.test" }),
      },
    );
    expect(passwordResetResponse.status).toBe(200);
    expect(await passwordResetResponse.json()).toEqual({
      path: "/api/auth/request-password-reset",
    });

    const identityResponse = await app.request("/v1/identity/me", {
      headers: { cookie: "savia.session_token=session-token" },
    });
    expect(identityResponse.status).toBe(200);
    expect(await identityResponse.json()).toEqual({
      data: expect.objectContaining({
        attributes: expect.objectContaining({ email: "admin@savia.test" }),
      }),
    });
  });

  it("rejects requests without cookies before calling the session service", async () => {
    const fetch = vi.fn(async () => Response.json({ user: null }));
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      { fetch },
    );

    const response = await app.request("/v1/identity/me");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "An active session is required",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves oauth_query when proxying session-creating auth requests", async () => {
    const forwardedBodies: Array<{ path: string; body: unknown }> = [];
    const authService = {
      async fetch(request: Request) {
        forwardedBodies.push({
          path: new URL(request.url).pathname,
          body: await request.json(),
        });
        return Response.json({ ok: true });
      },
    };
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      authService,
    );

    const requests = [
      {
        path: "/api/auth/sign-in/email",
        body: {
          email: "admin@savia.test",
          password: "session-token",
          oauth_query: "client_id=admin&prompt=login&state=opaque",
        },
      },
      {
        path: "/api/auth/two-factor/verify-totp",
        body: {
          code: "123456",
          oauth_query: "client_id=admin&prompt=login&state=opaque",
        },
      },
      {
        path: "/api/auth/two-factor/verify-backup-code",
        body: {
          code: "one-time-recovery-code",
          oauth_query: "client_id=admin&prompt=login&state=opaque",
        },
      },
    ];

    for (const { path, body } of requests) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
    }

    expect(forwardedBodies).toEqual(
      requests.map(({ path, body }) => ({ path, body })),
    );
  });

  it("grants platform access to a Better Auth administrator after a legacy administrator", async () => {
    const legacyPrincipal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "legacy-administrator",
      email: "legacy.admin@savia.test",
      displayName: "Legacy Administrator",
    });
    await ensureBootstrapAdministrator(env.DB, legacyPrincipal.id);
    const authService = {
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/_internal/session") {
          return Response.json({
            user: {
              id: "better-auth-administrator",
              email: "admin@savia.test",
              name: "Savia Test Administrator",
              role: "admin",
              twoFactorEnabled: true,
            },
          });
        }
        return Response.json({ user: null });
      },
    };
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      authService,
    );

    const response = await app.request("/v1/tenants", {
      headers: { cookie: "savia.session_token=session-token" },
    });

    expect(response.status).toBe(200);
  });

  it("does not rewrite complete platform grants on each authenticated request", async () => {
    const identity = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "steady-platform-administrator",
      email: "steady.admin@savia.test",
      displayName: "Steady Administrator",
    });
    await ensureBootstrapAdministrator(env.DB, identity.id);
    const authService = {
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/_internal/session") {
          return Response.json({
            user: {
              id: "steady-platform-administrator",
              email: "steady.admin@savia.test",
              name: "Steady Administrator",
              role: "admin",
              twoFactorEnabled: true,
            },
          });
        }
        return Response.json({ user: null });
      },
    };
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      authService,
    );
    const prepare = vi.spyOn(env.DB, "prepare");

    try {
      const response = await app.request("/v1/identity/me", {
        headers: { cookie: "savia.session_token=session-token" },
      });

      expect(response.status).toBe(200);
      const grantWrites = prepare.mock.calls.filter(([query]) =>
        /INSERT INTO identity_(tenant_membership|global_role)/i.test(
          String(query),
        ),
      );
      expect(grantWrites).toHaveLength(0);
    } finally {
      prepare.mockRestore();
    }
  });

  it("prevents a platform administrator without MFA enrollment from using Savia", async () => {
    const authService = {
      async fetch(request: Request) {
        if (new URL(request.url).pathname === "/_internal/session") {
          return Response.json({
            user: {
              id: "better-auth-administrator-without-mfa",
              email: "admin-without-mfa@savia.test",
              name: "Savia Test Administrator",
              role: "admin",
              twoFactorEnabled: false,
            },
          });
        }
        return Response.json({ user: null });
      },
    };
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      authService,
    );

    const response = await app.request("/v1/identity/me", {
      headers: { cookie: "savia.session_token=session-token" },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: {
        code: "MFA_ENROLLMENT_REQUIRED",
        message:
          "Platform administrators must enroll TOTP multi-factor authentication",
      },
    });
  });

  it("accepts a verified OAuth access token for reads and rejects missing write scope", async () => {
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      oauthAuthenticator(),
    );

    const [read, write] = await Promise.all([
      app.request("/v1/identity/me", {
        headers: { authorization: `Bearer ${oauthBearer}` },
      }),
      app.request("/v1/domains", {
        method: "POST",
        headers: { authorization: `Bearer ${oauthBearer}` },
      }),
    ]);

    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      data: expect.objectContaining({
        attributes: expect.objectContaining({
          email: "oauth.admin@savia.test",
        }),
      }),
    });
    expect(write.status).toBe(403);
    expect(await write.json()).toEqual({
      error: {
        code: "INSUFFICIENT_SCOPE",
        message: "The access token does not grant savia.api.write",
      },
    });
  });

  it("rejects OAuth tokens with malformed claims, missing read scope, or failed verification", async () => {
    const cases = [
      {
        authenticator: oauthAuthenticator(
          validOAuthClaims({ scope: "savia.api.write" }),
        ),
        expected: { status: 403, code: "INSUFFICIENT_SCOPE" },
      },
      {
        authenticator: oauthAuthenticator(
          validOAuthClaims({ "https://savia.hefesoft.com/roles": "admin" }),
        ),
        expected: { status: 401, code: "AUTHENTICATION_REQUIRED" },
      },
      {
        authenticator: createOAuthResourceAuthenticator({
          issuer: oauthIssuer,
          resource: oauthResource,
          verifyAccessToken: async () => {
            throw new Error("wrong audience");
          },
        }),
        expected: { status: 401, code: "AUTHENTICATION_REQUIRED" },
      },
      {
        authenticator: createOAuthResourceAuthenticator({
          issuer: oauthIssuer,
          resource: oauthResource,
          verifyAccessToken: async () => {
            throw new Error("expired token");
          },
        }),
        expected: { status: 401, code: "AUTHENTICATION_REQUIRED" },
      },
    ];

    for (const scenario of cases) {
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        scenario.authenticator,
      );
      const response = await app.request("/v1/identity/me", {
        headers: { authorization: `Bearer ${oauthBearer}` },
      });
      expect(response.status).toBe(scenario.expected.status);
      expect(await response.json()).toEqual({
        error: expect.objectContaining({ code: scenario.expected.code }),
      });
    }
  });

  it("records the verification error category without exposing a rejected bearer token", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const authenticator = createOAuthResourceAuthenticator({
      issuer: oauthIssuer,
      resource: oauthResource,
      verifyAccessToken: async () => {
        throw new TypeError("signature verification failed");
      },
    });

    try {
      await expect(
        authenticator.authenticate(
          new Request("https://api.savia.test/v1/identity/me", {
            headers: { authorization: `Bearer ${oauthBearer}` },
          }),
        ),
      ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

      expect(consoleError).toHaveBeenCalledWith(
        "Savia OAuth access token validation failed: TypeError",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("records a JWKS retrieval failure without exposing its response", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const authenticator = createOAuthResourceAuthenticator({
      issuer: oauthIssuer,
      resource: oauthResource,
      verifyAccessToken: async () => {
        throw new Error("Jwks failed: upstream response omitted");
      },
    });

    try {
      await expect(
        authenticator.authenticate(
          new Request("https://savia.example.test/v1/identity/me", {
            headers: { authorization: "Bearer ignored" },
          }),
        ),
      ).rejects.toMatchObject({ code: "AUTHENTICATION_REQUIRED" });

      expect(consoleError).toHaveBeenCalledWith(
        "Savia OAuth access token validation failed: jwks_fetch_failed",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("verifies an access token with JWKS from the authentication service binding", async () => {
    const { privateKey, publicKey } = await generateKeyPair("EdDSA");
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = "test-key";
    const token = await new SignJWT(validOAuthClaims())
      .setProtectedHeader({ alg: "EdDSA", kid: publicJwk.kid })
      .setIssuer(oauthIssuer)
      .setAudience(oauthResource)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://savia-auth.internal/api/auth/jwks");
      return Response.json({ keys: [publicJwk] });
    });
    const authenticator = createOAuthResourceAuthenticator({
      issuer: oauthIssuer,
      resource: oauthResource,
      verifyAccessToken: serviceBoundOAuthAccessTokenVerifier({ fetch }),
    });

    await expect(
      authenticator.authenticate(
        new Request("https://api.savia.test/v1/identity/me", {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toMatchObject({ subject: "oauth-administrator" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reuses successful JWKS across recreated verifiers until the five-minute TTL expires", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await signingKey("cached-key");
    const token = await signedOAuthToken(key.privateKey, "cached-key", {
      issuedAt: now,
    });
    const fetch = vi.fn(async () => Response.json({ keys: [key.jwk] }));
    const service = { fetch };
    const authenticate = () =>
      createOAuthResourceAuthenticator({
        issuer: `${oauthIssuer}/`,
        resource: `${oauthResource}/`,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);

    try {
      await expect(authenticate()).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      await expect(authenticate()).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      expect(fetch).toHaveBeenCalledTimes(1);

      clock.mockReturnValue((now + 301) * 1000);
      await expect(authenticate()).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("coalesces concurrent first JWKS loads across verifier instances", async () => {
    const key = await signingKey("concurrent-key");
    const token = await signedOAuthToken(key.privateKey, "concurrent-key");
    let finishFetch!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finishFetch = resolve;
    });
    const fetch = vi.fn(() => response);
    const service = { fetch };
    const authenticate = () =>
      createOAuthResourceAuthenticator({
        issuer: oauthIssuer,
        resource: oauthResource,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));

    const one = authenticate();
    const two = authenticate();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    finishFetch(Response.json({ keys: [key.jwk] }));

    await expect(Promise.all([one, two])).resolves.toEqual([
      expect.objectContaining({ subject: "oauth-administrator" }),
      expect.objectContaining({ subject: "oauth-administrator" }),
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("retries failed JWKS loads and fails closed instead of using expired keys", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    const key = await signingKey("expired-cache-key");
    const token = await signedOAuthToken(key.privateKey, "expired-cache-key", {
      issuedAt: now,
    });
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ keys: [key.jwk] }))
      .mockResolvedValueOnce(
        Response.json({ error: "temporarily unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ keys: [key.jwk] }));
    const service = { fetch };
    const authenticate = () =>
      createOAuthResourceAuthenticator({
        issuer: oauthIssuer,
        resource: oauthResource,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);

    try {
      await expect(authenticate()).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      clock.mockReturnValue((now + 301) * 1000);
      await expect(authenticate()).rejects.toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
      expect(fetch).toHaveBeenCalledTimes(2);
      await expect(authenticate()).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("refreshes once for a rotated key and throttles unknown-kid refreshes", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    const oldKey = await signingKey("old-key");
    const newKey = await signingKey("new-key");
    const unknownKey = await signingKey("unknown-key");
    const oldToken = await signedOAuthToken(oldKey.privateKey, "old-key", {
      issuedAt: now,
    });
    const newToken = await signedOAuthToken(newKey.privateKey, "new-key", {
      issuedAt: now,
    });
    const unknownToken = await signedOAuthToken(
      unknownKey.privateKey,
      "unknown-key",
      { issuedAt: now },
    );
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ keys: [oldKey.jwk] }))
      .mockResolvedValueOnce(Response.json({ keys: [oldKey.jwk, newKey.jwk] }))
      .mockResolvedValue(Response.json({ keys: [oldKey.jwk, newKey.jwk] }));
    const service = { fetch };
    const authenticate = (token: string) =>
      createOAuthResourceAuthenticator({
        issuer: oauthIssuer,
        resource: oauthResource,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));
    const clock = vi.spyOn(Date, "now").mockReturnValue(now * 1000);

    try {
      await expect(authenticate(oldToken)).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      await expect(authenticate(newToken)).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      expect(fetch).toHaveBeenCalledTimes(2);

      await expect(authenticate(unknownToken)).rejects.toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
      expect(fetch).toHaveBeenCalledTimes(2);

      clock.mockReturnValue((now + 31) * 1000);
      await expect(authenticate(unknownToken)).rejects.toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      clock.mockRestore();
      consoleError.mockRestore();
    }
  });

  it("invalidates the previous key set after a failed rotation refresh", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    const oldKey = await signingKey("retained-key");
    const unknownKey = await signingKey("unpublished-key");
    const oldToken = await signedOAuthToken(oldKey.privateKey, "retained-key", {
      issuedAt: now,
    });
    const unknownToken = await signedOAuthToken(
      unknownKey.privateKey,
      "unpublished-key",
      { issuedAt: now },
    );
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ keys: [oldKey.jwk] }))
      .mockResolvedValueOnce(
        Response.json({ error: "temporarily unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ keys: [oldKey.jwk] }));
    const service = { fetch };
    const authenticate = (token: string) =>
      createOAuthResourceAuthenticator({
        issuer: oauthIssuer,
        resource: oauthResource,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));

    try {
      await expect(authenticate(oldToken)).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      await expect(authenticate(unknownToken)).rejects.toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
      await expect(authenticate(oldToken)).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      expect(fetch).toHaveBeenCalledTimes(3);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("normalizes direct verifier issuer keys before caching", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await signingKey("direct-verifier-key");
    const normalizedToken = await signedOAuthToken(
      key.privateKey,
      "direct-verifier-key",
      { issuer: oauthIssuer, issuedAt: now },
    );
    const slashToken = await signedOAuthToken(
      key.privateKey,
      "direct-verifier-key",
      { issuer: `${oauthIssuer}/`, issuedAt: now },
    );
    const fetch = vi.fn(async () => Response.json({ keys: [key.jwk] }));
    const verifier = serviceBoundOAuthAccessTokenVerifier({ fetch });

    await expect(
      verifier(bearerRequest(normalizedToken), {
        issuer: oauthIssuer,
        resource: oauthResource,
      }),
    ).resolves.toMatchObject({ sub: "oauth-administrator" });
    await expect(
      verifier(bearerRequest(slashToken), {
        issuer: `${oauthIssuer}/`,
        resource: oauthResource,
      }),
    ).resolves.toMatchObject({ sub: "oauth-administrator" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("isolates the public-key cache by service binding and normalized issuer", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = await signingKey("isolated-key");
    const serviceFetch = vi.fn(async () => Response.json({ keys: [key.jwk] }));
    const serviceOne = { fetch: serviceFetch };
    const tokenOne = await signedOAuthToken(key.privateKey, "isolated-key", {
      issuedAt: now,
    });
    const authenticate = (
      service: { fetch: (request: Request) => Promise<Response> },
      issuer: string,
      token: string,
    ) =>
      createOAuthResourceAuthenticator({
        issuer,
        resource: oauthResource,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));

    await expect(
      authenticate(serviceOne, oauthIssuer, tokenOne),
    ).resolves.toMatchObject({ subject: "oauth-administrator" });
    await expect(
      authenticate(serviceOne, `${oauthIssuer}/`, tokenOne),
    ).resolves.toMatchObject({ subject: "oauth-administrator" });
    expect(serviceFetch).toHaveBeenCalledTimes(1);

    const serviceTwoFetch = vi.fn(async () =>
      Response.json({ keys: [key.jwk] }),
    );
    const tokenTwo = await signedOAuthToken(key.privateKey, "isolated-key", {
      issuer: `${oauthIssuer}/other`,
      issuedAt: now,
    });
    await expect(
      authenticate({ fetch: serviceTwoFetch }, oauthIssuer, tokenOne),
    ).resolves.toMatchObject({ subject: "oauth-administrator" });
    await expect(
      authenticate(serviceOne, `${oauthIssuer}/other`, tokenTwo),
    ).resolves.toMatchObject({ subject: "oauth-administrator" });
    expect(serviceTwoFetch).toHaveBeenCalledTimes(1);
    expect(serviceFetch).toHaveBeenCalledTimes(2);
  });

  it("continues checking issuer and audience for every token with cached JWKS", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1000);
    const key = await signingKey("claims-key");
    const validToken = await signedOAuthToken(key.privateKey, "claims-key", {
      issuedAt: now,
    });
    const wrongAudienceToken = await signedOAuthToken(
      key.privateKey,
      "claims-key",
      { audience: "https://other-api.savia.test", issuedAt: now },
    );
    const wrongIssuerToken = await signedOAuthToken(
      key.privateKey,
      "claims-key",
      { issuer: "https://other-auth.savia.test/api/auth", issuedAt: now },
    );
    const fetch = vi.fn(async () => Response.json({ keys: [key.jwk] }));
    const service = { fetch };
    const authenticate = (token: string) =>
      createOAuthResourceAuthenticator({
        issuer: oauthIssuer,
        resource: oauthResource,
        verifyAccessToken: serviceBoundOAuthAccessTokenVerifier(service),
      }).authenticate(bearerRequest(token));

    try {
      await expect(authenticate(validToken)).resolves.toMatchObject({
        subject: "oauth-administrator",
      });
      await expect(authenticate(wrongAudienceToken)).rejects.toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
      await expect(authenticate(wrongIssuerToken)).rejects.toMatchObject({
        code: "AUTHENTICATION_REQUIRED",
      });
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("publishes protected-resource metadata for OAuth clients", async () => {
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      oauthAuthenticator(),
    );

    const response = await app.request("/.well-known/oauth-protected-resource");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      resource: oauthResource,
      authorization_servers: [oauthIssuer],
      scopes_supported: [
        "savia.api.read",
        "savia.api.write",
        "recordings:read",
        "recordings:upload",
        "recordings:process",
        "recordings:delete",
      ],
    });
  });

  it("allows only platform administrators to manage OAuth clients and never returns a public secret", async () => {
    const administratorApp = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      undefined,
      undefined,
      undefined,
      undefined,
      oauthClientAdministrator,
    );
    const memberApp = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      agencyMemberAuthenticator(),
      undefined,
      undefined,
      undefined,
      undefined,
      oauthClientAdministrator,
    );

    const [listed, forbidden, created] = await Promise.all([
      administratorApp.request("/v1/identity/oauth-clients"),
      memberApp.request("/v1/identity/oauth-clients"),
      administratorApp.request("/v1/identity/oauth-clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          clientName: "Front office",
          redirectUris: ["https://front.savia.test/callback"],
          scopes: ["openid", "savia.api.read"],
          clientAuthentication: "none",
          trusted: false,
        }),
      }),
    ]);

    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({
      data: [expect.objectContaining({ clientId: "existing-public-client" })],
    });
    expect(forbidden.status).toBe(403);
    expect(created.status).toBe(201);
    const createdData = await created.json<{ data: Record<string, unknown> }>();
    expect(createdData.data).toEqual(
      expect.objectContaining({ clientId: "created-client" }),
    );
    expect(createdData.data).not.toHaveProperty("clientSecret");
  });

  it("reveals a confidential client secret only at creation or rotation", async () => {
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      undefined,
      undefined,
      undefined,
      undefined,
      oauthClientAdministrator,
    );

    const created = await app.request("/v1/identity/oauth-clients", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientName: "Back office",
        redirectUris: ["https://back.savia.test/callback"],
        scopes: ["openid", "savia.api.read", "savia.api.write"],
        clientAuthentication: "client_secret_post",
        trusted: false,
      }),
    });
    const rotated = await app.request(
      "/v1/identity/oauth-clients/confidential-client/rotate-secret",
      { method: "POST" },
    );

    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      data: expect.objectContaining({ clientSecret: "returned-once" }),
    });
    expect(rotated.status).toBe(200);
    expect(await rotated.json()).toEqual({
      data: { clientId: "confidential-client", clientSecret: "rotated-once" },
    });
  });

  it("returns the authenticated principal and its authorization data", async () => {
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
    );

    const response = await app.request("/v1/identity/me");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        id: "test-platform-admin",
        kind: "identity-principal",
        attributes: {
          email: "admin@savia.test",
          displayName: "Savia Test Administrator",
          isActive: true,
          globalRoles: ["platform_admin"],
        },
        relationships: { memberships: [] },
      },
    });
  });

  it("allows only platform administrators to list Savia users", async () => {
    const administratorApp = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator(),
    );
    const memberApp = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      agencyMemberAuthenticator(),
    );

    const [administratorResponse, memberResponse] = await Promise.all([
      administratorApp.request("/v1/identity/users"),
      memberApp.request("/v1/identity/users"),
    ]);

    expect(administratorResponse.status).toBe(200);
    expect(await administratorResponse.json()).toEqual({ data: [] });
    expect(memberResponse.status).toBe(403);
    expect(await memberResponse.json()).toEqual({
      error: {
        code: "AUTHORIZATION_FORBIDDEN",
        message: "A tenant administrator role is required",
      },
    });
  });

  it("lets a tenant administrator manage users only inside the active tenant", async () => {
    await seedAgency(101);
    await seedAgency(202);
    const foreign = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "foreign-tenant-user",
      email: "foreign@savia.test",
      displayName: "Foreign User",
    });
    await (
      await import("../src/auth/identity-repository")
    ).grantMembership(env.DB, foreign.id, 202, "operator");
    const administrator = identityUserAdministrator({
      async listUsers() {
        return [
          {
            subject: "foreign-tenant-user",
            email: "foreign@savia.test",
            displayName: "Foreign User",
            role: "user",
            isBanned: false,
            twoFactorEnabled: false,
          },
        ];
      },
      async getUser(subject) {
        return {
          subject,
          email: "own-tenant@savia.test",
          displayName: "Own Tenant",
          role: "user",
          isBanned: false,
          twoFactorEnabled: false,
        };
      },
    });
    const createUser = vi.spyOn(administrator, "createUser");
    const updateUser = vi.spyOn(administrator, "updateUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      agencyAdministratorAuthenticator(),
      administrator,
    );

    const list = await app.request("/v1/identity/users");
    const rejectedCrossTenantCreate = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "cross-tenant@savia.test",
        firstName: "Cross",
        lastName: "Tenant",
        platformAdmin: false,
        membership: { tenantId: 202, role: "operator" },
      }),
    });
    const rejectedPlatformAdminCreate = await app.request(
      "/v1/identity/users",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "platform@savia.test",
          firstName: "Platform",
          lastName: "Admin",
          platformAdmin: true,
        }),
      },
    );
    const foreignDetail = await app.request(`/v1/identity/users/${foreign.id}`);
    const foreignUpdate = await app.request(
      `/v1/identity/users/${foreign.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ firstName: "Changed" }),
      },
    );
    const ownTenantCreate = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "own-tenant@savia.test",
        firstName: "Own",
        lastName: "Tenant",
        membership: { role: "operator", tenantId: 101 },
      }),
    });
    const ownTenantList = await app.request("/v1/identity/users");

    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [] });
    expect(rejectedCrossTenantCreate.status).toBe(404);
    expect(rejectedPlatformAdminCreate.status).toBe(404);
    expect(foreignDetail.status).toBe(404);
    expect(foreignUpdate.status).toBe(404);
    expect(ownTenantCreate.status).toBe(201);
    expect(createUser).toHaveBeenCalledOnce();
    expect(ownTenantList.status).toBe(200);
    expect(await ownTenantList.json()).toEqual({
      data: [
        expect.objectContaining({
          attributes: expect.objectContaining({
            email: "own-tenant@savia.test",
          }),
        }),
      ],
    });
    expect(updateUser).not.toHaveBeenCalled();
  });

  it.each(["too-short", "a".repeat(129)])(
    "identifies invalid temporary password length before provisioning",
    async (temporaryPassword) => {
      await seedAgency(101);
      const administrator = identityUserAdministrator();
      const createUser = vi.spyOn(administrator, "createUser");
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        platformAdministratorAuthenticator(),
        administrator,
      );
      const response = await app.request("/v1/identity/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "invalid-password@savia.test",
          firstName: "New",
          lastName: "User",
          membership: { tenantId: 101, role: "viewer" },
          temporaryPassword,
        }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: "USER_TEMPORARY_PASSWORD_INVALID",
          message: "The temporary password must contain 12 to 128 characters.",
        },
      });
      expect(createUser).not.toHaveBeenCalled();
    },
  );

  it.each(["POST", "PATCH"])(
    "rejects whitespace-only name fields in %s user requests before calling Auth",
    async (method) => {
      await seedAgency(101);
      const principal = await upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "blank-name-user",
        email: "blank-name@savia.test",
        displayName: "Existing Name",
      });
      const administrator = identityUserAdministrator();
      const createUser = vi.spyOn(administrator, "createUser");
      const updateUser = vi.spyOn(administrator, "updateUser");
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        platformAdministratorAuthenticator(),
        administrator,
      );
      const response = await app.request(
        method === "POST"
          ? "/v1/identity/users"
          : `/v1/identity/users/${principal.id}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            method === "POST"
              ? {
                  email: "new-name@savia.test",
                  firstName: "New",
                  lastName: " \t ",
                  membership: { tenantId: 101, role: "viewer" },
                }
              : { firstName: " \t " },
          ),
        },
      );
      expect(response.status).toBe(400);
      expect(createUser).not.toHaveBeenCalled();
      expect(updateUser).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      method: "POST",
      destination: 202,
      status: 409,
      code: "COMMERCIAL_TENANT_REQUIRED",
    },
    { method: "POST", destination: 303, status: 404, code: "TENANT_NOT_FOUND" },
    {
      method: "PATCH",
      destination: 202,
      status: 409,
      code: "COMMERCIAL_TENANT_REQUIRED",
    },
    {
      method: "PATCH",
      destination: 303,
      status: 404,
      code: "TENANT_NOT_FOUND",
    },
  ])(
    "rejects $method transfer to unavailable tenant $destination before updating Auth",
    async ({ method, destination, status, code }) => {
      await seedAgency(101);
      await seedAgency(202);
      await env.DB.prepare("UPDATE tenants SET is_active=0 WHERE id=202").run();
      const principal = await upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "unavailable-destination-user",
        email: "unavailable-destination@savia.test",
        displayName: "Unavailable Destination",
      });
      const { grantMembership } =
        await import("../src/auth/identity-repository");
      await grantMembership(env.DB, principal.id, 101, "operator");
      const administrator = identityUserAdministrator();
      const updateUser = vi.spyOn(administrator, "updateUser");
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        platformAdministratorAuthenticator(),
        administrator,
      );
      const membership = { tenantId: destination, role: "viewer" };
      const response = await app.request(
        `/v1/identity/users/${principal.id}${method === "POST" ? "/memberships" : ""}`,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            method === "POST"
              ? membership
              : { firstName: "Changed", lastName: "Name", membership },
          ),
        },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
      expect(updateUser).not.toHaveBeenCalled();
      expect(
        await env.DB.prepare(
          "SELECT tenant_id, role FROM identity_tenant_membership WHERE principal_id=?",
        )
          .bind(principal.id)
          .first(),
      ).toEqual({ tenant_id: 101, role: "operator" });
      expect(
        await env.DB.prepare(
          "SELECT display_name FROM identity_principal WHERE id=?",
        )
          .bind(principal.id)
          .first(),
      ).toEqual({ display_name: principal.displayName });
    },
  );

  it.each([
    { destination: 202, tenantRooms: ["tenant:101", "tenant:202"] },
    { destination: 101, tenantRooms: ["tenant:101"] },
  ])(
    "notifies all affected tenants of assignment to $destination",
    async ({ destination, tenantRooms }) => {
      await seedAgency(101);
      await seedAgency(202);
      const principal = await upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "membership-event-user",
        email: "membership-event@savia.test",
        displayName: "Membership Event",
      });
      const remaining = await upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "remaining-active-user",
        email: "remaining-active@savia.test",
        displayName: "Remaining Active",
      });
      const { grantMembership } =
        await import("../src/auth/identity-repository");
      await grantMembership(env.DB, principal.id, 101, "operator");
      await grantMembership(env.DB, remaining.id, 101, "viewer");
      const publish = vi.fn();
      const app = new OpenAPIHono();
      app.use(
        "*",
        authenticationMiddleware(env.DB, platformAdministratorAuthenticator()),
      );
      registerIdentityRoutes(
        app,
        env.DB,
        identityUserAdministrator(),
        undefined,
        {
          publish,
          issue: vi.fn(),
          forward: vi.fn(),
        },
      );
      const response = await app.request(
        `/v1/identity/users/${principal.id}/memberships`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tenantId: destination, role: "viewer" }),
        },
      );
      expect(response.status).toBe(201);
      expect(
        publish.mock.calls.filter(
          ([, event]) => event.topic === "access-control",
        ),
      ).toEqual(
        tenantRooms.map((room) => [
          room,
          {
            topic: "access-control",
            type: "updated",
            collection: "memberships",
            id: principal.id,
            actor: "test-platform-admin",
          },
        ]),
      );
      expect(publish).toHaveBeenCalledWith(
        "platform",
        expect.objectContaining({
          topic: "users",
          id: principal.id,
        }),
      );
    },
  );

  it("notifies the tenant and platform lists after a tenant administrator edits a user", async () => {
    await seedAgency(101);
    const principal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "profile-event-user",
      email: "profile-event@savia.test",
      displayName: "Profile Event",
    });
    const { grantMembership } = await import("../src/auth/identity-repository");
    await grantMembership(env.DB, principal.id, 101, "viewer");
    const publish = vi.fn();
    const app = new OpenAPIHono();
    app.use(
      "*",
      authenticationMiddleware(env.DB, agencyAdministratorAuthenticator()),
    );
    registerIdentityRoutes(
      app,
      env.DB,
      identityUserAdministrator(),
      undefined,
      {
        publish,
        issue: vi.fn(),
        forward: vi.fn(),
      },
    );
    const response = await app.request(`/v1/identity/users/${principal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Updated",
        lastName: "Name",
        emailVerified: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(publish).toHaveBeenCalledWith(
      "tenant:101",
      expect.objectContaining({
        topic: "access-control",
        type: "updated",
        collection: "memberships",
        id: principal.id,
      }),
    );
    expect(publish).toHaveBeenCalledWith(
      "platform",
      expect.objectContaining({
        topic: "users",
        type: "updated",
        id: principal.id,
      }),
    );
  });

  it("notifies the tenant when a user is suspended, reactivated, or deleted", async () => {
    await seedAgency(101);
    const principal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "status-event-user",
      email: "status-event@savia.test",
      displayName: "Status Event",
    });
    const remaining = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "remaining-status-user",
      email: "remaining-status@savia.test",
      displayName: "Remaining Active",
    });
    const { grantMembership } = await import("../src/auth/identity-repository");
    await grantMembership(env.DB, principal.id, 101, "operator");
    await grantMembership(env.DB, remaining.id, 101, "viewer");
    const publish = vi.fn();
    const app = new OpenAPIHono();
    app.use(
      "*",
      authenticationMiddleware(env.DB, platformAdministratorAuthenticator()),
    );
    registerIdentityRoutes(
      app,
      env.DB,
      identityUserAdministrator(),
      undefined,
      {
        publish,
        issue: vi.fn(),
        forward: vi.fn(),
      },
    );
    const path = `/v1/identity/users/${principal.id}`;
    for (const [url, method] of [
      [`${path}/suspension`, "POST"],
      [`${path}/suspension`, "DELETE"],
      [path, "DELETE"],
    ]) {
      publish.mockClear();
      expect((await app.request(url, { method })).status).toBe(204);
      expect(publish).toHaveBeenCalledWith(
        "tenant:101",
        expect.objectContaining({
          topic: "access-control",
          type: "updated",
          collection: "memberships",
          id: principal.id,
        }),
      );
      expect(publish).toHaveBeenCalledWith(
        "platform",
        expect.objectContaining({ topic: "users", id: principal.id }),
      );
    }
  });

  it("restores the auth email tenant when a membership change is rejected", async () => {
    await seedAgency(101);
    await seedAgency(202);
    const principal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "email-tenant-rollback-user",
      email: "email-tenant-rollback@savia.test",
      displayName: "Email Tenant Rollback",
    });
    const { grantMembership } = await import("../src/auth/identity-repository");
    await grantMembership(env.DB, principal.id, 101, "operator");
    const administrator = identityUserAdministrator();
    const updateUser = vi.spyOn(administrator, "updateUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    const response = await app.request(
      `/v1/identity/users/${principal.id}/memberships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tenantId: 202, role: "viewer" }),
      },
    );

    expect(response.status).toBe(409);
    expect(updateUser).toHaveBeenNthCalledWith(
      1,
      principal.subject,
      { tenantId: 202 },
      expect.any(Request),
    );
    expect(updateUser).toHaveBeenNthCalledWith(
      2,
      principal.subject,
      { tenantId: 101 },
      expect.any(Request),
    );
    expect(
      await env.DB.prepare(
        "SELECT tenant_id FROM identity_tenant_membership WHERE principal_id=?",
      )
        .bind(principal.id)
        .first(),
    ).toEqual({ tenant_id: 101 });
  });

  it("restores profile and Auth settings when an identity update cannot change membership", async () => {
    await seedAgency(101);
    await seedAgency(202);
    const principal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "email-tenant-update-rollback-user",
      email: "email-tenant-update-rollback@savia.test",
      displayName: "Email Tenant Update Rollback",
    });
    const { grantMembership } = await import("../src/auth/identity-repository");
    await grantMembership(env.DB, principal.id, 101, "operator");
    const administrator = identityUserAdministrator();
    const updateUser = vi.spyOn(administrator, "updateUser");
    vi.spyOn(administrator, "getUser").mockResolvedValue({
      subject: principal.subject,
      email: principal.email,
      displayName: "Saved Auth Name",
      role: "user",
      isBanned: false,
      twoFactorEnabled: false,
      emailVerified: false,
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    const response = await app.request(`/v1/identity/users/${principal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: "Changed",
        lastName: "Display Name",
        emailVerified: true,
        membership: { tenantId: 202, role: "viewer" },
      }),
    });

    expect(response.status).toBe(409);
    expect(updateUser).toHaveBeenNthCalledWith(
      1,
      principal.subject,
      expect.objectContaining({
        tenantId: 202,
        displayName: "Changed Display Name",
        emailVerified: true,
      }),
      expect.any(Request),
    );
    expect(updateUser).toHaveBeenNthCalledWith(
      2,
      principal.subject,
      { tenantId: 101, displayName: "Saved Auth Name", emailVerified: false },
      expect.any(Request),
    );
    expect(
      await env.DB.prepare(
        "SELECT tenant_id FROM identity_tenant_membership WHERE principal_id=?",
      )
        .bind(principal.id)
        .first(),
    ).toEqual({ tenant_id: 101 });
    expect(
      await env.DB.prepare(
        "SELECT display_name FROM identity_principal WHERE id=?",
      )
        .bind(principal.id)
        .first(),
    ).toEqual({ display_name: principal.displayName });
  });

  it("restores the Auth role of a platform administrator when demotion loses its destination", async () => {
    await seedAgency(101);
    await seedPlatformAdministratorForAccessControl();
    const principal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "rejected-platform-demotion",
      email: "rejected-platform-demotion@example.test",
      displayName: "Platform Rollback",
    });
    await setPlatformAdministrator(env.DB, principal.id, true);
    const account = {
      id: principal.subject,
      email: principal.email,
      name: principal.displayName,
      role: "admin",
      isBanned: false,
      twoFactorEnabled: true,
      tenantId: null as number | null,
    };
    const auth = betterAuthUserAdministrator(
      {
        async fetch(request) {
          expect(request.method).toBe("PATCH");
          const input = (await request.json()) as {
            role: string;
            tenantId: number | null;
          };
          // Auth uses null for the platform and accepts only positive tenant IDs.
          if (input.tenantId !== null && input.tenantId < 1)
            return Response.json(
              { error: { code: "VALIDATION_ERROR" } },
              { status: 400 },
            );
          Object.assign(account, input);
          if (input.tenantId === 101)
            await env.DB.prepare(
              "UPDATE tenants SET is_active=0 WHERE id=101",
            ).run();
          return Response.json({ user: account });
        },
      },
      "synthetic-auth-bridge",
    );
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      auth,
    );

    const response = await app.request(`/v1/identity/users/${principal.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platformAdmin: false,
        membership: { tenantId: 101, role: "viewer" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "COMMERCIAL_TENANT_REQUIRED" },
    });
    expect(account).toMatchObject({ role: "admin", tenantId: null });
    expect(
      await env.DB.prepare(
        "SELECT tenant_id FROM identity_tenant_membership WHERE principal_id=?",
      )
        .bind(principal.id)
        .first(),
    ).toEqual({ tenant_id: 0 });
  });

  it("does not update Auth when a user membership is unchanged by DELETE", async () => {
    await seedAgency(101);
    await seedAgency(202);
    const principal = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "membership-delete-noop",
      email: "membership-delete-noop@example.test",
      displayName: "Existing Member",
    });
    await grantMembership(env.DB, principal.id, 101, "viewer");
    const administrator = identityUserAdministrator();
    const updateUser = vi.spyOn(administrator, "updateUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );
    const path = `/v1/identity/users/${principal.id}/memberships/`;
    expect((await app.request(path + "101", { method: "DELETE" })).status).toBe(
      409,
    );
    expect((await app.request(path + "202", { method: "DELETE" })).status).toBe(
      204,
    );
    expect(updateUser).not.toHaveBeenCalled();
  });

  it.each([
    ["tenant", agencyAdministratorAuthenticator],
    ["platform", platformAdministratorAuthenticator],
  ] as const)(
    "checks tenant active-user capacity before %s admin provisions an auth account",
    async (_scope, authenticate) => {
      await seedAgency(101);
      await env.DB.prepare(
        "INSERT INTO tenant_user_limits(tenant_id,max_active_users) VALUES(101,0)",
      ).run();
      const administrator = identityUserAdministrator();
      const createUser = vi.spyOn(administrator, "createUser");
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        authenticate(),
        administrator,
      );

      const response = await app.request("/v1/identity/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "at-capacity@savia.test",
          firstName: "At",
          lastName: "Capacity",
          membership: { role: "operator", tenantId: 101 },
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { code: "TENANT_ACTIVE_USER_LIMIT_REACHED" },
      });
      expect(createUser).not.toHaveBeenCalled();
    },
  );

  it("rejects an inactive provisioning destination before creating the auth account", async () => {
    await seedAgency(101);
    await env.DB.prepare("UPDATE tenants SET is_active=0 WHERE id=101").run();
    const administrator = identityUserAdministrator();
    const createUser = vi.spyOn(administrator, "createUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );
    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "inactive-destination@savia.test",
        firstName: "Inactive",
        lastName: "Destination",
        membership: { role: "viewer", tenantId: 101 },
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "COMMERCIAL_TENANT_REQUIRED" },
    });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("rolls back the auth account if the final membership capacity guard rejects creation", async () => {
    await seedAgency(101);
    await env.DB.prepare(
      `CREATE TRIGGER test_identity_capacity_race
      BEFORE INSERT ON identity_tenant_membership WHEN NEW.tenant_id=101
      BEGIN SELECT RAISE(ABORT, 'TENANT_ACTIVE_USER_LIMIT_REACHED'); END`,
    ).run();
    const administrator = identityUserAdministrator();
    const createUser = vi.spyOn(administrator, "createUser");
    const deleteUser = vi.spyOn(administrator, "deleteUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      agencyAdministratorAuthenticator(),
      administrator,
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "capacity-race@savia.test",
        firstName: "Capacity",
        lastName: "Race",
        membership: { role: "operator", tenantId: 101 },
      }),
    });

    expect(response.status).toBe(409);
    expect(createUser).toHaveBeenCalledOnce();
    expect(deleteUser).toHaveBeenCalledOnce();
    expect(
      await findPrincipalBySubject(
        env.DB,
        "savia:better-auth",
        "better-auth-new-user",
      ),
    ).toBeFalsy();
    await env.DB.prepare("DROP TRIGGER test_identity_capacity_race").run();
  });

  it("provisions a Better Auth user and stores only its identity and membership", async () => {
    await seedAgency();
    const administrator = identityUserAdministrator();
    const createUser = vi.spyOn(administrator, "createUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "new.user@acme.test",
        firstName: "New",
        lastName: "User",
        platformAdmin: false,
        emailVerified: true,
        membership: { agencyId: 101, role: "operator" },
      }),
    });

    expect(response.status).toBe(201);
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        emailVerified: true,
        tenantId: 101,
      }),
      expect.any(Request),
    );
    const created = await response.json<{
      data: { id: string; kind: string; attributes: { email: string } };
    }>();
    expect(created.data).toEqual(
      expect.objectContaining({
        kind: "identity-principal",
        attributes: expect.objectContaining({ email: "new.user@acme.test" }),
      }),
    );
    expect(JSON.stringify(created)).not.toContain("password");

    const users = await app.request("/v1/identity/users");
    expect(await users.json()).toEqual({
      data: [
        expect.objectContaining({
          id: created.data.id,
          relationships: {
            memberships: [
              expect.objectContaining({
                role: "operator",
                relationships: { tenant: { id: "101" }, agency: { id: "101" } },
              }),
            ],
          },
        }),
      ],
    });

    await seedAgency(102);
    const membershipResponse = await app.request(
      `/v1/identity/users/${created.data.id}/memberships`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agencyId: 102, role: "viewer" }),
      },
    );
    expect(membershipResponse.status).toBe(409);
    expect(await membershipResponse.json()).toMatchObject({
      error: { code: "LAST_ACTIVE_MEMBER" },
    });

    const deleteResponse = await app.request(
      `/v1/identity/users/${created.data.id}`,
      { method: "DELETE" },
    );
    expect(deleteResponse.status).toBe(409);
    expect(await deleteResponse.json()).toMatchObject({
      error: { code: "LAST_ACTIVE_MEMBER" },
    });
  });

  it("assigns enabled custom roles in the new member's tenant", async () => {
    await seedAgency();
    await seedPlatformAdministratorForAccessControl();
    await seedCustomAccessRole("custom-test-role", 101);
    const administrator = identityUserAdministrator();
    const createUser = vi.spyOn(administrator, "createUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "custom-role.user@acme.test",
        firstName: "Custom",
        lastName: "Role User",
        membership: { tenantId: 101, role: "operator" },
        accessRoleIds: ["custom-test-role"],
      }),
    });

    expect(response.status).toBe(201);
    const created = await response.json<{ data: { id: string } }>();
    expect(createUser).toHaveBeenCalledOnce();
    const assignedRoles = await env.DB.prepare(
      "SELECT role_id FROM access_assignments WHERE scope='tenant:101' AND principal_id=?",
    )
      .bind(created.data.id)
      .all<{ role_id: string }>();
    expect(assignedRoles.results.map((row) => row.role_id)).toContain(
      "custom-test-role",
    );
    expect(
      await env.DB.prepare(
        "SELECT action,target_id FROM access_audit WHERE action='assignments.saved' AND target_id=?",
      )
        .bind(created.data.id)
        .all(),
    ).toMatchObject({
      results: [{ action: "assignments.saved", target_id: created.data.id }],
    });
  });

  it("provisions a user with all 100 allowed custom roles", async () => {
    await seedAgency();
    await seedPlatformAdministratorForAccessControl();
    const roleIds = Array.from(
      { length: 100 },
      (_, index) => `custom-${index}`,
    );
    for (const roleId of roleIds) {
      await seedCustomAccessRole(roleId, 101);
    }
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator(),
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "maximum-custom-roles@acme.test",
        firstName: "Custom",
        lastName: "Roles",
        temporaryPassword: "DemoPassword123!",
        membership: { tenantId: 101, role: "operator" },
        accessRoleIds: roleIds,
      }),
    });

    expect(response.status, await response.clone().text()).toBe(201);
    const created = await response.json<{ data: { id: string } }>();
    const assignedRoles = await env.DB.prepare(
      "SELECT role_id FROM access_assignments WHERE scope='tenant:101' AND principal_id=?",
    )
      .bind(created.data.id)
      .all<{ role_id: string }>();
    expect(assignedRoles.results.map((row) => row.role_id).sort()).toEqual(
      ["builtin:tenant:101:operator", ...roleIds].sort(),
    );
  });

  it("assigns platform custom roles in tenant:0 to a new platform administrator", async () => {
    await seedAgency();
    await seedPlatformAdministratorForAccessControl();
    await seedCustomAccessRole("custom-platform-role", 0);
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator(),
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "platform-custom-role@savia.test",
        firstName: "Platform",
        lastName: "Custom Role",
        platformAdmin: true,
        accessRoleIds: ["custom-platform-role"],
      }),
    });

    expect(response.status).toBe(201);
    const created = await response.json<{ data: { id: string } }>();
    const assigned = await env.DB.prepare(
      "SELECT role_id FROM access_assignments WHERE scope='tenant:0' AND principal_id=?",
    )
      .bind(created.data.id)
      .all<{ role_id: string }>();
    expect(assigned.results.map((row) => row.role_id)).toContain(
      "custom-platform-role",
    );
  });

  it("compensates provisioning if a selected custom role becomes unavailable", async () => {
    await seedAgency();
    await seedPlatformAdministratorForAccessControl();
    await seedCustomAccessRole("custom-racing-role", 101);
    const administrator = identityUserAdministrator({
      async createUser() {
        await env.DB.prepare(
          "UPDATE access_roles SET enabled=0 WHERE scope='tenant:101' AND id='custom-racing-role'",
        ).run();
        return {
          subject: "better-auth-racing-user",
          email: "racing-role@savia.test",
          displayName: "Racing Role",
        };
      },
    });
    const deleteUser = vi.spyOn(administrator, "deleteUser");
    const sendPasswordReset = vi.spyOn(administrator, "sendPasswordReset");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "racing-role@savia.test",
        firstName: "Racing",
        lastName: "Role",
        membership: { tenantId: 101, role: "operator" },
        accessRoleIds: ["custom-racing-role"],
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_ACCESS_ROLE" },
    });
    expect(deleteUser).toHaveBeenCalledOnce();
    expect(sendPasswordReset).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT id FROM identity_principal WHERE subject=?")
        .bind("better-auth-racing-user")
        .first(),
    ).toBeNull();
  });

  it("rejects missing, foreign-scope, and disabled roles before external provisioning", async () => {
    await seedAgency();
    await seedAgency(102);
    await seedPlatformAdministratorForAccessControl();
    await seedCustomAccessRole("custom-foreign-role", 102);
    await seedCustomAccessRole("custom-disabled-role", 101, false);
    const administrator = identityUserAdministrator();
    const createUser = vi.spyOn(administrator, "createUser");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    for (const accessRoleId of [
      "missing-custom-role",
      "custom-foreign-role",
      "custom-disabled-role",
    ]) {
      const response = await app.request("/v1/identity/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: `${accessRoleId}@acme.test`,
          firstName: "Invalid",
          lastName: "Role",
          membership: { tenantId: 101, role: "operator" },
          accessRoleIds: [accessRoleId],
        }),
      });

      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { code: "INVALID_ACCESS_ROLE" },
      });
    }
    expect(createUser).not.toHaveBeenCalled();
  });

  it("rejects provisioning an ordinary user without a tenant", async () => {
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator(),
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "no-tenant@savia.test",
        firstName: "No",
        lastName: "Tenant",
      }),
    });

    expect(response.status).toBe(400);
  });

  it("moves a promoted administrator to the internal tenant", async () => {
    await seedAgency();
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator(),
    );
    const created = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "promote@savia.test",
        firstName: "Promote",
        lastName: "User",
        membership: { tenantId: 101, role: "tenant_admin" },
      }),
    });
    const { data } = await created.json<{ data: { id: string } }>();
    await env.DB.exec(
      "INSERT INTO identity_principal(id,issuer,subject,email,display_name,is_active,created_at,updated_at) VALUES('supporting-member','test','supporting-member','supporting@savia.test','Supporting Member',1,'2026-09-15','2026-09-15')",
    );
    await env.DB.exec(
      "INSERT INTO identity_tenant_membership(id,principal_id,tenant_id,role,is_active,created_at,updated_at) VALUES('supporting-membership','supporting-member',101,'viewer',1,'2026-09-15','2026-09-15')",
    );

    const response = await app.request(`/v1/identity/users/${data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platformAdmin: true }),
    });

    expect(response.status).toBe(200);
    expect(
      (await response.json()).data.relationships.memberships[0],
    ).toMatchObject({
      relationships: { tenant: { id: "0" } },
    });
  });

  it("uses a temporary password for a provisioned user without emailing a reset", async () => {
    await seedAgency();
    let provisionInput:
      | {
          email: string;
          firstName: string;
          lastName: string;
          platformAdmin: boolean;
          temporaryPassword?: string;
        }
      | undefined;
    const sendPasswordReset = vi.fn(async () => undefined);
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator({
        async createUser(input) {
          provisionInput = input;
          return {
            subject: "better-auth-temporary-password-user",
            email: input.email,
            displayName: `${input.firstName} ${input.lastName}`,
          };
        },
        sendPasswordReset,
      }),
    );

    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "agency.admin@acme.test",
        firstName: "Agency",
        lastName: "Admin",
        platformAdmin: false,
        temporaryPassword: "Temporary-password-123",
        membership: { agencyId: 101, role: "agency_admin" },
      }),
    });

    expect(response.status).toBe(201);
    expect(provisionInput).toMatchObject({
      email: "agency.admin@acme.test",
      temporaryPassword: "Temporary-password-123",
    });
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it("lists Better Auth accounts without retired identity providers", async () => {
    const current = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "better-auth-current-user",
      email: "current.user@savia.test",
      displayName: "Current User",
    });
    await upsertPrincipal(env.DB, {
      issuer: "retired:identity-provider",
      subject: "retired-user",
      email: "retired.user@savia.test",
      displayName: "Retired User",
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator({
        async listUsers() {
          return [
            {
              subject: "better-auth-current-user",
              email: "current.user@savia.test",
              displayName: "Current User",
              role: "admin",
              isBanned: false,
              twoFactorEnabled: true,
            },
          ];
        },
      }),
    );

    const response = await app.request("/v1/identity/users");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [
        expect.objectContaining({
          id: current.id,
          attributes: expect.objectContaining({
            email: "current.user@savia.test",
            account: {
              role: "admin",
              isBanned: false,
              twoFactorEnabled: true,
            },
          }),
        }),
      ],
    });
  });

  it.each([
    {
      stored: "Ana De la Cruz",
      change: { firstName: "  Andrea  " },
      expected: "Andrea De la Cruz",
    },
    {
      stored: "Ana De la Cruz",
      change: { lastName: "Ríos" },
      expected: "Ana Ríos",
    },
    { stored: "Ana", change: { lastName: "Ríos" }, expected: "Ana Ríos" },
  ])(
    "preserves the untouched part of the display name $stored",
    async ({ stored, change, expected }) => {
      const principal = await upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "partial-name-user",
        email: "partial-name@savia.test",
        displayName: stored,
      });
      const administrator = identityUserAdministrator();
      const updateUser = vi.spyOn(administrator, "updateUser");
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        platformAdministratorAuthenticator(),
        administrator,
      );
      const response = await app.request(`/v1/identity/users/${principal.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(change),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { attributes: { displayName: expected } },
      });
      expect(updateUser).toHaveBeenCalledWith(
        principal.subject,
        expect.objectContaining({ displayName: expected }),
        expect.any(Request),
      );
    },
  );

  it("keeps a member active when a transfer arrives while Auth deletes another user", async () => {
    await seedAgency(101);
    await seedAgency(102);
    const issuer = "savia:better-auth";
    const departing = await upsertPrincipal(env.DB, {
      issuer,
      subject: "departure",
      email: "departure@example.test",
      displayName: "Departure",
    });
    const staying = await upsertPrincipal(env.DB, {
      issuer,
      subject: "stays",
      email: "stays@example.test",
      displayName: "Remaining Member",
    });
    await grantMembership(env.DB, departing.id, 101, "viewer");
    await grantMembership(env.DB, staying.id, 101, "viewer");
    let transfer: PromiseSettledResult<unknown> | undefined;
    const administrator = identityUserAdministrator({
      async deleteUser() {
        [transfer] = await Promise.allSettled([
          grantMembership(env.DB, staying.id, 102, "viewer"),
        ]);
      },
    });
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );
    const deleted = await app.request(`/v1/identity/users/${departing.id}`, {
      method: "DELETE",
    });
    expect(deleted.status, await deleted.clone().text()).toBe(204);
    expect(transfer).toMatchObject({
      status: "rejected",
      reason: { code: "LAST_ACTIVE_MEMBER" },
    });
    expect(
      await env.DB.prepare(
        "SELECT tenant_id FROM identity_tenant_membership WHERE principal_id=?",
      )
        .bind(staying.id)
        .first("tenant_id"),
    ).toBe(101);
  });

  it("keeps a pending user disabled after an Auth error and permits retrying deletion", async () => {
    await seedAgency(101);
    await seedAgency(102);
    const issuer = "savia:better-auth";
    const departing = await upsertPrincipal(env.DB, {
      issuer,
      subject: "pending",
      email: "pending@example.test",
      displayName: "Pending Deletion",
    });
    const staying = await upsertPrincipal(env.DB, {
      issuer,
      subject: "other",
      email: "other@example.test",
      displayName: "Remaining Member",
    });
    await grantMembership(env.DB, departing.id, 101, "viewer");
    await grantMembership(env.DB, staying.id, 101, "viewer");
    const deleteUser = vi
      .fn(async () => {})
      .mockRejectedValueOnce(
        new AuthenticationError(
          "AUTHENTICATION_UNAVAILABLE",
          "Auth did not respond",
        ),
      );
    const administrator = identityUserAdministrator({ deleteUser });
    const activate = vi.spyOn(administrator, "setAccountActive");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );
    const url = `/v1/identity/users/${departing.id}`;
    const initial = await app.request(url, { method: "DELETE" });
    expect(initial.status).toBe(503);
    expect(
      await findPrincipalBySubject(env.DB, issuer, departing.subject),
    ).toMatchObject({ isActive: false });
    const reactivated = await app.request(`${url}/suspension`, {
      method: "DELETE",
    });
    expect(reactivated.status).toBe(409);
    expect(await reactivated.json()).toMatchObject({
      error: { code: "IDENTITY_DELETION_IN_PROGRESS" },
    });
    expect(activate).not.toHaveBeenCalled();
    await expect(
      grantMembership(env.DB, departing.id, 102, "operator"),
    ).rejects.toMatchObject({ code: "IDENTITY_DELETION_IN_PROGRESS" });
    const retried = await app.request(url, { method: "DELETE" });
    expect(retried.status, await retried.clone().text()).toBe(204);
    expect(deleteUser).toHaveBeenCalledTimes(2);
    expect(
      await findPrincipalBySubject(env.DB, issuer, departing.subject),
    ).toBeUndefined();
  });

  it.each(["tenant", "platform"] as const)(
    "does not restore a deleted user from a stale %s directory response",
    async (scope) => {
      await seedAgency(101);
      const issuer = "savia:better-auth";
      const departing = await upsertPrincipal(env.DB, {
        issuer,
        subject: "deleted-during-list",
        email: "deleted-during-list@example.test",
        displayName: "Deleted During List",
      });
      const staying = await upsertPrincipal(env.DB, {
        issuer,
        subject: "staying-during-list",
        email: "staying-during-list@example.test",
        displayName: "Staying During List",
      });
      await grantMembership(env.DB, departing.id, 101, "viewer");
      await grantMembership(env.DB, staying.id, 101, "viewer");
      const account = (principal: typeof departing) => ({
        subject: principal.subject,
        email: principal.email,
        displayName: principal.displayName,
        role: "user" as const,
        isBanned: false,
        twoFactorEnabled: false,
      });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const administrator = identityUserAdministrator({
        async listUsers() {
          if (removed) return [account(staying)];
          entered.resolve();
          await release.promise;
          return [account(departing), account(staying)];
        },
        async getUser(subject) {
          if (subject === departing.subject) {
            entered.resolve();
            await release.promise;
            return account(departing);
          }
          return account(staying);
        },
      });
      let removed = false;
      vi.spyOn(administrator, "deleteUser").mockImplementation(async () => {
        removed = true;
      });
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        scope === "tenant"
          ? agencyAdministratorAuthenticator()
          : platformAdministratorAuthenticator(),
        administrator,
      );
      const listing = app.request("/v1/identity/users");
      await entered.promise;
      try {
        const deleted = await app.request(
          `/v1/identity/users/${departing.id}`,
          {
            method: "DELETE",
          },
        );
        expect(deleted.status, await deleted.clone().text()).toBe(204);
      } finally {
        release.resolve();
      }
      const response = await listing;
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toEqual({
        data: [expect.objectContaining({ id: staying.id })],
      });
      expect(
        await findPrincipalBySubject(env.DB, issuer, departing.subject),
      ).toBeUndefined();
    },
  );

  it.each(["tenant", "platform", "platform with an Auth account"] as const)(
    "keeps a pending deletion visible to the %s administrator",
    async (scope) => {
      await seedAgency(101);
      const issuer = "savia:better-auth";
      const departing = await upsertPrincipal(env.DB, {
        issuer,
        subject: "pending-deletion",
        email: "pending-deletion@example.test",
        displayName: "Pending Deletion",
      });
      const staying = await upsertPrincipal(env.DB, {
        issuer,
        subject: "active-account",
        email: "active-account@example.test",
        displayName: "Active Account",
      });
      await grantMembership(env.DB, departing.id, 101, "viewer");
      await grantMembership(env.DB, staying.id, 101, "viewer");
      await beginPrincipalDeletion(env.DB, departing.id);
      const activeAccount = {
        subject: staying.subject,
        email: staying.email,
        displayName: staying.displayName,
        role: "user" as const,
        isBanned: false,
        twoFactorEnabled: true,
      };
      const getUser = vi.fn(async (subject: string) => {
        if (subject === staying.subject) return activeAccount;
        throw new AuthenticationError(
          "AUTHENTICATION_UNAVAILABLE",
          "Auth account missing",
        );
      });
      const administrator = identityUserAdministrator({
        getUser,
        async listUsers() {
          return scope === "platform with an Auth account"
            ? [
                activeAccount,
                {
                  ...activeAccount,
                  subject: departing.subject,
                  email: departing.email,
                  displayName: departing.displayName,
                  role: "admin",
                },
              ]
            : [activeAccount];
        },
      });
      const app = createApp(
        env.DB,
        env.DOCUMENTS,
        undefined,
        scope === "tenant"
          ? agencyAdministratorAuthenticator()
          : platformAdministratorAuthenticator(),
        administrator,
      );
      const pending = {
        id: departing.id,
        attributes: expect.objectContaining({
          account: null,
          deletionPending: true,
          email: departing.email,
          isActive: false,
          globalRoles: [],
        }),
      };
      const list = await app.request("/v1/identity/users");
      expect(list.status, await list.clone().text()).toBe(200);
      expect(await list.json()).toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining(pending),
          expect.objectContaining({
            id: staying.id,
            attributes: expect.objectContaining({
              account: expect.objectContaining({ twoFactorEnabled: true }),
            }),
          }),
        ]),
      });
      const details = await app.request(`/v1/identity/users/${departing.id}`);
      expect(details.status, await details.clone().text()).toBe(200);
      expect(await details.json()).toMatchObject({
        data: expect.objectContaining(pending),
      });
      expect(getUser.mock.calls.map(([subject]) => subject)).not.toContain(
        departing.subject,
      );
    },
  );

  it("updates access, account state, sessions, and recovery delivery for a managed user", async () => {
    await seedAgency();
    const administrator = identityUserAdministrator();
    const updateUser = vi.spyOn(administrator, "updateUser");
    const setAccountActive = vi.spyOn(administrator, "setAccountActive");
    const revokeSessions = vi.spyOn(administrator, "revokeSessions");
    const sendPasswordReset = vi.spyOn(administrator, "sendPasswordReset");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );

    const created = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "new.user@acme.test",
        firstName: "New",
        lastName: "User",
        membership: { agencyId: 101, role: "viewer" },
      }),
    });
    const { data } = await created.json<{ data: { id: string } }>();

    const updated = await app.request(`/v1/identity/users/${data.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ firstName: "Updated", lastName: "User" }),
    });
    expect(updated.status).toBe(200);
    expect(updateUser).toHaveBeenCalledWith(
      "better-auth-new-user",
      { displayName: "Updated User", platformAdmin: undefined },
      expect.any(Request),
    );

    const suspended = await app.request(
      `/v1/identity/users/${data.id}/suspension`,
      { method: "POST" },
    );
    expect(suspended.status).toBe(409);
    expect(await suspended.json()).toMatchObject({
      error: { code: "LAST_ACTIVE_MEMBER" },
    });
    expect(setAccountActive).not.toHaveBeenCalledWith(
      "better-auth-new-user",
      false,
      expect.any(Request),
    );

    expect(
      (
        await app.request(`/v1/identity/users/${data.id}/sessions/revoke`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    expect(revokeSessions).toHaveBeenCalledWith(
      "better-auth-new-user",
      expect.any(Request),
    );

    expect(
      (
        await app.request(`/v1/identity/users/${data.id}/password-reset`, {
          method: "POST",
        })
      ).status,
    ).toBe(204);
    expect(sendPasswordReset).toHaveBeenCalledTimes(2);

    expect(
      (
        await app.request(`/v1/identity/users/${data.id}/memberships/101`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(409);
  });

  it("rejects a different login subject with the same normalized email without inheriting access", async () => {
    const original = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "original-email-owner",
      email: "owner@savia.test",
      displayName: "Owner",
    });
    await ensureBootstrapAdministrator(env.DB, original.id);
    await expect(
      upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "replacement-subject",
        email: " OWNER@SAVIA.TEST ",
        displayName: "Other login",
      }),
    ).rejects.toMatchObject({ code: "IDENTITY_EMAIL_CONFLICT" });
    expect(
      await findPrincipalBySubject(
        env.DB,
        "savia:better-auth",
        "replacement-subject",
      ),
    ).toBeUndefined();
    const unchanged = await findPrincipalBySubject(
      env.DB,
      "savia:better-auth",
      "original-email-owner",
    );
    expect(unchanged?.id).toBe(original.id);
  });

  it("rejects duplicate provisioning before creating or messaging an authentication account", async () => {
    await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "existing-email-owner",
      email: "duplicate@savia.test",
      displayName: "Existing",
    });
    const createUser = vi.fn();
    const sendPasswordReset = vi.fn();
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      identityUserAdministrator({ createUser, sendPasswordReset }),
    );
    const response = await app.request("/v1/identity/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "DUPLICATE@savia.test",
        firstName: "Duplicate",
        lastName: "User",
        platformAdmin: true,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "IDENTITY_EMAIL_CONFLICT" },
    });
    expect(createUser).not.toHaveBeenCalled();
    expect(sendPasswordReset).not.toHaveBeenCalled();
  });

  it("rejects reactivation when another active principal owns the email", async () => {
    const inactive = await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "inactive-email-owner",
      email: "reused@savia.test",
      displayName: "Inactive",
    });
    await env.DB.prepare("UPDATE identity_principal SET is_active=0 WHERE id=?")
      .bind(inactive.id)
      .run();
    await upsertPrincipal(env.DB, {
      issuer: "savia:better-auth",
      subject: "active-email-owner",
      email: "reused@savia.test",
      displayName: "Active",
    });
    await expect(
      setPrincipalActive(env.DB, inactive.id, true),
    ).rejects.toMatchObject({ code: "IDENTITY_EMAIL_CONFLICT" });
    expect(
      (
        await findPrincipalBySubject(
          env.DB,
          "savia:better-auth",
          "inactive-email-owner",
        )
      )?.isActive,
    ).toBe(false);
    const administrator = identityUserAdministrator();
    const activate = vi.spyOn(administrator, "setAccountActive");
    const app = createApp(
      env.DB,
      env.DOCUMENTS,
      undefined,
      platformAdministratorAuthenticator(),
      administrator,
    );
    const response = await app.request(
      `/v1/identity/users/${inactive.id}/suspension`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(409);
    expect(activate).not.toHaveBeenCalled();
  });

  it("allows only one concurrent principal for a normalized email", async () => {
    const attempts = await Promise.allSettled([
      upsertPrincipal(env.DB, {
        issuer: "savia:better-auth",
        subject: "race-email-one",
        email: "race-email@savia.test",
        displayName: "One",
      }),
      upsertPrincipal(env.DB, {
        issuer: "other:provider",
        subject: "race-email-two",
        email: " RACE-EMAIL@SAVIA.TEST ",
        displayName: "Two",
      }),
    ]);
    expect(
      attempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = attempts.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "IDENTITY_EMAIL_CONFLICT" });
  });

  it("keeps one principal when the same Better Auth session arrives concurrently", async () => {
    const identity = {
      issuer: "savia:better-auth",
      subject: "same-better-auth-subject",
      email: "same@savia.test",
      displayName: "Same Login",
    };

    const [first, second] = await Promise.all([
      upsertPrincipal(env.DB, identity),
      upsertPrincipal(env.DB, identity),
    ]);

    expect(second.id).toBe(first.id);
    const users = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM identity_principal WHERE issuer = ? AND subject = ?",
    )
      .bind(identity.issuer, identity.subject)
      .first<{ total: number }>();
    expect(users?.total).toBe(1);
  });

  it("does not rewrite an unchanged principal during a repeated login", async () => {
    const identity = {
      issuer: "savia:better-auth",
      subject: "unchanged-better-auth-subject",
      email: "unchanged@savia.test",
      displayName: "Unchanged User",
    };
    const created = await upsertPrincipal(env.DB, identity);
    await env.DB.prepare(
      "UPDATE identity_principal SET updated_at = ? WHERE id = ?",
    )
      .bind("2020-01-01T00:00:00.000Z", created.id)
      .run();

    const repeated = await upsertPrincipal(env.DB, {
      ...identity,
      email: " UNCHANGED@SAVIA.TEST ",
    });
    const persisted = await env.DB.prepare(
      "SELECT updated_at FROM identity_principal WHERE id = ?",
    )
      .bind(created.id)
      .first<{ updated_at: string }>();

    expect(repeated.id).toBe(created.id);
    expect(persisted?.updated_at).toBe("2020-01-01T00:00:00.000Z");
  });

  it("finds an existing principal by subject", async () => {
    const identity = {
      issuer: "savia:better-auth",
      subject: "find-subject-test",
      email: "find@savia.test",
      displayName: "Find Me",
    };
    const created = await upsertPrincipal(env.DB, identity);
    const found = await findPrincipalBySubject(
      env.DB,
      identity.issuer,
      identity.subject,
    );
    expect(found?.id).toBe(created.id);
    expect(found?.email).toBe(identity.email);

    const notFound = await findPrincipalBySubject(
      env.DB,
      identity.issuer,
      "non-existent",
    );
    expect(notFound).toBeUndefined();
  });
});

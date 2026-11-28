import type { UserIdentity } from "ra-core";
import { isAllowedTenantOrigin } from "@savia/tenant-host";
import {
  readAdminResume,
  type AdminResume,
} from "@savia/tenant-host/admin-resume";
import { adminAuthorizeUrl } from "./admin-authorize-url";
import { getSessionGeneration, rotateSessionScope } from "./session-scope";
import { isOfflineError } from "../offline/offline-error";
import { REQUEST_TIMEOUT_MS, withRequestTimeout } from "../api/request-timeout";
import { OAuthCallbackError } from "./auth-session";
import type {
  AuthPermissions,
  AuthSession,
  CallbackResult,
} from "./auth-session";

export type BrowserNavigation = {
  currentUrl(): string;
  redirect(url: string): void;
};

export type BetterAuthOAuthSettings = {
  apiUrl: string;
  fetcher?: typeof fetch;
  navigation?: BrowserNavigation;
};

type OAuthTokenResponse = {
  access_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
};

type OAuthErrorPayload = { error?: { message?: unknown } };

type CallbackDestination = {
  returnOrigin?: unknown;
  returnRoute?: unknown;
  returnBookingQuery?: unknown;
  returnStudioQuery?: unknown;
};

function readCallbackResume(payload?: CallbackDestination) {
  return readAdminResume(
    payload?.returnRoute,
    payload?.returnRoute === "studio"
      ? payload.returnStudioQuery
      : payload?.returnBookingQuery,
  );
}

type IdentityResponse = {
  data?: {
    id?: unknown;
    attributes?: {
      displayName?: unknown;
      email?: unknown;
      globalRoles?: unknown;
    };
    relationships?: {
      memberships?: unknown;
    };
  };
};

type BetterAuthSessionResponse = {
  user?: {
    image?: unknown;
  } | null;
};

type SaviaIdentity = {
  id: string;
  attributes: {
    displayName: string;
    email?: unknown;
    globalRoles?: unknown;
  };
  relationships?: {
    memberships?: unknown;
  };
};

function requestUrl(baseUrl: string, path: string): string {
  return new URL(path, `${baseUrl.replace(/\/$/, "")}/`).toString();
}

export function normalizeAvatarUrl(image: string, apiUrl: string): string {
  const trimmed = image.trim();
  if (!trimmed) return "";
  try {
    const api = new URL(apiUrl);
    const parsed = new URL(trimmed, apiUrl);
    if (
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.origin !== api.origin
    ) {
      return `${api.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function defaultNavigation(): BrowserNavigation {
  return {
    currentUrl: () => window.location.href,
    redirect: (url) => window.location.assign(url),
  };
}

async function responseMessage(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => undefined)) as
    OAuthErrorPayload | undefined;
  return oauthErrorMessage(response, payload);
}

function oauthErrorMessage(
  response: Response,
  payload: OAuthErrorPayload | undefined,
): string {
  return typeof payload?.error?.message === "string"
    ? payload.error.message
    : response.statusText || "No fue posible completar el inicio de sesión.";
}

function readToken(payload: OAuthTokenResponse): {
  accessToken: string;
  expiresAt: number;
  scopes: Set<string>;
} {
  if (
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0 ||
    (payload.token_type !== undefined && payload.token_type !== "Bearer")
  ) {
    throw new Error("Better Auth no devolvió un token de acceso válido.");
  }
  return {
    accessToken: payload.access_token,
    expiresAt:
      typeof payload.expires_in === "number" &&
      Number.isFinite(payload.expires_in) &&
      payload.expires_in > 0
        ? Date.now() + payload.expires_in * 1_000
        : Number.POSITIVE_INFINITY,
    scopes:
      typeof payload.scope === "string"
        ? new Set(payload.scope.split(/\s+/).filter(Boolean))
        : new Set(),
  };
}

export class BetterAuthOAuthSession implements AuthSession {
  private accessToken: string | null = null;

  private accessTokenExpiresAt = 0;

  private scopes = new Set<string>();

  private callbackPromise: Promise<CallbackResult> | null = null;

  private refreshPromise: Promise<void> | null = null;

  private authenticationRequests = new AbortController();

  private refreshAllowed = true;

  private identityPromise: Promise<SaviaIdentity> | null = null;

  private identitySettled = false;

  private principalId: string | undefined;

  private avatarPromise: Promise<string | undefined> | null = null;

  private cachedAvatar: string | undefined;

  private avatarLoaded = false;

  /**
   * Last fully-resolved permissions, memory-only (never persisted: tokens
   * and credentials stay out of browser storage). Returned when the network
   * drops so cached reads and navigation keep working offline.
   */
  private lastKnownPermissions: AuthPermissions | undefined;

  private readonly fetcher: typeof fetch;

  private readonly navigation: BrowserNavigation;

  constructor(private readonly settings: BetterAuthOAuthSettings) {
    const fetcher =
      settings.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.fetcher = (input, init) =>
      withRequestTimeout(
        async (signal) => {
          const response = await fetcher(input, { ...init, signal });
          // Auth responses are small JSON payloads. Read a clone before
          // resolving so a stalled body is covered by the same deadline.
          if (response.body) await response.clone().arrayBuffer();
          return response;
        },
        REQUEST_TIMEOUT_MS,
        init?.signal,
      );
    this.navigation = settings.navigation ?? defaultNavigation();
    if (typeof window !== "undefined") {
      window.addEventListener("savia:identity-changed", () => {
        this.identityPromise = null;
        this.identitySettled = false;
        this.avatarPromise = null;
        this.cachedAvatar = undefined;
        this.avatarLoaded = false;
      });
    }
  }

  getAuthorizeUrl(destination?: AdminResume): string {
    return adminAuthorizeUrl(
      this.settings.apiUrl,
      this.navigation.currentUrl(),
      destination,
    );
  }

  async login(destination?: AdminResume): Promise<void> {
    this.navigation.redirect(this.getAuthorizeUrl(destination));
  }

  async logout(): Promise<string> {
    await this.clearSession();
    try {
      await this.fetcher(
        requestUrl(this.settings.apiUrl, "/api/auth/admin/logout"),
        {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json" },
        },
      );
    } catch {
      // Ignored to guarantee the user is redirected even if the network or endpoint fails
    }
    return this.getAuthorizeUrl();
  }

  async clearSession(): Promise<void> {
    this.authenticationRequests.abort();
    this.authenticationRequests = new AbortController();
    this.principalId = undefined;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
    this.scopes.clear();
    this.callbackPromise = null;
    this.refreshPromise = null;
    this.identityPromise = null;
    this.identitySettled = false;
    this.avatarPromise = null;
    this.cachedAvatar = undefined;
    this.avatarLoaded = false;
    this.lastKnownPermissions = undefined;
    this.refreshAllowed = false;
    rotateSessionScope("logout");
    if (typeof window !== "undefined")
      window.dispatchEvent(new Event("savia:session-cleared"));
  }

  async handleCallback(): Promise<CallbackResult> {
    const { signal } = this.authenticationRequests;
    const callbackPromise =
      this.callbackPromise ??
      (this.callbackPromise = this.exchangeCallback(signal).catch(
        (exception: unknown) => {
          if (!signal.aborted) this.callbackPromise = null;
          throw exception;
        },
      ));
    return await callbackPromise;
  }

  async getAccessToken(): Promise<string | null> {
    const { signal } = this.authenticationRequests;
    if (!this.accessToken && this.refreshAllowed && this.isOAuthCallbackUrl()) {
      await this.handleCallback();
    } else if (
      (!this.accessToken || Date.now() >= this.accessTokenExpiresAt - 30_000) &&
      this.refreshAllowed
    ) {
      await this.refreshAccessToken();
    }
    return signal.aborted ? null : this.accessToken;
  }

  async getIdentity(): Promise<UserIdentity> {
    const accessToken = await this.requireAccessToken();
    const identityRequest = this.saviaIdentity(accessToken);
    const avatarRequest =
      this.principalId === undefined ? this.sessionAvatar() : null;
    const identity = await identityRequest;
    const identityGeneration = getSessionGeneration();
    const avatar = await (avatarRequest ?? this.sessionAvatar());
    if (identityGeneration !== getSessionGeneration())
      throw new Error(
        "The authenticated session changed during the identity read.",
      );
    return {
      id: identity.id,
      fullName: identity.attributes.displayName,
      ...(typeof identity.attributes.email === "string"
        ? { email: identity.attributes.email }
        : {}),
      ...(avatar ? { avatar } : {}),
    };
  }

  async getPermissions(): Promise<AuthPermissions> {
    const { signal } = this.authenticationRequests;
    let accessToken: string | null = null;
    try {
      accessToken = await this.getAccessToken();
    } catch (exception) {
      if (!signal.aborted) {
        // Keep cached reads visible when an active session loses its network.
        if (isOfflineError(exception) && this.lastKnownPermissions)
          return this.lastKnownPermissions;
        throw exception;
      }
    }
    let identity: SaviaIdentity | undefined;
    if (accessToken && !signal.aborted) {
      try {
        identity = await this.saviaIdentity(accessToken);
      } catch (exception) {
        if (
          !signal.aborted &&
          isOfflineError(exception) &&
          this.lastKnownPermissions
        ) {
          return this.lastKnownPermissions;
        }
      }
    }
    const signedIn = Boolean(accessToken) && !signal.aborted;
    const canWrite = signedIn && this.scopes.has("savia.api.write");
    if (!signedIn) identity = undefined;
    let canManageIdentity = false;
    if (canWrite && identity) {
      canManageIdentity = Array.isArray(identity.attributes?.globalRoles)
        ? identity.attributes.globalRoles.includes("platform_admin")
        : false;
    }
    const permissions = {
      canReadDocuments: signedIn && this.scopes.has("savia.api.read"),
      canExecuteCommands: canWrite,
      canManageIdentity,
      memberships: identity ? activeMemberships(identity) : [],
    };
    if (identity) this.lastKnownPermissions = permissions;
    return permissions;
  }

  async checkSession(): Promise<void> {
    await this.requireAccessToken();
  }

  /** Fresh server proof for offline lease renewal; never use a settled identity cache. */
  async verifySession(): Promise<void> {
    const token = await this.requireAccessToken();
    if (this.identitySettled) {
      this.identityPromise = null;
      this.identitySettled = false;
    }
    this.avatarPromise = null;
    this.cachedAvatar = undefined;
    this.avatarLoaded = false;
    await this.saviaIdentity(token);
  }

  private async exchangeCallback(signal: AbortSignal): Promise<CallbackResult> {
    const callback = new URL(this.navigation.currentUrl());
    const code = callback.searchParams.get("code");
    const state = callback.searchParams.get("state");
    const authorizationFailed = Boolean(callback.searchParams.get("error"));
    if (!state || Boolean(code) === authorizationFailed) {
      throw new Error(
        "La respuesta de Better Auth no contiene código y estado.",
      );
    }
    const response = await this.fetcher(
      requestUrl(this.settings.apiUrl, "/api/auth/admin/callback"),
      {
        method: "POST",
        signal,
        credentials: "include",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          authorizationFailed
            ? { state, authorizationFailed }
            : { code, state },
        ),
      },
    );
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        (OAuthErrorPayload & CallbackDestination) | undefined;
      const message = oauthErrorMessage(response, payload);
      const resume = readCallbackResume(payload);
      if (resume) {
        const destination =
          typeof payload?.returnOrigin === "string" &&
          isAllowedTenantOrigin(payload.returnOrigin)
            ? payload.returnOrigin
            : callback.href;
        throw new OAuthCallbackError(
          message,
          adminAuthorizeUrl(this.settings.apiUrl, destination, resume),
        );
      }
      throw new Error(message);
    }
    const payload = (await response.json()) as OAuthTokenResponse &
      CallbackDestination;
    signal.throwIfAborted();
    this.applyToken(readToken(payload));
    const returnOrigin =
      typeof payload.returnOrigin === "string"
        ? payload.returnOrigin
        : undefined;
    const resume = readCallbackResume(payload);
    return {
      returnOrigin,
      ...(resume && { returnRoute: resume.route }),
      ...(resume?.route === "bookings" &&
        resume.query && { returnBookingQuery: resume.query }),
      ...(resume?.route === "studio" &&
        resume.query && { returnStudioQuery: resume.query }),
    };
  }

  private isOAuthCallbackUrl(): boolean {
    try {
      const callback = new URL(this.navigation.currentUrl());
      return (
        callback.pathname === "/auth/callback" &&
        Boolean(callback.searchParams.get("state")) &&
        Boolean(
          callback.searchParams.get("code") ||
          callback.searchParams.get("error"),
        )
      );
    } catch {
      return false;
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshPromise) {
      const { signal } = this.authenticationRequests;
      this.refreshPromise = (async () => {
        let response: Response;
        try {
          response = await this.fetcher(
            requestUrl(this.settings.apiUrl, "/api/auth/admin/refresh"),
            {
              method: "POST",
              signal,
              credentials: "include",
              headers: { Accept: "application/json" },
            },
          );
        } catch (exception) {
          if (signal.aborted) return;
          // The network dropped mid-refresh: keep the stale token instead
          // of wiping the session. Reads keep serving the persisted cache
          // and checkSession still resolves, so the app never "logs out"
          // just because the network did.
          if (isOfflineError(exception) && this.accessToken) return;
          throw exception;
        }
        if (signal.aborted) return;
        if (!response.ok) {
          if (response.status !== 401)
            throw Object.assign(new Error(await responseMessage(response)), {
              status: response.status,
            });
          this.accessToken = null;
          this.accessTokenExpiresAt = 0;
          this.scopes.clear();
          this.refreshAllowed = false;
          throw new Error(await responseMessage(response));
        }
        const payload = (await response.json()) as OAuthTokenResponse;
        if (!signal.aborted) this.applyToken(readToken(payload));
      })().finally(() => {
        if (!signal.aborted) this.refreshPromise = null;
      });
    }
    await this.refreshPromise;
  }

  private applyToken(token: {
    accessToken: string;
    expiresAt: number;
    scopes: Set<string>;
  }): void {
    if (this.accessToken !== token.accessToken) {
      this.identityPromise = null;
      this.identitySettled = false;
      this.avatarPromise = null;
      this.cachedAvatar = undefined;
      this.avatarLoaded = false;
    }
    this.accessToken = token.accessToken;
    this.accessTokenExpiresAt = token.expiresAt;
    this.scopes = token.scopes;
    this.refreshAllowed = true;
  }

  private async requireAccessToken(): Promise<string> {
    const token = await this.getAccessToken();
    if (!token) throw new Error("Authentication is required");
    return token;
  }

  private async sessionAvatar(): Promise<string | undefined> {
    if (this.avatarLoaded) {
      return this.cachedAvatar;
    }
    if (!this.avatarPromise) {
      const pending = Promise.resolve()
        .then(async () => {
          const response = await this.fetcher(
            requestUrl(this.settings.apiUrl, "/api/auth/get-session"),
            {
              method: "GET",
              credentials: "include",
              headers: { Accept: "application/json" },
            },
          );
          const payload = response.ok
            ? ((await response.json()) as BetterAuthSessionResponse)
            : undefined;
          if (this.avatarPromise !== pending) return undefined;
          const image = payload?.user?.image;
          this.cachedAvatar =
            typeof image === "string" && image.length > 0
              ? normalizeAvatarUrl(image, this.settings.apiUrl)
              : undefined;
          this.avatarLoaded = true;
          return this.cachedAvatar;
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.avatarPromise === pending) this.avatarPromise = null;
        });
      this.avatarPromise = pending;
    }
    return this.avatarPromise;
  }

  private async saviaIdentity(accessToken: string): Promise<SaviaIdentity> {
    if (!this.identityPromise) {
      const requestGeneration = getSessionGeneration();
      this.identitySettled = false;
      const pending = this.fetcher(
        requestUrl(this.settings.apiUrl, "/v1/identity/me"),
        {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
          },
        },
      )
        .then(async (response): Promise<SaviaIdentity> => {
          if (!response.ok)
            throw Object.assign(new Error(await responseMessage(response)), {
              status: response.status,
            });
          const identity = ((await response.json()) as IdentityResponse).data;
          if (
            this.identityPromise !== pending ||
            requestGeneration !== getSessionGeneration()
          )
            throw new Error(
              "The authenticated session changed during the identity read.",
            );
          if (
            !identity ||
            typeof identity.id !== "string" ||
            typeof identity.attributes?.displayName !== "string"
          ) {
            throw new Error("Savia devolvió una identidad inválida.");
          }
          if (
            this.principalId !== undefined &&
            this.principalId !== identity.id
          ) {
            this.lastKnownPermissions = undefined;
            this.avatarPromise = null;
            this.cachedAvatar = undefined;
            this.avatarLoaded = false;
            rotateSessionScope("principal-change");
          }
          this.principalId = identity.id;
          this.identitySettled = true;
          return {
            id: identity.id,
            attributes: {
              displayName: identity.attributes.displayName,
              email: identity.attributes.email,
              globalRoles: identity.attributes.globalRoles,
            },
            relationships: identity.relationships,
          };
        })
        .catch((exception: unknown) => {
          if (this.identityPromise === pending) {
            this.identityPromise = null;
            this.identitySettled = false;
          }
          throw exception;
        });
      this.identityPromise = pending;
    }
    return this.identityPromise;
  }
}

function activeMemberships(identity: SaviaIdentity) {
  const memberships = identity.relationships?.memberships;
  if (!Array.isArray(memberships)) return [];
  return memberships.flatMap((membership) => {
    if (!membership || typeof membership !== "object") return [];
    const candidate = membership as {
      role?: unknown;
      attributes?: { isActive?: unknown };
      relationships?: { agency?: { id?: unknown }; tenant?: { id?: unknown } };
    };
    const agencyId = Number(
      candidate.relationships?.tenant?.id ??
        candidate.relationships?.agency?.id,
    );
    if (
      candidate.attributes?.isActive !== true ||
      typeof candidate.role !== "string" ||
      !Number.isSafeInteger(agencyId) ||
      agencyId < 1
    ) {
      return [];
    }
    return [{ agencyId, tenantId: agencyId, role: candidate.role }];
  });
}

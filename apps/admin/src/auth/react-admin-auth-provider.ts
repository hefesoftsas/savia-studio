import {
  beginLogout,
  getLogoutPending,
  resumeSessionReads,
} from "./logout-progress";
import { getSessionGeneration } from "./session-scope";
import type { AuthProvider } from "ra-core";
import { isSaviaFlowsDisabled } from "@/features/savia-flows/availability";
import { ApiClientError } from "../api/api-client";
import type { AuthPermissions, AuthSession } from "./auth-session";

function hasAnyRole(
  permissions: AuthPermissions,
  roles: readonly string[],
): boolean {
  const normalizedRoles = new Set(
    roles.flatMap((r) =>
      r === "agency_admin" || r === "tenant_admin"
        ? ["tenant_admin", "agency_admin"]
        : [r],
    ),
  );
  return (permissions.memberships ?? []).some((membership) =>
    normalizedRoles.has(membership.role),
  );
}

export function createReactAdminAuthProvider(
  session: AuthSession,
  options?: {
    onLogout?: () => void | Promise<void>;
    canAccessCrm?: () => Promise<boolean>;
  },
): AuthProvider {
  return {
    login: (params?: { bookingQuery?: unknown }) =>
      typeof params?.bookingQuery === "string"
        ? session.login(params.bookingQuery)
        : session.login(),
    logout: async (params?: { logoutFromProvider?: boolean }) => {
      const finishLogout = params?.logoutFromProvider
        ? beginLogout()
        : undefined;
      let completed = false;
      try {
        if (params?.logoutFromProvider) {
          // Keep mounted auth queries intact until the server clears its cookies.
          // Returning the promise without awaiting it runs finally too early.
          const redirect = await session.logout();
          completed = true;
          return redirect;
        }
        await session.clearSession();
        return session.getAuthorizeUrl();
      } finally {
        // Persisted API cache must not survive the session: no client data
        // stays on disk after logout. Never breaks logout itself.
        try {
          await options?.onLogout?.();
        } catch {
          // ignore cleanup failures on the way out
        } finally {
          finishLogout?.(completed);
        }
      }
    },
    checkAuth: async () => {
      const generation = getSessionGeneration();
      const startedDuringLogout = getLogoutPending();
      await session.checkSession();
      if (!startedDuringLogout && generation === getSessionGeneration())
        resumeSessionReads();
    },
    checkError: async (error: unknown) => {
      if (error instanceof ApiClientError && error.status === 401) {
        await session.clearSession();
        throw error;
      }
      if (
        error instanceof ApiClientError &&
        error.status === 403 &&
        error.code === "TENANT_HOST_MISMATCH"
      ) {
        throw error;
      }
    },
    getIdentity: () => session.getIdentity(),
    getPermissions: () => session.getPermissions(),
    canAccess: async ({ resource, action }) => {
      if (resource === "savia-flows" && isSaviaFlowsDisabled()) return false;
      const permissions = await session.getPermissions();
      const isPlatformAdmin = permissions.canManageIdentity;
      if (resource === "access-control")
        return (
          isPlatformAdmin ||
          hasAnyRole(permissions, ["tenant_admin", "agency_admin"])
        );
      if (resource === "studio")
        return (
          isPlatformAdmin ||
          hasAnyRole(permissions, ["tenant_admin", "agency_admin"]) ||
          Boolean(await options?.canAccessCrm?.())
        );
      if (resource === "savia-request")
        return (
          isPlatformAdmin ||
          hasAnyRole(permissions, ["tenant_admin", "agency_admin"])
        );
      if (resource === "savia-flows")
        return (
          isPlatformAdmin ||
          hasAnyRole(permissions, ["tenant_admin", "agency_admin", "owner"]) ||
          Boolean(permissions.memberships?.length)
        );
      if (resource === "users")
        return (
          isPlatformAdmin ||
          hasAnyRole(permissions, ["tenant_admin", "agency_admin"])
        );
      if (resource === "bookings")
        return isPlatformAdmin || Boolean(permissions.memberships?.length);
      if (resource === "companion-recordings")
        return isPlatformAdmin || Boolean(permissions.memberships?.length);
      if (resource === "tenants") return isPlatformAdmin;
      if (resource === "crm-connections") {
        return action === "list";
      }
      if (resource === "provider-credentials") return action === "list";
      return true;
    },
    handleCallback: () => session.handleCallback(),
  };
}

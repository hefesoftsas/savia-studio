import type { AuthPermissions } from "@/auth/auth-session";
import type {
  UserFormData,
  UserRecord,
} from "@/api/identity-user-data-provider";

const adminRoles = new Set(["tenant_admin", "agency_admin"]);

/** Return a tenant only when the actor has one unambiguous admin membership. */
export function tenantAdminTenantId(
  memberships: AuthPermissions["memberships"] | undefined,
): number | undefined {
  const tenantIds = new Set<number>();
  for (const membership of memberships ?? []) {
    if (!adminRoles.has(membership.role)) continue;
    const tenantId = membership.tenantId ?? membership.agencyId;
    if (
      tenantId !== undefined &&
      Number.isSafeInteger(tenantId) &&
      tenantId > 0
    ) {
      tenantIds.add(tenantId);
    }
  }
  return tenantIds.size === 1 ? tenantIds.values().next().value : undefined;
}

export function userCreateScope(permissions: AuthPermissions | undefined) {
  const platformCanEdit = Boolean(permissions?.canManageIdentity);
  const tenantId = platformCanEdit
    ? undefined
    : tenantAdminTenantId(permissions?.memberships);
  return {
    platformCanEdit,
    tenantId,
    defaultValues: {
      platformAdmin: false,
      agencyRole: "viewer" as const,
      ...(tenantId !== undefined ? { tenantId } : {}),
    },
  };
}

/** Tenant administrators may edit identity fields, never platform or tenant scope. */
export function tenantAdminUserUpdateData(
  { firstName, lastName, emailVerified }: UserFormData,
  options?: {
    previousData?: Pick<UserRecord, "firstName" | "lastName" | "emailVerified">;
  },
) {
  const previous = options?.previousData;
  const trimmedFirstName = firstName?.trim();
  const trimmedLastName = lastName?.trim();
  const verificationChanged =
    emailVerified !== undefined &&
    (!previous || emailVerified !== Boolean(previous.emailVerified));
  return {
    ...(trimmedFirstName && trimmedFirstName !== previous?.firstName?.trim()
      ? { firstName: trimmedFirstName }
      : {}),
    ...(trimmedLastName && trimmedLastName !== previous?.lastName?.trim()
      ? { lastName: trimmedLastName }
      : {}),
    ...(verificationChanged ? { emailVerified } : {}),
  };
}

export function platformAdminUserUpdateData(
  data: UserFormData,
  options?: {
    previousData?: Pick<
      UserRecord,
      "firstName" | "lastName" | "emailVerified" | "platformAdmin"
    >;
  },
): UserFormData {
  const { platformAdmin } = data;
  const identity = tenantAdminUserUpdateData(data, options);
  const previous = options?.previousData;
  if (
    !previous ||
    platformAdmin === undefined ||
    platformAdmin === previous.platformAdmin
  )
    return identity;

  if (platformAdmin) return { ...identity, platformAdmin };
  return {
    ...identity,
    platformAdmin,
    tenantId: data.tenantId ?? data.agencyId,
    agencyRole: data.agencyRole,
  };
}

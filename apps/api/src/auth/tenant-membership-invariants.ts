import { dialectFor } from "@savia/db/dialect";
import { databaseConflict } from "@savia/db/errors";
import type { AgencyMembership, AgencyRole, IdentityPrincipal } from "./types";

export const PLATFORM_TENANT_ID = 0;

export class TenantMembershipInvariantError extends Error {
  constructor(
    public readonly code:
      | "TENANT_NOT_FOUND"
      | "LAST_ACTIVE_MEMBER"
      | "LAST_ACTIVE_PLATFORM_ADMINISTRATOR"
      | "PLATFORM_TENANT_RESERVED"
      | "PLATFORM_ADMIN_REQUIRES_REVOCATION"
      | "COMMERCIAL_TENANT_REQUIRED"
      | "IDENTITY_DELETION_IN_PROGRESS"
      | "PRIMARY_TENANT_MISSING",
    message: string,
  ) {
    super(message);
  }
}

type TenantRow = {
  id: number;
  kind: "commercial" | "platform";
  is_active: number;
};

type MembershipRow = {
  id: string;
  principal_id: string;
  tenant_id: number;
  role: string;
  is_active: number;
  created_at: string;
  updated_at: string;
};

function document(row: MembershipRow): AgencyMembership {
  return {
    id: row.id,
    principalId: row.principal_id,
    tenantId: row.tenant_id,
    agencyId: row.tenant_id,
    role: row.role,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function tenant(d1: D1Database, tenantId: number): Promise<TenantRow> {
  const result = await d1
    .prepare("SELECT id,kind,is_active FROM tenants WHERE id=?")
    .bind(tenantId)
    .first<TenantRow>();
  if (!result) {
    throw new TenantMembershipInvariantError(
      "TENANT_NOT_FOUND",
      "Tenant does not exist",
    );
  }
  return result;
}

async function ensurePlatformTenant(d1: D1Database): Promise<TenantRow> {
  const now = new Date().toISOString();
  await d1
    .prepare(
      dialectFor(d1).name === "postgres"
        ? "INSERT INTO tenants(\n        id,id_slug,name,is_active,created_at,updated_at,kind\n      ) VALUES(0,'savia-platform','Plataforma Savia',1,?,?, 'platform') ON CONFLICT (id) DO NOTHING"
        : `INSERT OR IGNORE INTO tenants(
        id,id_slug,name,is_active,created_at,updated_at,kind
      ) VALUES(0,'savia-platform','Plataforma Savia',1,?,?, 'platform')`,
    )
    .bind(now, now)
    .run();
  return tenant(d1, PLATFORM_TENANT_ID);
}

export type MembershipDestinationOptions = { allowInactiveTenant?: boolean };

async function ensureCommercialTenant(
  d1: D1Database,
  tenantId: number,
  { allowInactiveTenant = false }: MembershipDestinationOptions = {},
): Promise<void> {
  const selected = await tenant(d1, tenantId);
  if (
    selected.kind !== "commercial" ||
    (!allowInactiveTenant && !selected.is_active)
  ) {
    throw new TenantMembershipInvariantError(
      selected.kind === "platform"
        ? "PLATFORM_TENANT_RESERVED"
        : "COMMERCIAL_TENANT_REQUIRED",
      selected.kind === "platform"
        ? "The internal platform tenant cannot be assigned directly"
        : "An active commercial tenant is required",
    );
  }
}

export async function ensureActiveCommercialTenant(
  d1: D1Database,
  tenantId: number,
): Promise<void> {
  await ensureCommercialTenant(d1, tenantId);
}

function isLastActiveMember(principalIdSql: string): string {
  return `EXISTS (
    SELECT 1 FROM identity_tenant_membership member
    JOIN identity_principal principal ON principal.id=member.principal_id
    JOIN tenants source ON source.id=member.tenant_id
    WHERE member.principal_id=${principalIdSql}
      AND source.kind='commercial' AND member.is_active=1 AND principal.is_active=1
      AND NOT EXISTS (
        SELECT 1 FROM identity_tenant_membership other
        JOIN identity_principal other_principal ON other_principal.id=other.principal_id
        WHERE other.tenant_id=member.tenant_id AND other.principal_id<>member.principal_id
          AND other.is_active=1 AND other_principal.is_active=1
      )
  )`;
}

function isLastActivePlatformAdministrator(principalIdSql: string): string {
  return `EXISTS (
    SELECT 1 FROM identity_global_role selected_role
    JOIN identity_principal selected ON selected.id=selected_role.principal_id
    WHERE selected.id=${principalIdSql}
      AND selected_role.role='platform_admin' AND selected.is_active=1
      AND NOT EXISTS (
        SELECT 1 FROM identity_global_role other_role
        JOIN identity_principal other ON other.id=other_role.principal_id
        WHERE other.id<>selected.id
          AND other_role.role='platform_admin' AND other.is_active=1
      )
  )`;
}

async function assertPlatformAdministratorCanLeave(
  d1: D1Database,
  principalId: string,
): Promise<void> {
  const last = await d1
    .prepare(
      `SELECT ${isLastActivePlatformAdministrator("?")} AS last_platform_administrator`,
    )
    .bind(principalId)
    .first<boolean | number>("last_platform_administrator");
  if (last) {
    throw new TenantMembershipInvariantError(
      "LAST_ACTIVE_PLATFORM_ADMINISTRATOR",
      "Savia must retain at least one active platform administrator",
    );
  }
}

function lastActiveMemberError(): TenantMembershipInvariantError {
  return new TenantMembershipInvariantError(
    "LAST_ACTIVE_MEMBER",
    "A commercial tenant must retain at least one active user",
  );
}

export async function assertPrincipalNotDeleting(
  d1: D1Database,
  principalId: string,
): Promise<void> {
  const started = await d1
    .prepare("SELECT deletion_started_at FROM identity_principal WHERE id=?")
    .bind(principalId)
    .first<string>("deletion_started_at");
  if (started) {
    throw new TenantMembershipInvariantError(
      "IDENTITY_DELETION_IN_PROGRESS",
      "This user is pending deletion. Retry deleting the user to finish.",
    );
  }
}

async function runMembershipBatch<T>(
  d1: D1Database,
  ...statements: D1PreparedStatement[]
): Promise<D1Result<T>[]> {
  // PostgreSQL batches are serializable. Retry only the database write after a
  // conflicting transaction rolls back, so the guard reads the new state.
  try {
    return await d1.batch<T>(statements);
  } catch (error) {
    if (!databaseConflict(error)) throw error;
    return d1.batch<T>(statements);
  }
}

async function writeWithMembershipGuard<T>(
  d1: D1Database,
  ...statements: D1PreparedStatement[]
): Promise<T | undefined> {
  const [result] = await runMembershipBatch<T>(d1, ...statements);
  return result.results[0];
}

export async function assignOrTransferMembership(
  d1: D1Database,
  principalId: string,
  tenantId: number,
  role: AgencyRole,
  options?: MembershipDestinationOptions & { revokePlatformRole?: boolean },
): Promise<AgencyMembership> {
  await ensureCommercialTenant(d1, tenantId, options);
  const current = await d1
    .prepare(
      "SELECT tenant_id,is_active FROM identity_tenant_membership WHERE principal_id=?",
    )
    .bind(principalId)
    .first<{ tenant_id: number; is_active: number }>();
  if (current && current.tenant_id !== tenantId && current.is_active) {
    await assertPrincipalCanLoseActiveMembership(d1, principalId);
  }
  const now = new Date().toISOString();
  const allowInactive = Number(options?.allowInactiveTenant ?? false);
  const revokePlatformRole = options?.revokePlatformRole === true;
  const platformGuard = revokePlatformRole
    ? `AND NOT ${isLastActivePlatformAdministrator("?")}`
    : "";
  // Lock the destination through the write in PostgreSQL so deactivation
  // cannot take effect between this last check and the membership commit.
  const lock = dialectFor(d1).name === "postgres" ? "FOR SHARE" : "";
  const write = d1
    .prepare(
      `INSERT INTO identity_tenant_membership(
        id,principal_id,tenant_id,role,is_active,created_at,updated_at
      )
      SELECT ?,?,id,?,1,?,? FROM tenants
      WHERE id=? AND kind='commercial' AND (?=1 OR is_active=1)
        AND purge_token IS NULL
        AND NOT EXISTS(SELECT 1 FROM identity_principal pending
          WHERE pending.id=? AND pending.deletion_started_at IS NOT NULL)
      ${platformGuard}
      ${lock}
      ON CONFLICT(principal_id) DO UPDATE SET
        tenant_id=excluded.tenant_id,
        role=excluded.role,
        is_active=1,
        updated_at=excluded.updated_at
      WHERE identity_tenant_membership.tenant_id=excluded.tenant_id
        OR NOT ${isLastActiveMember("identity_tenant_membership.principal_id")}
      RETURNING id,principal_id,tenant_id,role,is_active,created_at,updated_at`,
    )
    .bind(
      crypto.randomUUID(),
      principalId,
      role,
      now,
      now,
      tenantId,
      allowInactive,
      principalId,
      ...(revokePlatformRole ? [principalId] : []),
    );
  const statements = [write];
  if (revokePlatformRole) {
    // Remove the platform role only in the transaction that confirms the
    // commercial membership. A blocked transfer leaves both unchanged.
    const guard = `AND NOT ${isLastActivePlatformAdministrator("?")}
           AND EXISTS (
             SELECT 1 FROM identity_tenant_membership member
             JOIN tenants destination ON destination.id=member.tenant_id
             JOIN identity_principal principal ON principal.id=member.principal_id
             WHERE principal.id=?
               AND member.tenant_id=? AND member.role=? AND member.is_active=1
               AND destination.kind='commercial' AND (?=1 OR destination.is_active=1)
               AND destination.purge_token IS NULL AND principal.deletion_started_at IS NULL
           )`;
    const values = [
      principalId,
      principalId,
      principalId,
      tenantId,
      role,
      allowInactive,
    ];
    statements.push(
      d1
        .prepare(
          `UPDATE identity_principal SET platform_admin_revoked=1 WHERE id=? ${guard}`,
        )
        .bind(...values),
      d1
        .prepare(
          `DELETE FROM identity_global_role WHERE principal_id=? AND role='platform_admin' ${guard}`,
        )
        .bind(...values),
    );
  }
  const saved = await writeWithMembershipGuard<MembershipRow>(
    d1,
    ...statements,
  );
  if (!saved) {
    await assertPrincipalNotDeleting(d1, principalId);
    await ensureCommercialTenant(d1, tenantId, options);
    if (revokePlatformRole)
      await assertPlatformAdministratorCanLeave(d1, principalId);
    await assertPrincipalCanLoseActiveMembership(d1, principalId);
    throw new TenantMembershipInvariantError(
      "COMMERCIAL_TENANT_REQUIRED",
      "The destination tenant is unavailable for membership changes",
    );
  }
  return document(saved);
}

export async function assertPrincipalCanLoseActiveMembership(
  d1: D1Database,
  principalId: string,
): Promise<void> {
  const last = await d1
    .prepare(`SELECT ${isLastActiveMember("?")} AS last_active_member`)
    .bind(principalId)
    .first<boolean | number>("last_active_member");
  if (last) throw lastActiveMemberError();
}

/** Stop counting the principal as active before its Auth account is removed. */
export async function beginPrincipalDeletion(
  d1: D1Database,
  principalId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const write = d1
    .prepare(
      `UPDATE identity_principal SET is_active=0,updated_at=?,
         deletion_started_at=COALESCE(deletion_started_at,?)
       WHERE id=? AND NOT ${isLastActiveMember("identity_principal.id")}
         AND NOT ${isLastActivePlatformAdministrator("identity_principal.id")}
       RETURNING id`,
    )
    .bind(now, now, principalId);
  if (await writeWithMembershipGuard<{ id: string }>(d1, write)) return true;
  await assertPlatformAdministratorCanLeave(d1, principalId);
  const existing = await d1
    .prepare("SELECT 1 FROM identity_principal WHERE id=?")
    .bind(principalId)
    .first();
  if (existing) throw lastActiveMemberError();
  return false;
}

export async function suspendPrincipal(
  d1: D1Database,
  principalId: string,
): Promise<IdentityPrincipal> {
  await assertPrincipalCanLoseActiveMembership(d1, principalId);
  const write = d1
    .prepare(
      `UPDATE identity_principal SET is_active=0,updated_at=?
       WHERE id=? AND deletion_started_at IS NULL
         AND NOT ${isLastActiveMember("identity_principal.id")}
         AND NOT ${isLastActivePlatformAdministrator("identity_principal.id")}
       RETURNING id,issuer,subject,email,display_name AS "displayName",
         created_at AS "createdAt",updated_at AS "updatedAt"`,
    )
    .bind(new Date().toISOString(), principalId);
  const saved = await writeWithMembershipGuard<
    Omit<IdentityPrincipal, "isActive">
  >(d1, write);
  if (saved) return { ...saved, isActive: false };
  await assertPrincipalNotDeleting(d1, principalId);
  await assertPlatformAdministratorCanLeave(d1, principalId);
  const existing = await d1
    .prepare("SELECT 1 FROM identity_principal WHERE id=?")
    .bind(principalId)
    .first();
  if (existing) throw lastActiveMemberError();
  throw new Error("Unable to update identity principal state");
}

export async function grantPlatformAdministrator(
  d1: D1Database,
  principalId: string,
  source: "bootstrap" | "administrator",
): Promise<boolean> {
  const explicit = source === "administrator";
  if (explicit) await assertPrincipalCanLoseActiveMembership(d1, principalId);
  const platform = await ensurePlatformTenant(d1);
  if (platform.kind !== "platform") {
    throw new TenantMembershipInvariantError(
      "PLATFORM_TENANT_RESERVED",
      "The internal platform tenant is misconfigured",
    );
  }
  const now = new Date().toISOString();
  const hasMembership = `EXISTS (
    SELECT 1 FROM identity_tenant_membership member
    WHERE member.principal_id=identity_principal.id AND member.tenant_id=0
      AND member.role='tenant_admin' AND member.is_active=1
  )`;
  const hasRole = `EXISTS (
    SELECT 1 FROM identity_global_role role
    WHERE role.principal_id=identity_principal.id AND role.role='platform_admin'
  )`;
  // Auth may already report an administrator while a managed promotion is
  // still pending. Only the explicit grant can move a commercial member.
  const eligible = explicit
    ? "deletion_started_at IS NULL"
    : `deletion_started_at IS NULL AND is_active=1 AND platform_admin_revoked=0
      AND (${hasRole} OR NOT EXISTS (
        SELECT 1 FROM identity_tenant_membership member
        WHERE member.principal_id=identity_principal.id AND member.tenant_id<>0
      ))`;
  const assign = d1
    .prepare(
      `INSERT INTO identity_tenant_membership(
        id,principal_id,tenant_id,role,is_active,created_at,updated_at
      )
      SELECT ?,id,?,?,1,?,? FROM identity_principal
      WHERE id=? AND ${eligible}
      ON CONFLICT(principal_id) DO UPDATE SET
        tenant_id=excluded.tenant_id,
        role=excluded.role,
        is_active=1,
        updated_at=excluded.updated_at
      WHERE (identity_tenant_membership.tenant_id<>excluded.tenant_id
         OR identity_tenant_membership.role<>excluded.role
         OR identity_tenant_membership.is_active<>1)
        AND NOT ${isLastActiveMember("identity_tenant_membership.principal_id")}
      `,
    )
    .bind(
      crypto.randomUUID(),
      PLATFORM_TENANT_ID,
      "tenant_admin",
      now,
      now,
      principalId,
    );
  const grant = d1
    .prepare(
      `INSERT INTO identity_global_role(principal_id, role, created_at, session_after)
    SELECT id,'platform_admin',?,? FROM identity_principal
    WHERE id=? AND ${eligible} AND ${hasMembership}
    ON CONFLICT(principal_id,role) DO UPDATE SET session_after=excluded.session_after
    WHERE identity_global_role.session_after IS NULL AND excluded.session_after IS NOT NULL`,
    )
    .bind(now, explicit ? now : null, principalId);
  const confirmed = `id=? AND ${eligible} AND ${hasMembership} AND ${hasRole}`;
  const statements = [assign, grant];
  if (explicit) {
    statements.push(
      d1
        .prepare(
          `UPDATE identity_principal SET platform_admin_revoked=0 WHERE ${confirmed}`,
        )
        .bind(principalId),
    );
  }
  statements.push(
    d1
      .prepare(`SELECT 1 FROM identity_principal WHERE ${confirmed}`)
      .bind(principalId),
  );
  const results = await runMembershipBatch(d1, ...statements);
  if (results.at(-1)?.results.length) return true;
  if (!explicit) return false;
  await assertPrincipalNotDeleting(d1, principalId);
  throw lastActiveMemberError();
}

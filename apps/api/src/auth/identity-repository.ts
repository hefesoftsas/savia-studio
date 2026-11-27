import { AuthenticationError } from "./types";
import { dialectFor } from "@savia/db/dialect";
import { databaseConflict } from "@savia/db/errors";
import {
  tenants,
  identityTenantMemberships,
  identityGlobalRoles,
  identityPrincipals,
} from "@savia/db/core-schema";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { isRegisteredAgencyRole } from "./access-policy";
import {
  TenantMembershipInvariantError,
  assertPrincipalCanLoseActiveMembership,
  assertPrincipalNotDeleting,
  assignOrTransferMembership,
  grantPlatformAdministrator,
  suspendPrincipal,
  type MembershipDestinationOptions,
} from "./tenant-membership-invariants";
import type {
  AgencyMembership,
  AgencyRole,
  AppActor,
  ExternalIdentity,
  GlobalRole,
  IdentityPrincipal,
} from "./types";

function database(d1: D1Database) {
  return drizzle(d1, {
    schema: {
      tenants,
      identityTenantMemberships,
      identityGlobalRoles,
      identityPrincipals,
    },
  });
}

function timestamp(): string {
  return new Date().toISOString();
}

function principal(
  row: typeof identityPrincipals.$inferSelect,
): IdentityPrincipal {
  return row;
}

function membership(
  row: typeof identityTenantMemberships.$inferSelect,
): AgencyMembership {
  if (!isRegisteredAgencyRole(row.role)) {
    throw new Error("Invalid agency membership role in D1");
  }
  return { ...row, agencyId: row.tenantId, role: row.role };
}

function globalRole(row: typeof identityGlobalRoles.$inferSelect): GlobalRole {
  if (row.role !== "platform_admin")
    throw new Error("Invalid global role in D1");
  return row.role;
}

function emailConflict(): AuthenticationError {
  return new AuthenticationError(
    "IDENTITY_EMAIL_CONFLICT",
    "An active account already uses this email. Ask an administrator to resolve the identity conflict.",
  );
}

/** A matching email is not proof that two login subjects are the same person. */
export async function assertIdentityEmailAvailable(
  d1: D1Database,
  email: string,
  excludingId?: string,
): Promise<void> {
  const duplicate = await d1
    .prepare(
      "SELECT id FROM identity_principal WHERE is_active=1 AND lower(trim(email))=? AND id<>? LIMIT 1",
    )
    .bind(email.trim().toLowerCase(), excludingId ?? "")
    .first<{ id: string }>();
  if (duplicate) throw emailConflict();
}

export async function readIdentityDirectoryRevision(
  d1: D1Database,
): Promise<number> {
  const lookup = d1.prepare(
    "SELECT revision FROM identity_directory_revision WHERE id=1",
  );
  const current = await lookup.first<number>("revision");
  if (current !== null) return current;
  await d1
    .prepare(
      "INSERT INTO identity_directory_revision(id,revision) VALUES(1,0) ON CONFLICT(id) DO NOTHING",
    )
    .run();
  const initialized = await lookup.first<number>("revision");
  if (initialized === null)
    throw new Error("Missing identity directory revision");
  return initialized;
}

export function upsertPrincipal(
  d1: D1Database,
  external: ExternalIdentity,
): Promise<IdentityPrincipal>;
export function upsertPrincipal(
  d1: D1Database,
  external: ExternalIdentity,
  directoryRevision: number,
): Promise<IdentityPrincipal | undefined>;
export async function upsertPrincipal(
  d1: D1Database,
  external: ExternalIdentity,
  directoryRevision?: number,
): Promise<IdentityPrincipal | undefined> {
  external = { ...external, email: external.email.trim().toLowerCase() };
  const existing = await findPrincipalBySubject(
    d1,
    external.issuer,
    external.subject,
  );
  if (directoryRevision !== undefined && existing?.deletionStartedAt)
    return undefined;
  if (
    !existing ||
    (existing.isActive &&
      existing.email.trim().toLowerCase() !== external.email)
  ) {
    await assertIdentityEmailAvailable(d1, external.email, existing?.id);
  }
  if (
    existing &&
    existing.email.trim().toLowerCase() === external.email &&
    existing.displayName === external.displayName
  ) {
    return existing;
  }
  try {
    return await persistPrincipal(d1, external, directoryRevision);
  } catch (error) {
    rethrowIdentityWriteError(error);
  }
}

function rethrowIdentityWriteError(error: unknown): never {
  // Drizzle retains the database error in its cause chain.
  let cause: unknown = error;
  for (let depth = 0; cause instanceof Error && depth < 8; depth++) {
    if (cause.message.includes("IDENTITY_EMAIL_CONFLICT"))
      throw emailConflict();
    cause = cause.cause;
  }
  throw error;
}

async function persistPrincipal(
  d1: D1Database,
  external: ExternalIdentity,
  directoryRevision?: number,
): Promise<IdentityPrincipal | undefined> {
  const db = database(d1);
  const now = timestamp();
  const postgres = dialectFor(d1).name === "postgres";
  if (postgres || directoryRevision !== undefined) {
    // A catalog write must serialize with principal deletion. PostgreSQL
    // holds the shared revision lock until the statement commits.
    const values =
      directoryRevision === undefined
        ? "VALUES(?,?,?,?,?,1,?,?)"
        : `SELECT ?,?,?,?,?,1,?,? FROM (
          SELECT revision FROM identity_directory_revision WHERE id=1
          ${postgres ? "FOR SHARE" : ""}
        ) directory WHERE directory.revision=?`;
    const saved = await d1
      .prepare(
        `INSERT INTO identity_principal(id,issuer,subject,email,display_name,is_active,created_at,updated_at)
      ${values} ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,updated_at=excluded.updated_at
        ${directoryRevision === undefined ? "" : "WHERE identity_principal.deletion_started_at IS NULL"}
      RETURNING id,issuer,subject,email,display_name AS "displayName",is_active AS "isActive",
        deletion_started_at AS "deletionStartedAt",platform_admin_revoked AS "platformAdminRevoked",
        created_at AS "createdAt",updated_at AS "updatedAt"`,
      )
      .bind(
        crypto.randomUUID(),
        external.issuer,
        external.subject,
        external.email,
        external.displayName,
        now,
        now,
        ...(directoryRevision === undefined ? [] : [directoryRevision]),
      )
      .first<IdentityPrincipal>();
    if (!saved) {
      if (directoryRevision !== undefined) return undefined;
      throw new Error("Unable to create identity principal");
    }
    return {
      ...saved,
      isActive: Boolean(saved.isActive),
      platformAdminRevoked: Boolean(saved.platformAdminRevoked),
    };
  }
  const [saved] = await db
    .insert(identityPrincipals)
    .values({
      id: crypto.randomUUID(),
      issuer: external.issuer,
      subject: external.subject,
      email: external.email,
      displayName: external.displayName,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [identityPrincipals.issuer, identityPrincipals.subject],
      set: {
        email: external.email,
        displayName: external.displayName,
        updatedAt: now,
      },
    })
    .returning();
  if (!saved) throw new Error("Unable to create identity principal");
  return principal(saved);
}

export async function findPrincipal(
  d1: D1Database,
  principalId: string,
): Promise<IdentityPrincipal | undefined> {
  const row = await database(d1)
    .select()
    .from(identityPrincipals)
    .where(eq(identityPrincipals.id, principalId))
    .get();
  return row ? principal(row) : undefined;
}

export async function findPrincipalBySubject(
  d1: D1Database,
  issuer: string,
  subject: string,
): Promise<IdentityPrincipal | undefined> {
  const row = await database(d1)
    .select()
    .from(identityPrincipals)
    .where(
      and(
        eq(identityPrincipals.issuer, issuer),
        eq(identityPrincipals.subject, subject),
      ),
    )
    .get();
  return row ? principal(row) : undefined;
}

export async function deletePrincipal(
  d1: D1Database,
  principalId: string,
): Promise<void> {
  const statements = [
    d1
      .prepare(
        `INSERT INTO identity_directory_revision(id,revision)
         SELECT 1,1 WHERE EXISTS (SELECT 1 FROM identity_principal WHERE id=?)
         ON CONFLICT(id) DO UPDATE SET revision=identity_directory_revision.revision+1`,
      )
      .bind(principalId),
    d1.prepare("DELETE FROM identity_principal WHERE id=?").bind(principalId),
  ];
  try {
    await d1.batch(statements);
  } catch (error) {
    if (!databaseConflict(error)) throw error;
    await d1.batch(statements);
  }
}

export async function updatePrincipal(
  d1: D1Database,
  principalId: string,
  input: { displayName?: string },
): Promise<IdentityPrincipal> {
  const [updated] = await database(d1)
    .update(identityPrincipals)
    .set({ ...input, updatedAt: timestamp() })
    .where(eq(identityPrincipals.id, principalId))
    .returning();
  if (!updated) throw new Error("Unable to update identity principal");
  return principal(updated);
}

/** A session refresh may update this principal but cannot recreate it. */
export async function refreshAuthenticatedPrincipal(
  d1: D1Database,
  existing: IdentityPrincipal,
  external: Pick<ExternalIdentity, "email" | "displayName">,
): Promise<IdentityPrincipal | undefined> {
  const email = external.email.trim().toLowerCase();
  const emailChanged = email !== existing.email.trim().toLowerCase();
  if (
    !existing.isActive ||
    (!emailChanged && existing.displayName === external.displayName)
  )
    return existing;
  if (emailChanged) await assertIdentityEmailAvailable(d1, email, existing.id);
  try {
    const saved = await d1
      .prepare(
        `UPDATE identity_principal SET email=?,display_name=?,updated_at=?
         WHERE id=? AND is_active=1 AND deletion_started_at IS NULL
         RETURNING id,issuer,subject,email,display_name AS "displayName",is_active AS "isActive",
           deletion_started_at AS "deletionStartedAt",platform_admin_revoked AS "platformAdminRevoked",
           created_at AS "createdAt",updated_at AS "updatedAt"`,
      )
      .bind(email, external.displayName, timestamp(), existing.id)
      .first<IdentityPrincipal>();
    if (!saved) return undefined;
    return {
      ...saved,
      isActive: Boolean(saved.isActive),
      platformAdminRevoked: Boolean(saved.platformAdminRevoked),
    };
  } catch (error) {
    rethrowIdentityWriteError(error);
  }
}

export async function setPrincipalActive(
  d1: D1Database,
  principalId: string,
  isActive: boolean,
): Promise<IdentityPrincipal> {
  if (!isActive) return suspendPrincipal(d1, principalId);
  await assertPrincipalNotDeleting(d1, principalId);
  const existing = await findPrincipal(d1, principalId);
  if (existing && !existing.isActive)
    await assertIdentityEmailAvailable(d1, existing.email, principalId);
  try {
    const [updated] = await database(d1)
      .update(identityPrincipals)
      .set({ isActive: true, updatedAt: timestamp() })
      .where(
        and(
          eq(identityPrincipals.id, principalId),
          sql`deletion_started_at IS NULL`,
        ),
      )
      .returning();
    if (!updated) {
      await assertPrincipalNotDeleting(d1, principalId);
      throw new Error("Unable to update identity principal state");
    }
    return principal(updated);
  } catch (error) {
    rethrowIdentityWriteError(error);
  }
}

export async function listMemberships(
  d1: D1Database,
  principalId: string,
): Promise<AgencyMembership[]> {
  const rows = await database(d1)
    .select({
      membership: identityTenantMemberships,
      tenantActive: tenants.isActive,
      tenantName: tenants.name,
      tenantSlug: tenants.idSlug,
    })
    .from(identityTenantMemberships)
    .innerJoin(tenants, eq(tenants.id, identityTenantMemberships.tenantId))
    .where(eq(identityTenantMemberships.principalId, principalId))
    .orderBy(identityTenantMemberships.tenantId)
    .all();
  return rows.map((row) => ({
    ...membership({
      ...row.membership,
      isActive: row.membership.isActive && row.tenantActive,
    }),
    tenantName: row.tenantName,
    tenantSlug: row.tenantSlug,
  }));
}

async function listGlobalRoleRows(d1: D1Database, principalId: string) {
  return database(d1)
    .select()
    .from(identityGlobalRoles)
    .where(eq(identityGlobalRoles.principalId, principalId))
    .all();
}

export async function listGlobalRoles(
  d1: D1Database,
  principalId: string,
): Promise<GlobalRole[]> {
  return (await listGlobalRoleRows(d1, principalId)).map(globalRole);
}

export async function loadActor(
  d1: D1Database,
  entry: IdentityPrincipal,
): Promise<AppActor> {
  const [roles, memberships] = await Promise.all([
    listGlobalRoleRows(d1, entry.id),
    listMemberships(d1, entry.id),
  ]);
  const sessionAfter = roles.find(
    (row) => row.role === "platform_admin",
  )?.sessionAfter;
  return {
    principal: entry,
    globalRoles: roles.map(globalRole),
    ...(sessionAfter == null
      ? {}
      : { platformAdminSessionAfter: sessionAfter }),
    memberships,
  };
}

export async function ensureBootstrapAdministrator(
  d1: D1Database,
  principalId: string,
): Promise<boolean> {
  return grantPlatformAdministrator(d1, principalId, "bootstrap");
}

export async function setPlatformAdministrator(
  d1: D1Database,
  principalId: string,
  enabled: boolean,
  commercialTenantId?: number,
  commercialRole: AgencyRole = "viewer",
): Promise<void> {
  if (enabled) {
    await grantPlatformAdministrator(d1, principalId, "administrator");
    return;
  }
  if (commercialTenantId === undefined) {
    throw new TenantMembershipInvariantError(
      "COMMERCIAL_TENANT_REQUIRED",
      "A commercial tenant is required when revoking platform administration",
    );
  }
  await assignOrTransferMembership(
    d1,
    principalId,
    commercialTenantId,
    commercialRole,
    { revokePlatformRole: true },
  );
}

export async function activePlatformAdministratorCount(
  d1: D1Database,
): Promise<number> {
  const rows = await database(d1)
    .select({ id: identityPrincipals.id })
    .from(identityPrincipals)
    .innerJoin(
      identityGlobalRoles,
      eq(identityGlobalRoles.principalId, identityPrincipals.id),
    )
    .where(
      and(
        eq(identityPrincipals.isActive, true),
        eq(identityGlobalRoles.role, "platform_admin"),
      ),
    )
    .all();
  return rows.length;
}

export { TenantMembershipInvariantError as TenantMembershipError };

export async function grantMembership(
  d1: D1Database,
  principalId: string,
  tenantId: number,
  role: AgencyRole,
  options?: MembershipDestinationOptions,
): Promise<AgencyMembership> {
  if (!isRegisteredAgencyRole(role))
    throw new Error("Invalid tenant membership role");
  const platformAdministrator = await database(d1)
    .select({ role: identityGlobalRoles.role })
    .from(identityGlobalRoles)
    .where(
      and(
        eq(identityGlobalRoles.principalId, principalId),
        eq(identityGlobalRoles.role, "platform_admin"),
      ),
    )
    .get();
  if (platformAdministrator) {
    throw new TenantMembershipInvariantError(
      "PLATFORM_ADMIN_REQUIRES_REVOCATION",
      "Revoke platform administration with a commercial tenant before transferring this user",
    );
  }
  return assignOrTransferMembership(d1, principalId, tenantId, role, options);
}

export async function removeMembership(
  d1: D1Database,
  principalId: string,
  agencyId: number,
): Promise<void> {
  const current = await database(d1)
    .select({ tenantId: identityTenantMemberships.tenantId })
    .from(identityTenantMemberships)
    .where(eq(identityTenantMemberships.principalId, principalId))
    .get();
  if (!current || current.tenantId !== agencyId) return;
  await assertPrincipalCanLoseActiveMembership(d1, principalId);
  throw new TenantMembershipInvariantError(
    "COMMERCIAL_TENANT_REQUIRED",
    "Transfer the user to another commercial tenant instead of removing membership",
  );
}

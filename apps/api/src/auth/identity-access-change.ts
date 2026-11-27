import { AccessControlError } from "./access-registry";

const LEASE_MS = 5 * 60 * 1000;

export type IdentityAccessChange = {
  renew(): Promise<void>;
  assertSourceAvailable(): Promise<void>;
};

export async function hasIdentityAccessChangeInTenant(
  db: D1Database,
  tenantId: number,
): Promise<boolean> {
  return Boolean(
    await db
      .prepare(
        `SELECT 1 FROM identity_access_change_leases access_change
       JOIN identity_tenant_membership member ON member.principal_id=access_change.principal_id
       WHERE member.tenant_id=? AND access_change.lease_until>? LIMIT 1`,
      )
      .bind(tenantId, Date.now())
      .first(),
  );
}

function accessChangeConflict() {
  return new AccessControlError(
    409,
    "IDENTITY_ACCESS_CHANGE_IN_PROGRESS",
    "Another access change is in progress for this user. Reload the user before trying again.",
  );
}

/** Keep the Auth update, membership write, and any rollback under one owner. */
export async function withIdentityAccessChange<T>(
  db: D1Database,
  principalId: string,
  change: (lease: IdentityAccessChange) => Promise<T>,
): Promise<T> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const claimed = await db
    .prepare(
      `INSERT INTO identity_access_change_leases(principal_id,lease_token,lease_until)
       SELECT id,?,? FROM identity_principal WHERE id=?
       ON CONFLICT(principal_id) DO UPDATE
       SET lease_token=excluded.lease_token,lease_until=excluded.lease_until
       WHERE identity_access_change_leases.lease_until<=?
       RETURNING lease_token`,
    )
    .bind(token, now + LEASE_MS, principalId, now)
    .first<string>("lease_token");
  if (claimed !== token) throw accessChangeConflict();

  const renew = async () => {
    const now = Date.now();
    const current = await db
      .prepare(
        `UPDATE identity_access_change_leases SET lease_until=?
         WHERE principal_id=? AND lease_token=? AND lease_until>?
         RETURNING lease_token`,
      )
      .bind(now + LEASE_MS, principalId, token, now)
      .first();
    if (!current) throw accessChangeConflict();
  };
  const assertSourceAvailable = async () => {
    // Access changes claim the principal before checking the source. Deletion
    // claims the tenant before checking for active principal leases.
    const busy = await db
      .prepare(
        `SELECT 1 FROM identity_tenant_membership member
       JOIN tenant_deletion_leases lifecycle ON lifecycle.tenant_id=member.tenant_id
       WHERE member.principal_id=? AND lifecycle.lease_until>?`,
      )
      .bind(principalId, Date.now())
      .first();
    if (busy) {
      throw new AccessControlError(
        409,
        "TENANT_PURGE_IN_PROGRESS",
        "An operation is in progress for the user's current tenant. Wait for it to finish before trying again.",
      );
    }
  };
  try {
    return await change({ renew, assertSourceAvailable });
  } finally {
    try {
      await db
        .prepare(
          "DELETE FROM identity_access_change_leases WHERE principal_id=? AND lease_token=?",
        )
        .bind(principalId, token)
        .run();
    } catch {
      console.warn("IDENTITY_ACCESS_CHANGE_LEASE_RELEASE_DEFERRED");
    }
  }
}

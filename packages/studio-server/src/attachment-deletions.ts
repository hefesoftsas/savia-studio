import { dialectFor } from "@savia/db/dialect";

const batchSize = 25;
const retryDelayMs = 5 * 60 * 1000;

export async function purgeExpiredTemporaryAttachments(
  db: D1Database,
  files: R2Bucket,
  tenant?: string,
) {
  const tenantFilter = tenant === undefined ? "" : "tenant_id=? AND ";
  const tenantParameters = tenant === undefined ? [] : [tenant];
  const expiredFilter = `${tenantFilter}expires_at<=${dialectFor(db).utcNow()}`;
  try {
    const { results } = await db
      .prepare(
        `SELECT id FROM studio_file_drafts WHERE ${expiredFilter} ORDER BY expires_at,id LIMIT ?`,
      )
      .bind(...tenantParameters, batchSize)
      .all<{ id: string }>();
    if (!results.length) return;

    // A completed association has removed the draft, and an expired draft cannot be promoted.
    const { results: expired } = await db
      .prepare(
        `UPDATE studio_file_drafts SET expires_at=expires_at
         WHERE ${expiredFilter} AND id IN (${results.map(() => "?").join(",")})
         RETURNING id,storage_key`,
      )
      .bind(...tenantParameters, ...results.map(({ id }) => id))
      .all<{ id: string; storage_key: string }>();
    if (!expired.length) return;
    await files.delete(expired.map(({ storage_key }) => storage_key));
    await db
      .prepare(
        `DELETE FROM studio_file_drafts WHERE ${tenantFilter}id IN (${expired.map(() => "?").join(",")})`,
      )
      .bind(...tenantParameters, ...expired.map(({ id }) => id))
      .run();
  } catch {
    // Retain draft metadata for the next cleanup attempt.
    if (tenant === undefined)
      console.warn("STUDIO_EXPIRED_ATTACHMENT_CLEANUP_DEFERRED");
  }
}

/** Claim due keys before deleting bytes so an upload cannot commit a claimed key. */
export async function cleanDeletedAttachmentObjects(
  db: D1Database,
  files: R2Bucket,
  target?: { tenant: string; fileId: string },
) {
  const now = Date.now();
  const claimedUntil = now + retryDelayMs;
  const targetFilter = target ? "AND tenant_id=? AND file_id=?" : "";
  const targetParameters = target ? [target.tenant, target.fileId] : [];
  const { results } = await db
    .prepare(
      `UPDATE studio_file_deletions SET next_attempt_at=?
       WHERE next_attempt_at<=? AND storage_key IN (
         SELECT storage_key FROM studio_file_deletions
         WHERE next_attempt_at<=? ${targetFilter}
         ORDER BY next_attempt_at,storage_key LIMIT ?
       )
       RETURNING storage_key`,
    )
    .bind(claimedUntil, now, now, ...targetParameters, batchSize)
    .all<{ storage_key: string }>();
  if (!results.length) return;

  const keys = results.map(({ storage_key }) => storage_key);
  const placeholders = keys.map(() => "?").join(",");
  try {
    await files.delete(keys);
  } catch {
    console.warn("STUDIO_ATTACHMENT_CLEANUP_DEFERRED", keys.length);
    return;
  }
  await db
    .prepare(
      `DELETE FROM studio_file_deletions WHERE next_attempt_at=? AND storage_key IN (${placeholders})`,
    )
    .bind(claimedUntil, ...keys)
    .run();
}

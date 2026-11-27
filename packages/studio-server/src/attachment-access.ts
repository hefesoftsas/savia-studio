import type { AccessPolicy } from "@savia/studio-shared/access-control";
import { decideRecord } from "@savia/studio-shared/access-evaluator";
import type { StudioRecord } from "@savia/studio-shared/metadata";
import { z } from "zod";
import { accessDenied, accessRecord, policyFor } from "./access-authorization";
import { getObject, getRecord, parseRecord } from "./services";

export type AttachmentField = { object_name: string; field_name: string };
export type AttachmentIntent = {
  created_by: string | null;
  create_request_key: string | null;
};

export function requireAttachmentCreator(
  db: D1Database,
  owner: string | null,
  principalId: string,
) {
  const policy = policyFor(db);
  if (owner ? owner !== (policy?.principalId ?? principalId) : policy)
    accessDenied();
}

export function requireAttachmentCreateGrant(
  policy: AccessPolicy,
  file: AttachmentField,
) {
  if (
    !policy.grants.some(
      (grant) =>
        grant.resource === `collection:${file.object_name}` &&
        grant.action === "create" &&
        grant.fields.includes(file.field_name),
    )
  )
    accessDenied();
}

export function allowsAttachmentField(
  policy: AccessPolicy,
  file: AttachmentField,
  record: StudioRecord,
  action: "read" | "create" | "update",
) {
  const decision = decideRecord(
    policy,
    `collection:${file.object_name}`,
    action,
    accessRecord(record),
  );
  return (
    decision.allowed &&
    (!file.field_name || decision.fields.includes(file.field_name))
  );
}

export async function requireAttachmentRecord(
  db: D1Database,
  tenant: string,
  file: AttachmentField,
  recordId: string,
  action: "read" | "create" | "update",
) {
  const record = await getRecord(
    db,
    tenant,
    file.object_name,
    recordId,
    action,
  );
  const policy = policyFor(db);
  if (policy && !allowsAttachmentField(policy, file, record, action))
    accessDenied();
  return record;
}

const receiptRecord = z.object({
  id: z.string(),
  _version: z.literal(1),
  created_by: z.string(),
  created_at: z.string(),
});
const creationReceipt = z.union([
  receiptRecord,
  z.object({ result: z.object({ data: receiptRecord }) }),
]);

export async function authorizeAttachmentAssociation(
  db: D1Database,
  tenant: string,
  file: AttachmentField & AttachmentIntent,
  recordId: string,
  principalId: string,
) {
  requireAttachmentCreator(db, file.created_by, principalId);
  const policy = policyFor(db);
  if (!policy) return getRecord(db, tenant, file.object_name, recordId);
  if (!file.create_request_key)
    return requireAttachmentRecord(db, tenant, file, recordId, "update");

  const stored = await db
    .prepare(
      "SELECT response FROM studio_requests WHERE tenant_id=? AND request_key=?",
    )
    .bind(tenant, file.create_request_key)
    .first<string>("response");
  const receipt = creationReceipt.safeParse(stored ? JSON.parse(stored) : null);
  if (!receipt.success) accessDenied();
  const created =
    "result" in receipt.data ? receipt.data.result.data : receipt.data;
  if (created.id !== recordId || created.created_by !== policy.principalId)
    accessDenied();

  await getObject(db, tenant, file.object_name);
  const current = await db
    .prepare(
      "SELECT * FROM studio_records WHERE tenant_id=? AND object_name=? AND id=? AND deleted_at IS NULL",
    )
    .bind(tenant, file.object_name, recordId)
    .first();
  if (!current) accessDenied();
  const record = parseRecord(current);
  if (
    record.created_by !== created.created_by ||
    record.created_at !== created.created_at
  )
    accessDenied();
  if (
    record._version === created._version &&
    allowsAttachmentField(policy, file, record, "create")
  )
    return record;
  if (!allowsAttachmentField(policy, file, record, "update")) accessDenied();
  return record;
}

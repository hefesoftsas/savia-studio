import {
  adminNoticeSchema,
  type NoticeEventInput,
  type NotificationPolicy,
} from "@savia/studio-shared/notifications";
import { canonicalPayload, stableEventId } from "./types";
import { fail } from "../context";
import { NotificationRepository } from "./repository";

export interface AdminSendResult {
  eventId: string;
  status: "accepted";
  duplicate: boolean;
}

export interface AdminEventStatus {
  eventId: string;
  status: "accepted" | "processing" | "completed" | "failed";
  delivered: number;
  failed: number;
  pendingRetries: number;
  failures: { recipient: string; error: string }[];
}

const WINDOW_MS = 60_000;

export async function sendAdminNotice(
  db: D1Database,
  policy: NotificationPolicy,
  principal: string,
  scope: { kind: "workspace"; id: string },
  key: string,
  rawPayload: unknown,
  now: number = Date.now(),
): Promise<AdminSendResult> {
  const payload = adminNoticeSchema.parse(rawPayload);
  if (!(await policy.canSend(principal, scope)))
    return fail("Administrator permission required.", 403);
  if (!key || key.length > 200) return fail("Invalid message key.", 400);
  const event: NoticeEventInput = {
    scope,
    key: `admin:${principal}:${key}`,
    actor: { kind: "user", id: principal },
    source: { kind: "admin-message", id: key },
    title: payload.title,
    body: payload.body,
    audience: payload.audience,
    ...(payload.requireAcknowledgement ? { requireAcknowledgement: true } : {}),
    createdAt: now,
    expiresAt: null,
  };
  const repository = new NotificationRepository(db);
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  const findRetry = async (): Promise<AdminSendResult | null> => {
    const existing = await repository.find(event);
    if (!existing) return null;
    const original: NoticeEventInput = JSON.parse(existing.payload);
    if (
      existing.payload ===
      canonicalPayload({ ...event, createdAt: original.createdAt })
    )
      return { eventId: existing.id, status: "accepted", duplicate: true };
    return fail("The message key already exists with different content.", 409);
  };
  const previous = await findRetry();
  if (previous) return previous;

  const eventId = stableEventId(event);
  try {
    await db.batch([
      ...repository.eventStatements(event),
      db
        .prepare(
          `INSERT INTO notification_send_limits(workspace_id,actor_id,window_start,count)
           VALUES (?,?,?,1)
           ON CONFLICT(workspace_id,actor_id,window_start) DO UPDATE SET count=notification_send_limits.count+1`,
        )
        .bind(scope.id, principal, windowStart),
      db
        .prepare(
          `INSERT INTO notification_admin_audit(id,workspace_id,actor_id,event_id,action,created_at)
           VALUES (?,?,?,?,?,?)`,
        )
        .bind(`audit_${eventId}`, scope.id, principal, eventId, "send", now),
    ]);
  } catch (error) {
    const retry = await findRetry();
    if (retry) return retry;
    if (
      /notification_send_limits_count_check|CHECK constraint failed: count BETWEEN 1 AND 10/i.test(
        String(error),
      )
    )
      return fail("Administrator send quota exceeded. Retry in a minute.", 429);
    throw error;
  }
  return { eventId, status: "accepted", duplicate: false };
}

export async function adminEventStatus(
  db: D1Database,
  policy: NotificationPolicy,
  principal: string,
  workspace: string,
  eventId: string,
): Promise<AdminEventStatus> {
  const event = await requireAdminEvent(
    db,
    policy,
    principal,
    workspace,
    eventId,
  );
  const delivered =
    (await db
      .prepare(
        "SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notification_deliveries WHERE event_id=?",
      )
      .bind(eventId)
      .first<number>("n")) ?? 0;
  const retries = (
    await db
      .prepare(
        "SELECT recipient_id,error,status FROM notification_recipient_retries WHERE event_id=?",
      )
      .bind(eventId)
      .all<{ recipient_id: string; error: string; status: string }>()
  ).results;
  return {
    eventId,
    status:
      event.status === "completed"
        ? "completed"
        : event.status === "failed"
          ? "failed"
          : event.status === "processing"
            ? "processing"
            : "accepted",
    delivered,
    failed: retries.filter((row) => row.status === "failed").length,
    pendingRetries: retries.filter((row) => row.status === "pending").length,
    failures: retries
      .filter((row) => row.status === "failed")
      .map((row) => ({ recipient: row.recipient_id, error: row.error })),
  };
}

export async function retryAdminEvent(
  db: D1Database,
  policy: NotificationPolicy,
  principal: string,
  workspace: string,
  eventId: string,
  now: number = Date.now(),
): Promise<{ retried: number }> {
  await requireAdminEvent(db, policy, principal, workspace, eventId);
  const [, result] = await db.batch([
    db
      .prepare(
        `UPDATE notification_events
         SET status='pending',cursor=NULL,next_retry=?,lease_token=NULL,lease_until=0,error=NULL
         WHERE id=? AND status<>'processing'
           AND (status='failed' OR EXISTS (
             SELECT 1 FROM notification_recipient_retries
             WHERE event_id=notification_events.id AND status='failed'
           ))`,
      )
      .bind(now, eventId),
    db
      .prepare(
        `UPDATE notification_recipient_retries SET status='pending',attempts=0,next_retry=?
         WHERE event_id=? AND status='failed' AND EXISTS (
           SELECT 1 FROM notification_events WHERE id=notification_recipient_retries.event_id
             AND status='pending' AND next_retry=?
         )`,
      )
      .bind(now, eventId, now),
    db
      .prepare(
        `INSERT INTO notification_admin_audit(id,workspace_id,actor_id,event_id,action,created_at)
         VALUES (?,?,?,?,?,?)`,
      )
      .bind(
        `audit_retry_${crypto.randomUUID()}`,
        workspace,
        principal,
        eventId,
        "retry",
        now,
      ),
  ]);
  return { retried: result!.meta.changes ?? 0 };
}

async function requireAdminEvent(
  db: D1Database,
  policy: NotificationPolicy,
  principal: string,
  workspace: string,
  eventId: string,
) {
  if (
    !workspace ||
    !(await policy.canSend(principal, { kind: "workspace", id: workspace }))
  )
    return fail("Administrator permission required.", 403);
  const event = await db
    .prepare(
      "SELECT status,payload FROM notification_events WHERE id=? AND scope_kind='workspace' AND scope_id=?",
    )
    .bind(eventId, workspace)
    .first<{ status: string; payload: string }>();
  if (!event) return fail("Notification event not found.", 404);
  let payload: { source?: { kind?: unknown } } | null;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return fail("Notification event not found.", 404);
  }
  if (payload?.source?.kind !== "admin-message")
    return fail("Notification event not found.", 404);
  return event;
}

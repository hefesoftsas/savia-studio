import type {
  NoticeScope,
  NoticeEventInput,
} from "@savia/studio-shared/notifications";
import { fail } from "../context";
import { WorkflowRepository } from "@savia/flows-native/repository";

export type NoticeResolution =
  | { kind: "none" }
  | {
      kind: "task";
      state: "pending" | "done" | "unavailable";
      resolved: boolean;
    }
  | { kind: "acknowledge"; acknowledged: boolean }
  | { kind: "navigate"; route: string };

async function loadNotice(
  db: D1Database,
  principal: string,
  scopes: NoticeScope[],
  deliveryId: string,
) {
  if (!scopes.length) return fail("Notification not found.", 404);
  const scopeWhere = scopes
    .map(() => "(d.scope_kind=? AND d.scope_id=?)")
    .join(" OR ");
  const row = await db
    .prepare(
      `SELECT d.scope_kind,d.scope_id,d.resolved_at,e.payload
       FROM notification_deliveries d
       JOIN notification_events e ON e.id=d.event_id
       WHERE d.id=? AND d.recipient_id=? AND (${scopeWhere})`,
    )
    .bind(
      deliveryId,
      principal,
      ...scopes.flatMap(({ kind, id }) => [kind, id]),
    )
    .first<{
      scope_kind: NoticeScope["kind"];
      scope_id: string;
      resolved_at: number | null;
      payload: string;
    }>();
  if (!row) return fail("Notification not found.", 404);
  let event: NoticeEventInput | null;
  try {
    event = JSON.parse(row.payload);
  } catch {
    return fail("Notification payload is unreadable.", 422);
  }
  return {
    scope: { kind: row.scope_kind, id: row.scope_id },
    source: event?.source,
    requireAcknowledgement: event?.requireAcknowledgement === true,
    resolvedAt: row.resolved_at,
  };
}

async function noticeAction(
  db: D1Database,
  principal: string,
  notice: Awaited<ReturnType<typeof loadNotice>>,
): Promise<NoticeResolution> {
  const { scope, source, resolvedAt } = notice;
  if (source?.kind === "workflow-task") {
    if (scope.kind !== "workspace")
      return { kind: "task", state: "unavailable", resolved: false };
    const task = await db
      .prepare(
        "SELECT status,assignee FROM workflow_tasks WHERE workspace_id=? AND id=?",
      )
      .bind(scope.id, source.id)
      .first<{ status: string; assignee: string }>();
    if (!task) return { kind: "task", state: "unavailable", resolved: false };
    if (task.assignee !== principal)
      return fail("Notification not found.", 404);
    if (task.status === "done")
      return { kind: "task", state: "done", resolved: true };
    return { kind: "task", state: "pending", resolved: false };
  }
  if (source?.kind === "admin-message" && notice.requireAcknowledgement)
    return { kind: "acknowledge", acknowledged: resolvedAt !== null };
  if (source?.kind === "security-request")
    return { kind: "navigate", route: "/account" };
  return { kind: "none" };
}

export async function resolveNoticeAction(
  db: D1Database,
  principal: string,
  scopes: NoticeScope[],
  deliveryId: string,
): Promise<NoticeResolution> {
  return noticeAction(
    db,
    principal,
    await loadNotice(db, principal, scopes, deliveryId),
  );
}

export async function resolveTaskNotice(
  db: D1Database,
  principal: string,
  scopes: NoticeScope[],
  deliveryId: string,
): Promise<void> {
  const notice = await loadNotice(db, principal, scopes, deliveryId);
  const resolution = await noticeAction(db, principal, notice);
  if (
    resolution.kind === "task" &&
    resolution.state === "pending" &&
    notice.source?.kind === "workflow-task"
  ) {
    await new WorkflowRepository(db, notice.scope.id).resolveTask(
      notice.source.id,
      principal,
    );
    return;
  }
  if (resolution.kind === "acknowledge") {
    if (resolution.acknowledged) return;
    const updated = await db
      .prepare(
        `UPDATE notification_deliveries SET resolved_at=COALESCE(resolved_at,?)
         WHERE id=? AND recipient_id=?`,
      )
      .bind(Date.now(), deliveryId, principal)
      .run();
    if ((updated.meta.changes ?? 0) === 0)
      return fail("Notification not found.", 404);
    return;
  }
  return fail("Notice has no resolvable action.", 409);
}

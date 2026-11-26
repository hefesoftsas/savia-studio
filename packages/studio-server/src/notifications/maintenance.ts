import {
  notificationDefaults,
  retentionSchema,
} from "@savia/studio-shared/notifications";
import { fail } from "../context";
import { workflowTaskNotice, workflowTaskNoticeKey } from "./collection-events";
import {
  boundTextArrayRows,
  decodeCursor,
  encodeCursor,
  noticeActionSql,
} from "./types";

export interface MaintenanceReport {
  cleanedDeliveries: number;
  cleanedEvents: number;
  backfilled: number;
  cursor: string | null;
}

export async function getRetentionSettings(
  db: D1Database,
  workspaceId: string,
) {
  const row = await db
    .prepare(
      "SELECT read_days,unread_days FROM notification_scope_settings WHERE workspace_id=?",
    )
    .bind(workspaceId)
    .first<{ read_days: number; unread_days: number }>();
  return {
    readDays: row?.read_days ?? 90,
    unreadDays: row?.unread_days ?? 180,
  };
}

export async function saveRetentionSettings(
  db: D1Database,
  workspaceId: string,
  input: unknown,
) {
  const parsed = retentionSchema.parse(input);
  await db
    .prepare(
      `INSERT INTO notification_scope_settings(workspace_id,read_days,unread_days)
       VALUES (?,?,?)
       ON CONFLICT(workspace_id) DO UPDATE SET read_days=?,unread_days=?`,
    )
    .bind(
      workspaceId,
      parsed.readDays,
      parsed.unreadDays,
      parsed.readDays,
      parsed.unreadDays,
    )
    .run();
  return parsed;
}

export async function maintainNotifications(
  db: D1Database,
  now: number,
  limit = 100,
): Promise<MaintenanceReport> {
  const report: MaintenanceReport = {
    cleanedDeliveries: 0,
    cleanedEvents: 0,
    backfilled: 0,
    cursor: null,
  };
  const savedCursor =
    (await db
      .prepare(
        "SELECT cursor FROM notification_maintenance_checkpoints WHERE name='retention-deliveries'",
      )
      .first<string>("cursor")) ?? "";
  const cursor = savedCursor ? decodeCursor(savedCursor) : null;
  const cursorWhere = cursor ? "WHERE (created_at,id) > (?,?)" : "";
  const { sourceKind, sourceId } = noticeActionSql(db);
  const deliveries = (
    await db
      .prepare(
        `SELECT d.id,d.created_at,d.read_at,d.archived_at,e.payload,
                s.read_days,s.unread_days,t.id AS open_task
         FROM (
           SELECT id,event_id,created_at,read_at,archived_at,scope_kind,scope_id
           FROM notification_deliveries
           ${cursorWhere}
           ORDER BY created_at,id LIMIT ?
         ) d
         JOIN notification_events e ON e.id=d.event_id
         LEFT JOIN notification_scope_settings s
           ON d.scope_kind='workspace' AND s.workspace_id=d.scope_id
         LEFT JOIN workflow_tasks t
           ON d.scope_kind='workspace' AND t.workspace_id=d.scope_id
             AND (${sourceKind})='workflow-task' AND t.id=(${sourceId}) AND t.status!='done'
         ORDER BY d.created_at,d.id`,
      )
      .bind(...(cursor ?? []), limit)
      .all<{
        id: string;
        created_at: number;
        read_at: number | null;
        archived_at: number | null;
        read_days: number | null;
        unread_days: number | null;
        open_task: string | null;
        payload: string;
      }>()
  ).results;
  const dayMs = 86_400_000;
  const expiredReadIds: string[] = [];
  const expiredUnreadIds: string[] = [];
  for (const row of deliveries) {
    const read = row.read_at !== null || row.archived_at !== null;
    const retentionDays = read
      ? (row.read_days ?? notificationDefaults.readDays)
      : (row.unread_days ?? notificationDefaults.unreadDays);
    const age = now - row.created_at;
    if (age <= retentionDays * dayMs || row.open_task !== null) continue;
    try {
      const source = (JSON.parse(row.payload) as { source?: { kind?: string } })
        .source;
      if (source?.kind === "security-request") continue;
    } catch {
      continue;
    }
    (read ? expiredReadIds : expiredUnreadIds).push(row.id);
  }
  if (expiredReadIds.length || expiredUnreadIds.length) {
    const inputIds = boundTextArrayRows(db);
    const removed = await db
      .prepare(
        `DELETE FROM notification_deliveries
         WHERE ((read_at IS NOT NULL OR archived_at IS NOT NULL)
                 AND id IN (SELECT value FROM ${inputIds}))
            OR (read_at IS NULL AND archived_at IS NULL
                 AND id IN (SELECT value FROM ${inputIds}))`,
      )
      .bind(JSON.stringify(expiredReadIds), JSON.stringify(expiredUnreadIds))
      .run();
    report.cleanedDeliveries = removed.meta.changes ?? 0;
  }
  const lastDelivery = deliveries[deliveries.length - 1];
  report.cursor =
    deliveries.length === limit && lastDelivery
      ? encodeCursor(lastDelivery.created_at, lastDelivery.id)
      : null;
  const nextCursor = report.cursor ?? "";
  if (nextCursor !== savedCursor) {
    await db
      .prepare(
        `INSERT INTO notification_maintenance_checkpoints(name,cursor) VALUES ('retention-deliveries',?)
       ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor
       WHERE notification_maintenance_checkpoints.cursor=?`,
      )
      .bind(nextCursor, savedCursor)
      .run();
  }
  const removedEvents = await db
    .prepare(
      `DELETE FROM notification_events
       WHERE status IN ('completed','failed') AND id IN (
         SELECT e.id FROM notification_events e
         WHERE e.status IN ('completed','failed')
           AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.event_id=e.id)
           AND NOT EXISTS (SELECT 1 FROM notification_recipient_retries r WHERE r.event_id=e.id)
           AND NOT EXISTS (
             SELECT 1 FROM notification_admin_audit a
             LEFT JOIN notification_scope_settings s ON s.workspace_id=a.workspace_id
             WHERE e.scope_kind='workspace' AND a.workspace_id=e.scope_id
               AND a.id='audit_'||e.id AND a.action='send'
               AND e.created_at >= ? - COALESCE(s.read_days, ?) * CAST(? AS BIGINT)
           )
         ORDER BY e.created_at,e.id LIMIT ?
       )`,
    )
    .bind(now, notificationDefaults.readDays, dayMs, limit)
    .run();
  report.cleanedEvents = removedEvents.meta.changes ?? 0;
  return report;
}

export async function backfillWorkflowNotices(
  db: D1Database,
  after: string | null,
  limit = 100,
): Promise<{ backfilled: number; cursor: string | null }> {
  const resume = decodeTaskBackfillCursor(after);
  const tasks = (
    await db
      .prepare(
        `SELECT workspace_id,id,execution_id,node_id,title,assignee FROM workflow_tasks
         WHERE status!='done' ${resume ? "AND (id,workspace_id) > (?,?)" : ""}
         ORDER BY id,workspace_id LIMIT ?`,
      )
      .bind(...(resume ?? []), limit)
      .all<{
        workspace_id: string;
        id: string;
        execution_id: string;
        node_id: string;
        title: string;
        assignee: string;
      }>()
  ).results;
  let backfilled = 0;
  let cursor: string | null = after;
  for (const task of tasks) {
    cursor = JSON.stringify([task.id, task.workspace_id]);
    const existingNotice = db
      .prepare(
        `SELECT id FROM notification_events
         WHERE scope_kind='workspace' AND scope_id=? AND event_key IN (?,?)`,
      )
      .bind(
        task.workspace_id,
        workflowTaskNoticeKey(task.execution_id, task.node_id),
        `workflow:backfill:${task.id}`,
      );
    if (await existingNotice.first("id")) continue;
    try {
      await db.batch(
        workflowTaskNotice(
          db,
          task.workspace_id,
          task.execution_id,
          task.node_id,
          task.id,
          task.title,
          "",
          task.assignee,
          Date.now(),
        ),
      );
      backfilled += 1;
    } catch (error) {
      // Another backfill can create the same notice between the read and insert.
      if (!(await existingNotice.first("id"))) throw error;
    }
  }
  if (cursor && cursor !== after) {
    await db
      .prepare(
        `INSERT INTO notification_maintenance_checkpoints(name,cursor) VALUES ('backfill',?)
         ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor
         WHERE notification_maintenance_checkpoints.cursor=?`,
      )
      .bind(cursor, after ?? "")
      .run();
  }
  return { backfilled, cursor };
}

function decodeTaskBackfillCursor(
  after: string | null,
): [string, string] | null {
  if (!after?.startsWith("[")) return null;
  try {
    const [id, workspace] = JSON.parse(after);
    if (typeof id === "string" && typeof workspace === "string")
      return [id, workspace];
  } catch {
    // Rescan safely when the saved cursor predates workspace-aware pagination.
  }
  return null;
}

export async function notificationSettingsRoute(
  db: D1Database,
  principal: string,
  workspaceId: string,
  canManage: boolean,
  input?: unknown,
) {
  if (!canManage) return fail("Administrator permission required.", 403);
  if (input === undefined) return getRetentionSettings(db, workspaceId);
  return saveRetentionSettings(db, workspaceId, input);
}

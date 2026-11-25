import {
  inboxQuerySchema,
  noticeEventSchema,
  type InboxPage,
  type InboxQuery,
  type NoticeActionState,
  type NoticeEventInput,
  type NoticeScope,
  type NoticeView,
} from "@savia/studio-shared/notifications";
import { fail } from "../context";
import { dialectFor } from "@savia/db/dialect";
import {
  canonicalPayload,
  decodeCursor,
  encodeCursor,
  stableEventId,
  type DeliveryRow,
} from "./types";

function boundTextArrayRows(db: D1Database): string {
  return dialectFor(db).name === "postgres"
    ? "jsonb_array_elements_text(?::jsonb) AS input_ids(value)"
    : "json_each(?)";
}

export class NotificationRepository {
  constructor(private readonly db: D1Database) {}

  eventStatements(input: NoticeEventInput): D1PreparedStatement[] {
    const event = noticeEventSchema.parse(input);
    return [
      this.db
        .prepare(
          `INSERT INTO notification_events(id,scope_kind,scope_id,event_key,payload,created_at,expires_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(
          stableEventId(event),
          event.scope.kind,
          event.scope.id,
          event.key,
          canonicalPayload(event),
          event.createdAt,
          event.expiresAt,
        ),
    ];
  }

  async find(input: NoticeEventInput): Promise<{ id: string; payload: string } | null> {
    const event = noticeEventSchema.parse(input);
    const row = await this.db
      .prepare("SELECT id,payload FROM notification_events WHERE id=?")
      .bind(stableEventId(event))
      .first<{ id: string; payload: string }>();
    return row ?? null;
  }

  async accept(input: NoticeEventInput): Promise<{ id: string; duplicate: boolean }> {
    const event = noticeEventSchema.parse(input);
    const id = stableEventId(event);
    const payload = canonicalPayload(event);
    try {
      await this.db
        .prepare(
          `INSERT INTO notification_events(id,scope_kind,scope_id,event_key,payload,created_at,expires_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .bind(
          id,
          event.scope.kind,
          event.scope.id,
          event.key,
          payload,
          event.createdAt,
          event.expiresAt,
        )
        .run();
      return { id, duplicate: false };
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
      const existing = await this.db
        .prepare("SELECT payload FROM notification_events WHERE id=?")
        .bind(id)
        .first<string>("payload");
      if (existing === payload) return { id, duplicate: true };
      return fail("The event key already exists with different content.", 409);
    }
  }

  async list(
    principal: string,
    scopes: NoticeScope[],
    rawQuery: InboxQuery,
  ): Promise<InboxPage> {
    const query = inboxQuerySchema.parse(rawQuery ?? {});
    if (scopes.length === 0) return { items: [], nextCursor: null, cutoff: "" };
    let cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) return fail("Invalid inbox cursor.", 400);
    const scopeWhere = scopes
      .map(() => "(d.scope_kind=? AND d.scope_id=?)")
      .join(" OR ");
    const scopeArgs = scopes.flatMap(({ kind, id }) => [kind, id]);
    const unreadWhere = query.filter === "unread" ? "AND d.read_at IS NULL" : "";
    // Pending notices can be sparse, so read their candidates in larger batches.
    const batchSize = query.filter === "pending" ? 100 : query.limit + 1;
    const items: NoticeView[] = [];
    while (items.length <= query.limit) {
      const cursorWhere = cursor ? "AND (d.created_at, d.id) < (?, ?)" : "";
      const { results: rows } = await this.db
        .prepare(
          `SELECT d.id,d.event_id,d.scope_kind,d.scope_id,d.recipient_id,d.created_at,
                  d.read_at,d.archived_at,d.resolved_at,e.payload
           FROM notification_deliveries d
           JOIN notification_events e ON e.id=d.event_id
           WHERE d.recipient_id=? AND (${scopeWhere}) AND d.archived_at IS NULL
             ${unreadWhere} ${cursorWhere}
           ORDER BY d.created_at DESC, d.id DESC LIMIT ?`,
        )
        .bind(principal, ...scopeArgs, ...(cursor ?? []), batchSize)
        .all<DeliveryRow & { payload: string }>();
      for (const item of await this.inboxItems(rows)) {
        if (
          query.filter === "pending" &&
          (item.actionState !== "pending" ||
            (item.source.kind === "workflow-task" && item.readAt !== null))
        )
          continue;
        items.push(item);
        if (items.length > query.limit) break;
      }
      if (rows.length < batchSize) break;
      const last = rows[rows.length - 1]!;
      cursor = [last.created_at, last.id];
    }
    const hasMore = items.length > query.limit;
    if (hasMore) items.pop();
    const last = items[items.length - 1];
    const cutoff = last ? encodeCursor(last.createdAt, last.id) : "";
    return { items, nextCursor: hasMore ? cutoff : null, cutoff };
  }

  private async inboxItems(
    rows: Array<DeliveryRow & { payload: string }>,
  ): Promise<NoticeView[]> {
    const parsed: Array<{ row: DeliveryRow; event: NoticeEventInput }> = [];
    const taskIds = new Map<string, Set<string>>();
    for (const row of rows) {
      let event: NoticeEventInput;
      try {
        event = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object") continue;
      parsed.push({ row, event });
      if (
        row.scope_kind !== "workspace" ||
        event.source?.kind !== "workflow-task"
      )
        continue;
      const ids = taskIds.get(row.scope_id) ?? new Set<string>();
      ids.add(event.source.id);
      taskIds.set(row.scope_id, ids);
    }
    const taskStatuses = new Map(
      await Promise.all(
        [...taskIds].map(
          async ([workspaceId, ids]) =>
            [
              workspaceId,
              await this.readTaskStatuses(workspaceId, [...ids]),
            ] as const,
        ),
      ),
    );
    return parsed.map(({ row, event }) => ({
      id: row.id,
      scope: { kind: row.scope_kind, id: row.scope_id } as NoticeScope,
      title: event.title,
      body: event.body,
      createdAt: row.created_at,
      readAt: row.read_at,
      archivedAt: row.archived_at,
      source: event.source,
      actionState: this.resolveActionState(
        event,
        row.resolved_at,
        row.scope_kind === "workspace"
          ? taskStatuses.get(row.scope_id)
          : undefined,
      ),
    }));
  }

  async markRead(
    principal: string,
    scopes: NoticeScope[],
    id: string,
    read: boolean,
  ): Promise<void> {
    await this.updateDeliveryTimestamp(
      principal,
      scopes,
      id,
      "read_at",
      read ? Date.now() : null,
    );
  }

  async count(
    principal: string,
    scopes: NoticeScope[],
    rawQuery: { filter?: "all" | "unread" | "pending" },
  ): Promise<number> {
    const filter = rawQuery?.filter ?? "all";
    if (scopes.length === 0) return 0;
    const scopeWhere = scopes.map(() => "(d.scope_kind=? AND d.scope_id=?)").join(" OR ");
    const scopeArgs = scopes.flatMap((s) => [s.kind, s.id]);
    if (filter === "all") {
      return (
        await this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM notification_deliveries d
             WHERE d.recipient_id=? AND (${scopeWhere}) AND d.archived_at IS NULL`,
          )
          .bind(principal, ...scopeArgs)
          .first<number>("n")
      ) ?? 0;
    }
    if (filter === "unread") {
      return (
        await this.db
          .prepare(
            `SELECT COUNT(*) AS n FROM notification_deliveries d
             WHERE d.recipient_id=? AND (${scopeWhere}) AND d.read_at IS NULL AND d.archived_at IS NULL`,
          )
          .bind(principal, ...scopeArgs)
          .first<number>("n")
      ) ?? 0;
    }
    const postgres = dialectFor(this.db).name === "postgres";
    const sourceKind = postgres
      ? "e.payload::jsonb #>> '{source,kind}'"
      : "json_extract(e.payload,'$.source.kind')";
    const sourceId = postgres
      ? "e.payload::jsonb #>> '{source,id}'"
      : "json_extract(e.payload,'$.source.id')";
    const requiresAcknowledgement = postgres
      ? "(e.payload::jsonb -> 'requireAcknowledgement') = 'true'::jsonb"
      : "json_type(e.payload,'$.requireAcknowledgement')='true'";
    return (
      await this.db
        .prepare(
          `SELECT CAST(COUNT(*) AS INTEGER) AS n FROM notification_deliveries d
           JOIN notification_events e ON e.id=d.event_id
           LEFT JOIN workflow_tasks t ON d.scope_kind='workspace' AND t.workspace_id=d.scope_id
             AND (${sourceKind})='workflow-task' AND t.id=(${sourceId})
           WHERE d.recipient_id=? AND (${scopeWhere}) AND d.archived_at IS NULL
             AND ((d.read_at IS NULL AND t.status='open')
               OR ((${sourceKind})='admin-message' AND ${requiresAcknowledgement} AND d.resolved_at IS NULL))`,
        )
        .bind(principal, ...scopeArgs)
        .first<number>("n")
    ) ?? 0;
  }

  async markAllRead(
    principal: string,
    scopes: NoticeScope[],
    cutoff?: string,
  ): Promise<{ updated: number; nextCursor: string | null }> {
    const bound = cutoff ? decodeCursor(cutoff) : null;
    if (cutoff && !bound) return fail("Invalid inbox cursor.", 400);
    if (!scopes.length) return { updated: 0, nextCursor: null };
    const scopeWhere = scopes.map(() => "(d.scope_kind=? AND d.scope_id=?)").join(" OR ");
    const params: (string | number)[] = [principal, ...scopes.flatMap((scope) => [scope.kind, scope.id])];
    let andCutoff = "";
    if (bound) {
      andCutoff = "AND (d.created_at<? OR (d.created_at=? AND d.id<?))";
      params.push(bound[0], bound[0], bound[1]);
    }
    const ids = (
      await this.db
        .prepare(
          `SELECT d.id,d.created_at FROM notification_deliveries d
           WHERE d.recipient_id=? AND (${scopeWhere}) AND d.read_at IS NULL
             AND d.archived_at IS NULL ${andCutoff}
           ORDER BY d.created_at DESC,d.id DESC LIMIT 101`,
        )
        .bind(...params)
        .all<{ id: string; created_at: number }>()
    ).results;
    const page = ids.slice(0, 100);
    if (page.length === 0) return { updated: 0, nextCursor: null };
    const pageIds = boundTextArrayRows(this.db);
    const result = await this.db
      .prepare(`UPDATE notification_deliveries SET read_at=?
                WHERE read_at IS NULL AND archived_at IS NULL
                  AND id IN (SELECT value FROM ${pageIds})`)
      .bind(Date.now(), JSON.stringify(page.map(({ id }) => id)))
      .run();
    const last = page[page.length - 1];
    return {
      updated: result.meta.changes ?? 0,
      nextCursor:
        ids.length > 100 && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async follow(principal: string, workspaceId: string, collection: string): Promise<void> {
    if (!collection || collection.length > 200) return fail("Invalid collection.", 400);
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO notification_subscriptions(workspace_id,principal_id,collection,created_at)
         VALUES (?,?,?,?)`,
      )
      .bind(workspaceId, principal, collection, Date.now())
      .run();
  }

  async unfollow(principal: string, workspaceId: string, collection: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM notification_subscriptions WHERE workspace_id=? AND principal_id=? AND collection=?`,
      )
      .bind(workspaceId, principal, collection)
      .run();
  }

  async follows(principal: string, workspaceId: string): Promise<string[]> {
    return (
      await this.db
        .prepare(
          `SELECT collection FROM notification_subscriptions WHERE workspace_id=? AND principal_id=? ORDER BY collection`,
        )
        .bind(workspaceId, principal)
        .all<{ collection: string }>()
    ).results.map((row) => row.collection);
  }

  async archive(
    principal: string,
    scopes: NoticeScope[],
    id: string,
  ): Promise<void> {
    await this.updateDeliveryTimestamp(
      principal,
      scopes,
      id,
      "archived_at",
      Date.now(),
    );
  }

  private async updateDeliveryTimestamp(
    principal: string,
    scopes: NoticeScope[],
    id: string,
    column: "read_at" | "archived_at",
    stamp: number | null,
  ): Promise<void> {
    if (scopes.length === 0) return fail("Notification not found.", 404);
    const scopeWhere = scopes
      .map(() => "(scope_kind=? AND scope_id=?)")
      .join(" OR ");
    const result = await this.db
      .prepare(
        `UPDATE notification_deliveries SET ${column}=?
         WHERE id=? AND recipient_id=? AND (${scopeWhere})`,
      )
      .bind(
        stamp,
        id,
        principal,
        ...scopes.flatMap((scope) => [scope.kind, scope.id]),
      )
      .run();
    if (!result.meta.changes) return fail("Notification not found.", 404);
  }

  private async readTaskStatuses(
    workspaceId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    const rows = (
      await this.db
        .prepare(
          `SELECT id,status FROM workflow_tasks WHERE workspace_id=? AND id IN (SELECT value FROM ${boundTextArrayRows(this.db)})`,
        )
        .bind(workspaceId, JSON.stringify(ids))
        .all<{ id: string; status: string }>()
    ).results;
    return new Map(rows.map(({ id, status }) => [id, status]));
  }

  private resolveActionState(
    event: NoticeEventInput,
    resolvedAt: number | null,
    taskStatus: Map<string, string> | undefined,
  ): NoticeActionState {
    const { source } = event;
    if (source?.kind === "workflow-task") {
      const status = taskStatus?.get(source.id);
      if (status === undefined) return "unavailable";
      return status === "done" ? "done" : "pending";
    }
    if (
      source?.kind === "admin-message" &&
      event.requireAcknowledgement === true
    )
      return resolvedAt === null ? "pending" : "done";
    return "none";
  }
}

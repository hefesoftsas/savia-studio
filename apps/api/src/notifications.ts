import {
  notificationDefaults,
  type DispatchReport,
  type NoticeEventInput,
  type NoticeScope,
  type NotificationPolicy,
} from "@savia/studio-shared/notifications";
import { processNotifications } from "@savia/studio-server/notifications/dispatcher";
import { dialectFor } from "@savia/db/dialect";
import { maintainNotifications } from "@savia/studio-server/notifications/maintenance";
import type { RealtimeHubClient } from "./realtime/hub-client";
import { publishRealtime } from "./realtime/hub-client";
import { principalRoom } from "./realtime/protocol";
import { findPrincipal } from "./auth/identity-repository";
import type { AppActor } from "./auth/types";
import { loadActor } from "./auth/identity-repository";
import {
  canAccessSharedCrm,
  canManageSharedCrm,
} from "./external-crm/hubspot-access";

function pageAfter(ids: string[], after: string | null, limit: number) {
  ids.sort();
  const start = after === null ? 0 : ids.findIndex((id) => id > after);
  const page = start < 0 ? [] : ids.slice(start, start + limit);
  const last = page[page.length - 1];
  return {
    ids: page,
    nextCursor: last !== undefined && start + limit < ids.length ? last : null,
  };
}

async function readRecipientPage(
  statement: D1PreparedStatement,
  limit: number,
) {
  const { results } = await statement.all<{ principal_id: string }>();
  const ids = results.slice(0, limit).map(({ principal_id }) => principal_id);
  return {
    ids,
    nextCursor: results.length > limit ? (ids.at(-1) ?? null) : null,
  };
}

async function actorFor(
  db: D1Database,
  principal: string,
): Promise<AppActor | null> {
  const row = await findPrincipal(db, principal);
  if (!row || !row.isActive) return null;
  return loadActor(db, row);
}

function agencyId(tenant: string): number | null {
  const match = /^tenant:(\d+)$/.exec(tenant);
  return match ? Number(match[1]) : null;
}

export function createNotificationPolicy(db: D1Database): NotificationPolicy {
  // Principals have UUIDs. Use byte ordering explicitly so the SQL cursor
  // compares them the same way as the dispatcher on either database.
  const collation = dialectFor(db).name === "postgres" ? '"C"' : "BINARY";
  return {
    async recipients(event, after, limit) {
      if (event.audience.kind === "explicit") {
        return pageAfter([...new Set(event.audience.principals)], after, limit);
      }
      if (event.scope.kind === "account") return { ids: [], nextCursor: null };
      if (event.audience.kind === "workspace-members") {
        const tenantId = agencyId(event.scope.id);
        if (tenantId === null) return { ids: [], nextCursor: null };
        const principal = `m.principal_id COLLATE ${collation}`;
        const cursorWhere = after === null ? "" : `AND ${principal}>?`;
        return readRecipientPage(
          db
            .prepare(
              `SELECT m.principal_id FROM identity_tenant_membership m
               JOIN identity_principal p ON p.id=m.principal_id
               WHERE m.tenant_id=? AND m.is_active=1 AND p.is_active=1
                 ${cursorWhere}
               ORDER BY ${principal} LIMIT ?`,
            )
            .bind(tenantId, ...(after === null ? [] : [after]), limit + 1),
          limit,
        );
      }
      const principal = `principal_id COLLATE ${collation}`;
      const cursorWhere = after === null ? "" : `AND ${principal}>?`;
      return readRecipientPage(
        db
          .prepare(
            `SELECT principal_id FROM notification_subscriptions
             WHERE workspace_id=? AND collection=?
               ${cursorWhere}
             ORDER BY ${principal} LIMIT ?`,
          )
          .bind(
            event.scope.id,
            event.audience.collection,
            ...(after === null ? [] : [after]),
            limit + 1,
          ),
        limit,
      );
    },
    async canReadScope(principal, scope) {
      if (scope.kind === "account") {
        if (principal !== scope.id) return false;
        return Boolean((await findPrincipal(db, principal))?.isActive);
      }
      const actor = await actorFor(db, principal);
      return actor !== null && canAccessSharedCrm(actor, scope.id);
    },
    async canReadSource(principal, scope, source) {
      if (source.kind === "record") {
        const row = await db
          .prepare(
            "SELECT 1 AS ok FROM studio_objects WHERE tenant_id=? AND name=?",
          )
          .bind(scope.id, source.collection)
          .first<number>("ok");
        return row !== null;
      }
      if (source.kind === "workflow-task") {
        if (scope.kind !== "workspace") return false;
        const row = await db
          .prepare(
            "SELECT 1 AS ok FROM workflow_tasks WHERE workspace_id=? AND id=? AND assignee=?",
          )
          .bind(scope.id, source.id, principal)
          .first<number>("ok");
        return row !== null;
      }
      return true;
    },
    async canSend(principal, scope) {
      try {
        if (scope.kind === "account") return false;
        const actor = await actorFor(db, principal);
        return actor !== null && canManageSharedCrm(actor, scope.id);
      } catch {
        return false;
      }
    },
  };
}

export async function runScheduledNotifications(
  db: D1Database,
  realtime?: RealtimeHubClient,
): Promise<DispatchReport> {
  const startedAt = Date.now();
  const report = await processNotifications(
    db,
    createNotificationPolicy(db),
    {
      now: () => Date.now(),
      random: () => Math.random(),
      workerId: `scheduled-${startedAt}`,
      maxEvents: notificationDefaults.maxEvents,
      maxRecipients: notificationDefaults.maxRecipients,
      maxRecipientAttempts: notificationDefaults.maxRecipientAttempts,
      softBudgetMs: notificationDefaults.softBudgetMs,
      leaseMs: notificationDefaults.leaseMs,
    },
    {
      onDelivery(principalId) {
        publishRealtime(realtime, principalRoom(principalId), {
          topic: "notifications",
          type: "created",
          collection: "inbox",
        });
      },
      onEventStatus(principalId, eventId) {
        publishRealtime(realtime, principalRoom(principalId), {
          topic: "notifications",
          type: "updated",
          collection: "admin-status",
          id: eventId,
        });
      },
    },
  );
  const backlog = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM notification_events WHERE status='pending'",
    )
    .first<number>("n");
  console.info(
    JSON.stringify({
      event: "notification_dispatch",
      ...report,
      backlog: backlog ?? 0,
      durationMs: Date.now() - startedAt,
    }),
  );
  try {
    const maintenance = await maintainNotifications(db, Date.now(), 100);
    console.info(
      JSON.stringify({ event: "notification_maintenance", ...maintenance }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "notification_maintenance_failed",
        error: String(error),
      }),
    );
  }
  return report;
}

export type { NoticeEventInput, NoticeScope, NotificationPolicy };

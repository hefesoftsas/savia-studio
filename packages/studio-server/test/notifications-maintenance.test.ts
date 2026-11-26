import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import { makeConfig } from "@savia/studio-shared/metadata";
import { NotificationRepository } from "../src/notifications/repository";
import {
  backfillWorkflowNotices,
  getRetentionSettings,
  maintainNotifications,
  saveRetentionSettings,
} from "../src/notifications/maintenance";
import { WorkflowRepository } from "../src/workflows/repository";
import { notificationFixture } from "./notifications-fixture";

let fixture: Awaited<ReturnType<typeof notificationFixture>>;
const tenant = "domain:general";
const dayMs = 86_400_000;
const now = 400 * dayMs;

beforeAll(async () => {
  fixture = await notificationFixture();
  await fixture.db
    .prepare(
      "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,?,?)",
    )
    .bind(
      tenant,
      "requests",
      "Requests",
      JSON.stringify(
        makeConfig({ title: { type: "Textbox", label: "Title" } }),
      ),
    )
    .run();
});

afterAll(async () => {
  await fixture?.dispose();
});

beforeEach(async () => {
  await fixture.db.exec(
    "DELETE FROM notification_recipient_retries; DELETE FROM notification_deliveries; DELETE FROM notification_events; DELETE FROM notification_scope_settings; DELETE FROM notification_maintenance_checkpoints; DELETE FROM workflow_tasks;",
  );
});

async function seedDelivery(
  recipient: string,
  createdAt: number,
  readAt: number | null,
) {
  const repository = new NotificationRepository(fixture.db);
  const { id } = await repository.accept({
    scope: { kind: "workspace", id: tenant },
    key: `m-${recipient}-${createdAt}`,
    actor: { kind: "user", id: "admin" },
    source: { kind: "admin-message", id: `m-${createdAt}` },
    title: "Old",
    body: "",
    audience: { kind: "explicit", principals: [recipient] },
    createdAt,
    expiresAt: null,
  });
  await fixture.db
    .prepare(
      "INSERT INTO notification_deliveries(id,event_id,scope_kind,scope_id,recipient_id,created_at,read_at) VALUES (?,?,?,?,?,?,?)",
    )
    .bind(`dlv-${id}`, id, "workspace", tenant, recipient, createdAt, readAt)
    .run();
}

it("retains unread longer than read and protects open tasks", async () => {
  await saveRetentionSettings(fixture.db, tenant, {
    readDays: 90,
    unreadDays: 180,
  });
  expect(await getRetentionSettings(fixture.db, tenant)).toEqual({
    readDays: 90,
    unreadDays: 180,
  });
  await expect(
    saveRetentionSettings(fixture.db, tenant, { readDays: 90, unreadDays: 30 }),
  ).rejects.toThrow();
  await seedDelivery("alice", now - 100 * dayMs, now - 99 * dayMs);
  await seedDelivery("bob", now - 100 * dayMs, null);
  const report = await maintainNotifications(fixture.db, now, 100);
  expect(report.cleanedDeliveries).toBe(1);
  const remaining = (
    await fixture.db
      .prepare("SELECT recipient_id FROM notification_deliveries")
      .all<{
        recipient_id: string;
      }>()
  ).results;
  expect(remaining.map((row) => row.recipient_id)).toEqual(["bob"]);
});

it("preserves a delivery marked unread after the cleanup scan", async () => {
  await seedDelivery("alice", now - 100 * dayMs, now - 99 * dayMs);
  await seedDelivery("bob", now - 190 * dayMs, null);
  const db = new Proxy(fixture.db, {
    get(target, key, receiver) {
      if (key !== "prepare") return Reflect.get(target, key, receiver);
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!sql.includes("AS open_task")) return prepared;
        return {
          bind: (...values: unknown[]) => ({
            async all() {
              const result = await prepared.bind(...values).all();
              await target
                .prepare(
                  "UPDATE notification_deliveries SET read_at=NULL WHERE recipient_id='alice'",
                )
                .run();
              return result;
            },
          }),
        };
      };
    },
  });
  expect((await maintainNotifications(db, now, 100)).cleanedDeliveries).toBe(1);
  const remaining = await fixture.db
    .prepare("SELECT recipient_id,read_at FROM notification_deliveries")
    .all();
  expect(remaining.results).toEqual([{ recipient_id: "alice", read_at: null }]);
});

async function seedOpenTask(workspace: string) {
  await fixture.db.batch([
    fixture.db
      .prepare(
        "INSERT INTO workflows(workspace_id,id,name,definition,created_by) VALUES(?,'retention-flow','Retention','{}','owner')",
      )
      .bind(workspace),
    fixture.db
      .prepare(
        "INSERT INTO workflow_versions(workspace_id,id,workflow_id,definition,owner_id,revision) VALUES(?,'retention-version','retention-flow','{}','owner',1)",
      )
      .bind(workspace),
    fixture.db
      .prepare(
        "INSERT INTO workflow_executions(workspace_id,id,workflow_id,version_id,owner_id,initiator_id,event_key,context) VALUES(?,'retention-run','retention-flow','retention-version','owner','owner','notice','{}')",
      )
      .bind(workspace),
    fixture.db
      .prepare(
        "INSERT INTO workflow_tasks(workspace_id,id,execution_id,node_id,kind,title,assignee) VALUES(?,'shared-task','retention-run','task','task','Open task','alice')",
      )
      .bind(workspace),
  ]);
}

it("continues past protected deliveries and scopes open task protection to their workspace", async () => {
  const workspace = "domain:open-task";
  await seedOpenTask(workspace);
  await seedOpenTask("domain:unreferenced-task");
  const repo = new NotificationRepository(fixture.db);
  for (const [index, scope] of [workspace, tenant].entries()) {
    const createdAt = now - (190 - index) * dayMs;
    const { id } = await repo.accept({
      scope: { kind: "workspace", id: scope },
      key: "retention-task-notice",
      actor: { kind: "system", id: null },
      source: { kind: "workflow-task", id: "shared-task" },
      title: "Task notice",
      body: "",
      audience: { kind: "explicit", principals: ["alice"] },
      createdAt,
      expiresAt: null,
    });
    await fixture.db
      .prepare(
        "INSERT INTO notification_deliveries(id,event_id,scope_kind,scope_id,recipient_id,created_at) VALUES(?,?,'workspace',?,'alice',?)",
      )
      .bind(`delivery-${index}`, id, scope, createdAt)
      .run();
  }
  const taskReadSizes: number[] = [];
  const db = new Proxy(fixture.db, {
    get(target, key, receiver) {
      if (key !== "prepare") return Reflect.get(target, key, receiver);
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!sql.includes("workflow_tasks")) return prepared;
        const watch = (statement: D1PreparedStatement) => ({
          async all() {
            const result = await statement.all();
            taskReadSizes.push(result.results.length);
            return result;
          },
        });
        return {
          ...watch(prepared),
          bind: (...values: unknown[]) => watch(prepared.bind(...values)),
        };
      };
    },
  });
  expect((await maintainNotifications(db, now, 1)).cleanedDeliveries).toBe(0);
  expect(taskReadSizes).toEqual([1]);
  expect(
    (await maintainNotifications(fixture.db, now, 1)).cleanedDeliveries,
  ).toBe(1);
  const remaining = await fixture.db
    .prepare("SELECT id FROM notification_deliveries")
    .all();
  expect(remaining.results).toEqual([{ id: "delivery-0" }]);
});

it("cleans orphaned events even when earlier events have retry records", async () => {
  const repo = new NotificationRepository(fixture.db);
  const eventIds = [];
  for (const [index, status] of [
    "completed",
    "failed",
    "completed",
    "pending",
  ].entries()) {
    const { id } = await repo.accept({
      scope: { kind: "workspace", id: tenant },
      key: `retention-event-${index}`,
      actor: { kind: "user", id: "admin" },
      source: { kind: "admin-message", id: `retention-message-${index}` },
      title: "Retention notice",
      body: "",
      audience: { kind: "explicit", principals: ["alice"] },
      createdAt: now - (200 - index) * dayMs,
      expiresAt: null,
    });
    eventIds.push(id);
    await fixture.db
      .prepare("UPDATE notification_events SET status=? WHERE id=?")
      .bind(status, id)
      .run();
  }
  for (const [index, status] of ["failed", "pending"].entries()) {
    await fixture.db
      .prepare(
        "INSERT INTO notification_recipient_retries(event_id,recipient_id,next_retry,error,status) VALUES(?,'alice',?,'Delivery unavailable',?)",
      )
      .bind(eventIds[index], now, status)
      .run();
  }

  expect((await maintainNotifications(fixture.db, now, 1)).cleanedEvents).toBe(
    1,
  );
  const remainingEvents = await fixture.db
    .prepare("SELECT id FROM notification_events ORDER BY created_at")
    .all();
  expect(remainingEvents.results).toEqual(
    [eventIds[0], eventIds[1], eventIds[3]].map((id) => ({ id })),
  );
  const retries = await fixture.db
    .prepare("SELECT COUNT(*) AS total FROM notification_recipient_retries")
    .first<number>("total");
  expect(retries).toBe(2);
});

it("backfills open workflow tasks resumably without duplicating live capture", async () => {
  const repo = new WorkflowRepository(fixture.db, tenant);
  const draft = await repo.create(
    {
      name: "Backfill flow",
      definition: {
        trigger: { type: "manual", collection: "requests" },
        nodes: [
          { id: "t1", type: "task", title: "Open item", assignee: "alice" },
        ],
      },
    },
    "owner",
  );
  await repo.publish(draft.id, draft.revision, "owner");
  await repo.start(draft.id, {}, "owner", `backfill-${now}`);
  const { processWorkflows } = await import("../src/workflows/runtime");
  await processWorkflows(fixture.db, async () => true, { now });
  const live = await fixture.db
    .prepare("SELECT id FROM notification_events")
    .all();
  expect(live.results).toHaveLength(1);
  const first = await backfillWorkflowNotices(fixture.db, null, 100);
  expect(first.backfilled).toBe(0);
  expect(first.cursor).not.toBeNull();
  expect(
    (await fixture.db.prepare("SELECT id FROM notification_events").all())
      .results,
  ).toEqual(live.results);
  const second = await backfillWorkflowNotices(fixture.db, null, 100);
  expect(second.backfilled).toBe(0);
  const resumed = await backfillWorkflowNotices(fixture.db, first.cursor, 100);
  expect(resumed.backfilled).toBe(0);
  const checkpoint = await fixture.db
    .prepare(
      "SELECT cursor FROM notification_maintenance_checkpoints WHERE name='backfill'",
    )
    .bind()
    .first<{ cursor: string }>();
  expect(checkpoint?.cursor).toBe(first.cursor);
});

it("resumes a legacy checkpoint without skipping tasks that share an ID", async () => {
  const workspaces = ["domain:backfill-one", "domain:backfill-two"];
  for (const workspace of workspaces) await seedOpenTask(workspace);
  const repo = new NotificationRepository(fixture.db);
  await repo.accept({
    scope: { kind: "workspace", id: workspaces[0]! },
    key: "workflow:backfill:shared-task",
    actor: { kind: "system", id: null },
    source: { kind: "workflow-task", id: "shared-task" },
    title: "Open task",
    body: "",
    audience: { kind: "explicit", principals: ["alice"] },
    createdAt: now,
    expiresAt: null,
  });
  await fixture.db
    .prepare(
      "INSERT INTO notification_maintenance_checkpoints(name,cursor) VALUES ('backfill','shared-task')",
    )
    .run();

  const first = await backfillWorkflowNotices(fixture.db, "shared-task", 1);
  expect(first.backfilled).toBe(0);
  expect(first.cursor).not.toBe("shared-task");
  const second = await backfillWorkflowNotices(fixture.db, first.cursor, 1);
  expect(second.backfilled).toBe(1);
  const events = await fixture.db
    .prepare(
      "SELECT scope_id,event_key FROM notification_events ORDER BY scope_id",
    )
    .all();
  expect(events.results).toEqual([
    { scope_id: workspaces[0], event_key: "workflow:backfill:shared-task" },
    { scope_id: workspaces[1], event_key: "workflow:retention-run:task" },
  ]);
  const checkpoint = await fixture.db
    .prepare(
      "SELECT cursor FROM notification_maintenance_checkpoints WHERE name='backfill'",
    )
    .first<string>("cursor");
  expect(checkpoint).toBe(second.cursor);
});

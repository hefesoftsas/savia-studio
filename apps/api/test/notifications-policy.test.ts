import { env } from "cloudflare:workers";
import { processNotifications } from "@savia/studio-server/notifications/dispatcher";
import { NotificationRepository } from "@savia/studio-server/notifications/repository";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  grantMembership,
  setPlatformAdministrator,
  upsertPrincipal,
} from "../src/auth/identity-repository";
import { createNotificationPolicy } from "../src/notifications";

const dbMigrations = Object.entries(
  import.meta.glob<string>("../../../packages/db/migrations/*.sql", {
    eager: true,
    import: "default",
    query: "?raw",
  }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, sql]) => sql);

async function apply(sql: string) {
  for (const statement of sql
    .split("--> statement-breakpoint")
    .map((entry) =>
      entry
        .replace(/^--.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)) {
    await env.DB.exec(statement);
  }
}

let admin = "";
let member = "";
let outsider = "";

beforeAll(async () => {
  for (const sql of dbMigrations) await apply(sql);
  await env.DB.exec(
    "INSERT OR IGNORE INTO tenants (id, id_slug, name, is_active, created_at, updated_at) VALUES (9201, 'notice-tenant', 'Notice Tenant', 1, '2026-09-20', '2026-09-20')",
  );
  const make = async (email: string) =>
    (
      await upsertPrincipal(env.DB, {
        issuer: "test",
        subject: crypto.randomUUID(),
        email,
        displayName: email,
      })
    ).id;
  admin = await make("notice-admin@example.test");
  member = await make("notice-member@example.test");
  outsider = await make("notice-outsider@example.test");
  await setPlatformAdministrator(env.DB, admin, true);
  await grantMembership(env.DB, member, 9201, "viewer");
});

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM notification_recipient_retries; DELETE FROM notification_subscriptions; DELETE FROM notification_deliveries; DELETE FROM notification_events;",
  );
});

const workspace = { kind: "workspace", id: "tenant:9201" } as const;

describe("notification policy", () => {
  it("resolves explicit recipients through the dispatcher helper", async () => {
    const policy = createNotificationPolicy(env.DB);
    const event = {
      scope: workspace,
      key: "explicit",
      actor: { kind: "user", id: admin },
      source: { kind: "admin-message", id: "m1" },
      title: "Hello",
      body: "",
      audience: { kind: "explicit", principals: [member, outsider] },
      createdAt: 1000,
      expiresAt: null,
    } as const;
    // Explicit audiences are returned in sorted order for stable pagination.
    expect((await policy.recipients(event, null, 10)).ids).toEqual(
      [member, outsider].sort(),
    );
  });

  it("resolves workspace members and collection followers", async () => {
    const policy = createNotificationPolicy(env.DB);
    await env.DB.prepare(
      "INSERT INTO notification_subscriptions(workspace_id,principal_id,collection,created_at) VALUES (?,?,?,?)",
    )
      .bind(workspace.id, member, "requests", 1000)
      .run();
    const members = await policy.recipients(
      {
        scope: workspace,
        key: "members",
        actor: { kind: "system", id: null },
        source: { kind: "admin-message", id: "m2" },
        title: "Hi",
        body: "",
        audience: { kind: "workspace-members" },
        createdAt: 1000,
        expiresAt: null,
      },
      null,
      10,
    );
    expect(members.ids).toContain(member);
    expect(members.ids).not.toContain(outsider);
    const followers = await policy.recipients(
      {
        scope: workspace,
        key: "followers",
        actor: { kind: "system", id: null },
        source: {
          kind: "record",
          collection: "requests",
          id: "r1",
          operation: "updated",
        },
        title: "Changed",
        body: "",
        audience: { kind: "collection-followers", collection: "requests" },
        createdAt: 1000,
        expiresAt: null,
      },
      null,
      10,
    );
    expect(followers.ids).toEqual([member]);
  });

  it("reads only the requested follower page plus one continuation row", async () => {
    const principals = ["one", "two", "three", "four"];
    for (const principal of principals) {
      await env.DB.prepare(
        "INSERT INTO notification_subscriptions(workspace_id,principal_id,collection,created_at) VALUES (?,?,?,?)",
      )
        .bind(workspace.id, principal, "paginated-requests", 1000)
        .run();
    }
    const sizes: number[] = [];
    const db = new Proxy(env.DB, {
      get(target, key, receiver) {
        if (key !== "prepare") return Reflect.get(target, key, receiver);
        return (sql: string) => ({
          bind: (...values: unknown[]) => ({
            async all() {
              const result = await target
                .prepare(sql)
                .bind(...values)
                .all();
              sizes.push(result.results.length);
              return result;
            },
          }),
        });
      },
    });
    const policy = createNotificationPolicy(db);
    const event = {
      scope: workspace,
      key: "paged-followers",
      actor: { kind: "system", id: null },
      source: {
        kind: "record",
        collection: "paginated-requests",
        id: "record",
        operation: "updated",
      },
      title: "Changed",
      body: "",
      audience: {
        kind: "collection-followers",
        collection: "paginated-requests",
      },
      createdAt: 1000,
      expiresAt: null,
    } as const;
    const first = await policy.recipients(event, null, 2);
    expect(first).toEqual({ ids: ["four", "one"], nextCursor: "one" });
    expect(await policy.recipients(event, first.nextCursor, 2)).toEqual({
      ids: ["three", "two"],
      nextCursor: null,
    });
    expect(sizes).toEqual([3, 2]);
  });

  it("scopes reads and sends to membership and fails closed", async () => {
    const policy = createNotificationPolicy(env.DB);
    expect(await policy.canReadScope(member, workspace)).toBe(true);
    expect(await policy.canReadScope(outsider, workspace)).toBe(false);
    expect(await policy.canSend(admin, workspace)).toBe(true);
    expect(await policy.canSend(member, workspace)).toBe(false);
    expect(await policy.canSend(admin, { kind: "account", id: admin })).toBe(
      false,
    );
    expect(
      await policy.canReadSource(member, workspace, {
        kind: "record",
        collection: "missing-collection",
        id: "x",
        operation: "updated",
      }),
    ).toBe(false);
  });

  it.each(["identity_principal", "studio_objects"])(
    "retries delivery after a temporary %s lookup failure",
    async (table) => {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO studio_objects(tenant_id,name,label,config) VALUES (?,'retry-requests','Requests','{}')",
      )
        .bind(workspace.id)
        .run();
      let shouldFail = true;
      const db = new Proxy(env.DB, {
        get(target, key) {
          if (key === "prepare") {
            return (sql: string) => {
              if (shouldFail && sql.includes(table)) {
                shouldFail = false;
                throw new Error("Temporary lookup failure");
              }
              return target.prepare(sql);
            };
          }
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      let now = 1_000;
      const { id } = await new NotificationRepository(env.DB).accept({
        scope: workspace,
        key: "temporary-lookup-failure",
        actor: { kind: "system", id: null },
        source: {
          kind: "record",
          collection: "retry-requests",
          id: "request",
          operation: "updated",
        },
        title: "Updated request",
        body: "",
        audience: { kind: "explicit", principals: [member] },
        createdAt: now,
        expiresAt: null,
      });
      const policy = createNotificationPolicy(db);
      const options = { now: () => now, random: () => 0, workerId: "policy" };
      expect(await processNotifications(env.DB, policy, options)).toMatchObject(
        {
          retried: 1,
          delivered: 0,
          skipped: 0,
        },
      );
      expect(
        await env.DB.prepare(
          "SELECT recipient_id FROM notification_recipient_retries WHERE event_id=?",
        )
          .bind(id)
          .first("recipient_id"),
      ).toBe(member);
      now += 60_000;
      expect(await processNotifications(env.DB, policy, options)).toMatchObject(
        {
          delivered: 1,
        },
      );
    },
  );

  it("checks each recipient's identity once while enforcing workspace access", async () => {
    await new NotificationRepository(env.DB).accept({
      scope: workspace,
      key: "single-identity-read",
      actor: { kind: "system", id: null },
      source: { kind: "admin-message", id: "single-identity-read" },
      title: "Update",
      body: "",
      audience: { kind: "explicit", principals: [member, outsider] },
      createdAt: 1000,
      expiresAt: null,
    });
    let reads = 0;
    const db = new Proxy(env.DB, {
      get(target, key, receiver) {
        if (key !== "prepare") return Reflect.get(target, key, receiver);
        return (sql: string) => {
          if (sql.includes('from "identity_principal"')) reads += 1;
          return target.prepare(sql);
        };
      },
    });
    const report = await processNotifications(
      env.DB,
      createNotificationPolicy(db),
      { now: () => 1000, workerId: "identity-read-count" },
    );
    expect(report).toMatchObject({ delivered: 1, skipped: 1 });
    expect(reads).toBe(2);
    const { results } = await env.DB.prepare(
      "SELECT recipient_id FROM notification_deliveries",
    ).all();
    expect(results).toEqual([{ recipient_id: member }]);
  });

  it("delivers task notices only for tasks assigned to the recipient in the originating workspace", async () => {
    const foreign = "tenant:9202";
    for (const workspaceId of [workspace.id, foreign]) {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO workflows(workspace_id,id,name,definition,created_by) VALUES(?,'notice-flow','Notice','{}',?)",
        ).bind(workspaceId, admin),
        env.DB.prepare(
          "INSERT INTO workflow_versions(workspace_id,id,workflow_id,definition,owner_id,revision) VALUES(?,'notice-version','notice-flow','{}',?,1)",
        ).bind(workspaceId, admin),
        env.DB.prepare(
          "INSERT INTO workflow_executions(workspace_id,id,workflow_id,version_id,owner_id,initiator_id,event_key,context) VALUES(?,'notice-execution','notice-flow','notice-version',?,?,'notice','{}')",
        ).bind(workspaceId, admin, admin),
        env.DB.prepare(
          "INSERT INTO workflow_tasks(workspace_id,id,execution_id,node_id,kind,title,assignee) VALUES(?,?,'notice-execution','task','task','Task',?)",
        ).bind(
          workspaceId,
          workspaceId === foreign ? "foreign-task" : "local-task",
          member,
        ),
      ]);
    }
    const policy = createNotificationPolicy(env.DB);
    const task = { kind: "workflow-task", id: "local-task" } as const;
    expect(await policy.canReadSource(member, workspace, task)).toBe(true);
    expect(await policy.canReadSource(admin, workspace, task)).toBe(false);
    expect(
      await policy.canReadSource(member, workspace, {
        ...task,
        id: "foreign-task",
      }),
    ).toBe(false);
    expect(
      await policy.canReadSource(member, { kind: "account", id: member }, task),
    ).toBe(false);
  });
});

import { beforeAll, afterAll, it, expect } from "vitest";
import { Hono } from "hono";
import type {
  InboxPage,
  NoticeEventInput,
  NotificationPolicy,
} from "@savia/studio-shared/notifications";
import { NotificationRepository } from "../src/notifications/repository";
import { processNotifications } from "../src/notifications/dispatcher";
import { registerNotifications } from "../src/notifications/routes";
import { notificationFixture } from "./notifications-fixture";

let fixture: Awaited<ReturnType<typeof notificationFixture>>;
const scope = { kind: "workspace", id: "domain:general" } as const;

const policy: NotificationPolicy = {
  async recipients(event, after, limit) {
    if (event.audience.kind !== "explicit")
      return { ids: [], nextCursor: null };
    return { ids: event.audience.principals.slice(0, limit), nextCursor: null };
  },
  async canReadScope() {
    return true;
  },
  async canReadSource() {
    return true;
  },
  async canSend(principal) {
    return principal !== "workspace-member";
  },
};

function appFor(
  principal: string,
  db = fixture.db,
  workspace: string = scope.id,
) {
  const app = new Hono<{
    Variables: { tenant: string; principalId: string };
  }>();
  app.use(async (c, next) => {
    c.set("tenant", workspace);
    c.set("principalId", principal);
    await next();
  });
  registerNotifications(app as never, { policy });
  const call = (path: string, init?: RequestInit) =>
    app.request(path, init, { DB: db } as never);
  return { request: call };
}

async function seed(
  noticeScope: NoticeEventInput["scope"] = scope,
  principal = "alice",
  source: NoticeEventInput["source"] = { kind: "admin-message", id: "m1" },
): Promise<string> {
  const repository = new NotificationRepository(fixture.db);
  const input: NoticeEventInput = {
    scope: noticeScope,
    key: `route-${crypto.randomUUID()}`,
    actor: { kind: "user", id: "admin" },
    source,
    title: "Hello",
    body: "World",
    audience: { kind: "explicit", principals: [principal] },
    createdAt: Date.now(),
    expiresAt: null,
  };
  const { id } = await repository.accept(input);
  await fixture.db
    .prepare(
      "INSERT INTO notification_deliveries(id,event_id,scope_kind,scope_id,recipient_id,created_at) VALUES (?,?,?,?,?,?)",
    )
    .bind(
      `dlv-${id}`,
      id,
      noticeScope.kind,
      noticeScope.id,
      principal,
      Date.now(),
    )
    .run();
  return `dlv-${id}`;
}

beforeAll(async () => {
  fixture = await notificationFixture();
});

it("authorizes status and retry for administrator notices in the current workspace", async () => {
  const admin = appFor("notice-sender");
  const sent = await admin.request("/api/notifications/admin/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scope,
      key: "scope-test",
      title: "Current workspace notice",
      audience: { kind: "explicit", principals: ["status-test-recipient"] },
    }),
  });
  expect(sent.status).toBe(200);
  const { data } = await sent.json<{ data: { eventId: string } }>();
  const eventPath = `/api/notifications/admin/${data.eventId}`;
  const member = appFor("workspace-member");
  expect((await member.request(`${eventPath}/status`)).status).toBe(403);
  expect(
    (await member.request(`${eventPath}/retry`, { method: "POST" })).status,
  ).toBe(403);

  const otherAdmin = appFor("other-admin", fixture.db, "domain:other");
  expect((await otherAdmin.request(`${eventPath}/status`)).status).toBe(404);
  expect(
    (await otherAdmin.request(`${eventPath}/retry`, { method: "POST" })).status,
  ).toBe(404);
  expect((await admin.request(`${eventPath}/status`)).status).toBe(200);
  expect(
    (await admin.request(`${eventPath}/retry`, { method: "POST" })).status,
  ).toBe(200);
  const taskNotice = await seed(scope, "status-test-recipient", {
    kind: "workflow-task",
    id: "test-task",
  });
  const taskEventPath = `/api/notifications/admin/${taskNotice.slice("dlv-".length)}`;
  expect((await admin.request(`${taskEventPath}/status`)).status).toBe(404);
  expect(
    (await admin.request(`${taskEventPath}/retry`, { method: "POST" })).status,
  ).toBe(404);
  expect(
    await fixture.db
      .prepare(
        "SELECT workspace_id FROM notification_admin_audit WHERE event_id=? AND action='retry'",
      )
      .bind(data.eventId)
      .first("workspace_id"),
  ).toBe(scope.id);
});

it("keeps requested acknowledgements pending after reading and archiving", async () => {
  const principal = "notice-recipient";
  const admin = appFor("notice-admin");
  for (const requireAcknowledgement of [false, true]) {
    const response = await admin.request("/api/notifications/admin/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scope,
        key: `ack-${requireAcknowledgement}`,
        title: requireAcknowledgement ? "Please confirm" : "For information",
        audience: { kind: "explicit", principals: [principal] },
        requireAcknowledgement,
      }),
    });
    expect(response.status).toBe(200);
  }
  await processNotifications(fixture.db, policy, { workerId: "ack-test" });
  const app = appFor(principal);
  const readInbox = async (filter: string) => {
    const response = await app.request(`/api/notifications?filter=${filter}`);
    expect(response.status).toBe(200);
    return (await response.json<{ data: InboxPage }>()).data.items;
  };
  const items = await readInbox("all");
  expect(items).toHaveLength(2);
  const ordinary = items.find(({ title }) => title === "For information")!;
  const acknowledgement = items.find(
    ({ title }) => title === "Please confirm",
  )!;
  expect(ordinary.actionState).toBe("none");
  expect(acknowledgement.actionState).toBe("pending");

  const read = await app.request(
    `/api/notifications/${acknowledgement.id}/read`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ read: true }),
    },
  );
  expect(read.status).toBe(200);
  expect((await readInbox("pending")).map(({ id }) => id)).toEqual([
    acknowledgement.id,
  ]);
  const count = () => app.request("/api/notifications/count?filter=pending");
  expect(await (await count()).json()).toEqual({ data: { count: 1 } });

  const archive = await app.request(
    `/api/notifications/${acknowledgement.id}/archive`,
    { method: "POST" },
  );
  expect(archive.status).toBe(200);
  expect((await readInbox("all")).map(({ id }) => id)).toEqual([ordinary.id]);
  expect((await readInbox("pending")).map(({ id }) => id)).toEqual([
    acknowledgement.id,
  ]);
  expect(await (await count()).json()).toEqual({ data: { count: 1 } });

  const confirm = (id: string) =>
    app.request(`/api/notifications/${id}/resolve`, { method: "POST" });
  expect((await confirm(ordinary.id)).status).toBe(409);
  expect((await confirm(acknowledgement.id)).status).toBe(200);
  expect((await confirm(acknowledgement.id)).status).toBe(200);
  expect(await readInbox("pending")).toEqual([]);
  expect(await (await count()).json()).toEqual({ data: { count: 0 } });
  expect((await readInbox("all")).map(({ id }) => id)).toEqual([ordinary.id]);
});

it("uses only the notice workspace for task status, counts, and actions", async () => {
  const principal = "scoped-task-reader";
  const other = "domain:foreign-tasks";
  for (const workspace of [other, scope.id]) {
    const taskIds = ["shared-open", "shared-done"];
    if (workspace === other) taskIds.push("foreign-only");
    await fixture.db.batch([
      fixture.db
        .prepare(
          "INSERT INTO workflows(workspace_id,id,name,definition,created_by) VALUES(?,'inbox-workflow','Inbox','{}',?)",
        )
        .bind(workspace, principal),
      fixture.db
        .prepare(
          "INSERT INTO workflow_versions(workspace_id,id,workflow_id,definition,owner_id,revision) VALUES(?,'inbox-version','inbox-workflow','{}',?,1)",
        )
        .bind(workspace, principal),
      fixture.db
        .prepare(
          "INSERT INTO workflow_executions(workspace_id,id,workflow_id,version_id,owner_id,initiator_id,event_key,context) VALUES(?,'inbox-execution','inbox-workflow','inbox-version',?,?,'inbox','{}')",
        )
        .bind(workspace, principal, principal),
      ...taskIds.map((id) =>
        fixture.db
          .prepare(
            "INSERT INTO workflow_tasks(workspace_id,id,execution_id,node_id,kind,title,assignee,status) VALUES(?,?,'inbox-execution',?,'task','Inbox task',?,?)",
          )
          .bind(
            workspace,
            id,
            id,
            principal,
            workspace === scope.id && id === "shared-done" ? "done" : "open",
          ),
      ),
    ]);
  }
  const doneId = await seed(scope, principal, {
    kind: "workflow-task",
    id: "shared-done",
  });
  const openId = await seed(scope, principal, {
    kind: "workflow-task",
    id: "shared-open",
  });
  const missingId = await seed(scope, principal, {
    kind: "workflow-task",
    id: "foreign-only",
  });
  const app = appFor(principal);

  const count = await app.request("/api/notifications/count?filter=pending");
  expect(await count.json()).toEqual({ data: { count: 1 } });
  const pending = await app.request("/api/notifications?filter=pending");
  const { data } = await pending.json<{ data: InboxPage }>();
  expect(data.items.map(({ source }) => source.id)).toEqual(["shared-open"]);
  const all = await app.request("/api/notifications");
  const inbox = await all.json<{ data: InboxPage }>();
  const actionStates = new Map(
    inbox.data.items.map(({ id, actionState }) => [id, actionState]),
  );
  expect(actionStates.get(doneId)).toBe("done");
  expect(actionStates.get(missingId)).toBe("unavailable");
  const action = await app.request(`/api/notifications/action/${missingId}`);
  expect(await action.json()).toEqual({
    data: { kind: "task", state: "unavailable", resolved: false },
  });

  const complete = (id: string) =>
    app.request(`/api/notifications/${id}/resolve`, { method: "POST" });
  const reassign = (assignee: string) =>
    fixture.db
      .prepare(
        "UPDATE workflow_tasks SET assignee=? WHERE workspace_id=? AND id='shared-open'",
      )
      .bind(assignee, scope.id)
      .run();
  await reassign("new-assignee");
  const reassignedInbox = await app.request("/api/notifications");
  const reassignedItems = (await reassignedInbox.json<{ data: InboxPage }>())
    .data.items;
  expect(reassignedItems.find(({ id }) => id === openId)?.actionState).toBe(
    "unavailable",
  );
  expect(
    (
      await (
        await app.request("/api/notifications?filter=pending")
      ).json<{ data: InboxPage }>()
    ).data.items,
  ).toEqual([]);
  expect(
    await (await app.request("/api/notifications/count?filter=pending")).json(),
  ).toEqual({ data: { count: 0 } });
  expect((await complete(openId)).status).toBe(404);
  await reassign(principal);
  for (let index = 0; index < 101; index++) {
    await seed(scope, principal);
  }
  const sparse = await app.request("/api/notifications?filter=pending&limit=1");
  const pendingPage = await sparse.json<{ data: InboxPage }>();
  expect(pendingPage.data.items.map(({ source }) => source.id)).toEqual([
    "shared-open",
  ]);
  expect(pendingPage.data.nextCursor).toBeNull();

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await complete(openId);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { resolved: true } });
  }
  expect((await complete(missingId)).status).toBe(409);
  const completed = await app.request(`/api/notifications/action/${openId}`);
  expect(await completed.json()).toEqual({
    data: { kind: "task", state: "done", resolved: true },
  });
});

it("opens and pages an inbox with more than 100 distinct task notices", async () => {
  const principal = "task-inbox-reader";
  for (let index = 0; index < 101; index++) {
    await seed(scope, principal, {
      kind: "workflow-task",
      id: `task-${index}`,
    });
  }
  const returnedRows: number[] = [];
  const db = new Proxy(fixture.db, {
    get(target, key, receiver) {
      if (key !== "prepare") return Reflect.get(target, key, receiver);
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!sql.includes("ORDER BY d.created_at DESC, d.id DESC"))
          return prepared;
        return {
          bind: (...values: unknown[]) => ({
            async all() {
              const result = await prepared.bind(...values).all();
              returnedRows.push(result.results.length);
              return result;
            },
          }),
        };
      };
    },
  });
  const app = appFor(principal, db);
  const first = await app.request("/api/notifications?limit=30");
  expect(first.status).toBe(200);
  const { data } = await first.json<{ data: InboxPage }>();
  expect(data.items).toHaveLength(30);
  expect(returnedRows).toEqual([31]);
  expect(
    data.items.every(({ actionState }) => actionState === "unavailable"),
  ).toBe(true);
  expect(data.nextCursor).toBeTruthy();

  const query = new URLSearchParams({ limit: "71", cursor: data.nextCursor! });
  const second = await app.request(`/api/notifications?${query}`);
  expect(second.status).toBe(200);
  const next = await second.json<{ data: InboxPage }>();
  expect(next.data.items).toHaveLength(71);
  expect(returnedRows).toEqual([31, 71]);
  expect(
    new Set([...data.items, ...next.data.items].map(({ id }) => id)).size,
  ).toBe(101);
  expect(next.data.nextCursor).toBeNull();
});

it("keeps incomplete notices safe to display and archive", async () => {
  const principal = "incomplete-notice-reader";
  const damaged = await seed(scope, principal);
  const valid = await seed(scope, principal);
  await fixture.db
    .prepare(
      "UPDATE notification_events SET payload='{}' WHERE id=(SELECT event_id FROM notification_deliveries WHERE id=?)",
    )
    .bind(damaged)
    .run();
  const app = appFor(principal);
  const response = await app.request("/api/notifications?filter=unread");
  expect(response.status).toBe(200);
  const { data } = await response.json<{ data: InboxPage }>();
  expect(data.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: valid, title: "Hello" }),
      expect.objectContaining({
        id: damaged,
        source: { kind: "unavailable" },
        actionState: "unavailable",
      }),
    ]),
  );
  const archive = await app.request(`/api/notifications/${damaged}/archive`, {
    method: "POST",
  });
  expect(archive.status).toBe(200);
  const count = await app.request("/api/notifications/count?filter=unread");
  expect(await count.json()).toEqual({ data: { count: 1 } });
});

it("paginates deliveries with Unicode IDs and accepts older Latin-1 cursors", async () => {
  const principal = "unicode-recipient";
  const deliveries = [
    { id: "aviso-á", at: 100 },
    { id: "aviso-例-📝", at: 200 },
    { id: "aviso-nuevo", at: 300 },
  ];
  for (const delivery of deliveries) {
    const id = await seed(scope, principal);
    await fixture.db
      .prepare(
        "UPDATE notification_deliveries SET id=?,created_at=? WHERE id=?",
      )
      .bind(delivery.id, delivery.at, id)
      .run();
  }
  const app = appFor(principal);
  const list = async (cursor: string) => {
    const response = await app.request(
      `/api/notifications?limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(200);
    return (await response.json<{ data: InboxPage }>()).data;
  };
  const previous = btoa(JSON.stringify([300, "aviso-nuevo"]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  const page = await list(previous);
  expect(page.items.map(({ id }) => id)).toEqual(["aviso-例-📝"]);
  const next = await list(page.nextCursor!);
  expect(next.items.map(({ id }) => id)).toEqual(["aviso-á"]);
  expect(next.nextCursor).toBeNull();
  const legacyLatin1 = btoa(JSON.stringify([100, "aviso-á"]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  expect((await list(legacyLatin1)).items).toEqual([]);
});

it("rejects invalid cursor contents in both inbox reads and bulk updates", async () => {
  const principal = "invalid-cursor-user";
  const id = await seed(scope, principal);
  const app = appFor(principal);
  for (const payload of [
    '[1e999,"delivery"]',
    '[1.5,"delivery"]',
    '[9007199254740992,"delivery"]',
    '[1,""]',
    '[1,"delivery","extra"]',
  ]) {
    const cursor = btoa(payload);
    const inbox = await app.request(
      `/api/notifications?cursor=${encodeURIComponent(cursor)}`,
    );
    expect(inbox.status, payload).toBe(400);
    const readAll = await app.request("/api/notifications/read-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor }),
    });
    expect(readAll.status, payload).toBe(400);
  }
  expect(
    await fixture.db
      .prepare("SELECT read_at FROM notification_deliveries WHERE id=?")
      .bind(id)
      .first("read_at"),
  ).toBeNull();
});

it("rejects invalid read-all bodies without changing the inbox", async () => {
  const principal = "invalid-read-all";
  const id = await seed(scope, principal);
  const app = appFor(principal);
  for (const body of ['{"cursor":', '{"cursor":42}']) {
    const response = await app.request("/api/notifications/read-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(400);
  }
  expect(
    await fixture.db
      .prepare("SELECT read_at FROM notification_deliveries WHERE id=?")
      .bind(id)
      .first("read_at"),
  ).toBeNull();
  const response = await app.request("/api/notifications/read-all", {
    method: "POST",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { updated: 1, nextCursor: null },
  });
});

it("marks both account and workspace notifications in the current inbox", async () => {
  const workspaceId = await seed();
  const accountId = await seed({ kind: "account", id: "alice" });
  const otherWorkspaceId = await seed({
    kind: "workspace",
    id: "domain:other",
  });
  const otherAccountId = await seed({ kind: "account", id: "bob" }, "bob");

  const response = await appFor("alice").request(
    "/api/notifications/read-all",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { updated: 2, nextCursor: null },
  });
  const readAt = (id: string) =>
    fixture.db
      .prepare("SELECT read_at FROM notification_deliveries WHERE id=?")
      .bind(id)
      .first<number>("read_at");
  expect(await readAt(workspaceId)).toBeGreaterThan(0);
  expect(await readAt(accountId)).toBeGreaterThan(0);
  expect(await readAt(otherWorkspaceId)).toBeNull();
  expect(await readAt(otherAccountId)).toBeNull();
});

it("resumes a full bulk-read page without skipping the last unread notice", async () => {
  const principal = "bulk-reader";
  const account = { kind: "account", id: principal } as const;
  for (let index = 0; index < 101; index++) {
    await seed(index % 2 === 0 ? scope : account, principal);
  }
  const app = appFor(principal);
  const readPage = async (cursor?: string) => {
    const response = await app.request("/api/notifications/read-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor }),
    });
    expect(response.status).toBe(200);
    return response.json<{
      data: { updated: number; nextCursor: string | null };
    }>();
  };
  const { data: first } = await readPage();
  expect(first.updated).toBe(100);
  expect(first.nextCursor).toBeTruthy();
  expect(await readPage(first.nextCursor!)).toEqual({
    data: { updated: 1, nextCursor: null },
  });
  expect(await readPage()).toEqual({ data: { updated: 0, nextCursor: null } });
});

afterAll(async () => {
  await fixture?.dispose();
});

it("serves the personal inbox and blocks cross-principal mutations", async () => {
  const deliveryId = await seed();
  const alice = appFor("alice");
  const list = await alice.request("/api/notifications");
  expect(list.status).toBe(200);
  const body = (await list.json()) as {
    data: { items: { id: string; title: string }[] };
  };
  expect(body.data.items.map((item) => item.id)).toContain(deliveryId);
  expect(body.data.items[0].title).toBe("Hello");

  const count = (await (
    await alice.request("/api/notifications/count?filter=unread")
  ).json()) as { data: { count: number } };
  expect(count.data.count).toBeGreaterThanOrEqual(1);

  const read = await alice.request(`/api/notifications/${deliveryId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read: true }),
  });
  expect(read.status).toBe(200);

  const bob = appFor("bob");
  const foreign = await bob.request(`/api/notifications/${deliveryId}/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ read: true }),
  });
  expect(foreign.status).toBe(404);

  const otherWorkspaceNotice = await seed({
    kind: "workspace",
    id: "domain:other",
  });
  const foreignArchive = await alice.request(
    `/api/notifications/${otherWorkspaceNotice}/archive`,
    { method: "POST" },
  );
  expect(foreignArchive.status).toBe(404);
});

it("manages follows and paginates bulk reads", async () => {
  await fixture.db
    .prepare(
      "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,'requests','Requests','{}')",
    )
    .bind(scope.id)
    .run();
  const alice = appFor("alice");
  const follow = () =>
    alice.request("/api/notifications/follow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection: "requests" }),
    });
  expect((await follow()).status).toBe(200);
  expect((await follow()).status).toBe(200);
  const follows = (await (
    await alice.request("/api/notifications/follows")
  ).json()) as {
    data: string[];
  };
  expect(follows.data).toContain("requests");
  const unfollow = await alice.request("/api/notifications/follow/requests", {
    method: "DELETE",
  });
  expect(unfollow.status).toBe(200);

  const readAll = (await (
    await alice.request("/api/notifications/read-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    })
  ).json()) as { data: { updated: number; nextCursor: string | null } };
  expect(readAll.data.updated).toBeGreaterThanOrEqual(0);
});

it("rejects follow requests for missing collections and hides old follows after deletion", async () => {
  const collection = "deleted-requests";
  const foreign = "domain:foreign-follows";
  const principal = "retired-collection-follower";
  const create = (workspace: string) =>
    fixture.db
      .prepare(
        "INSERT INTO studio_objects(tenant_id,name,label,config) VALUES (?,?,'Requests','{}')",
      )
      .bind(workspace, collection)
      .run();
  await create(foreign);
  await new NotificationRepository(fixture.db).follow(
    principal,
    foreign,
    collection,
  );
  const app = appFor(principal);
  const follow = () =>
    app.request("/api/notifications/follow", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ collection }),
    });
  expect((await follow()).status).toBe(404);
  await create(scope.id);
  expect((await follow()).status).toBe(200);
  await fixture.db
    .prepare("DELETE FROM studio_objects WHERE tenant_id=? AND name=?")
    .bind(scope.id, collection)
    .run();
  expect((await follow()).status).toBe(404);
  const follows = await app.request("/api/notifications/follows");
  expect(await follows.json()).toEqual({ data: [] });
  expect(
    await new NotificationRepository(fixture.db).follows(principal, foreign),
  ).toEqual([collection]);
  await create(scope.id);
  expect(
    await (await app.request("/api/notifications/follows")).json(),
  ).toEqual({
    data: [],
  });
  expect((await follow()).status).toBe(200);
});

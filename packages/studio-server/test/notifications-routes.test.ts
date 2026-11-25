import { beforeAll, afterAll, it, expect } from "vitest";
import { Hono } from "hono";
import type {
  NoticeEventInput,
  NotificationPolicy,
} from "@savia/studio-shared/notifications";
import { NotificationRepository } from "../src/notifications/repository";
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
  async canSend() {
    return true;
  },
};

function appFor(principal: string) {
  const app = new Hono<{
    Variables: { tenant: string; principalId: string };
  }>();
  app.use(async (c, next) => {
    c.set("tenant", scope.id);
    c.set("principalId", principal);
    await next();
  });
  registerNotifications(app as never, { policy });
  const call = (path: string, init?: RequestInit) =>
    app.request(path, init, { DB: fixture.db } as never);
  return { request: call };
}

async function seed(
  noticeScope: NoticeEventInput["scope"] = scope,
  principal = "alice",
): Promise<string> {
  const repository = new NotificationRepository(fixture.db);
  const input: NoticeEventInput = {
    scope: noticeScope,
    key: `route-${crypto.randomUUID()}`,
    actor: { kind: "user", id: "admin" },
    source: { kind: "admin-message", id: "m1" },
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
  const alice = appFor("alice");
  const follow = await alice.request("/api/notifications/follow", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collection: "requests" }),
  });
  expect(follow.status).toBe(200);
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

import { beforeAll, afterAll, it, expect } from "vitest";
import type { NotificationPolicy } from "@savia/studio-shared/notifications";
import {
  sendAdminNotice,
  adminEventStatus,
  retryAdminEvent,
} from "../src/notifications/admin";
import { processNotifications } from "../src/notifications/dispatcher";
import { maintainNotifications } from "../src/notifications/maintenance";
import { notificationFixture } from "./notifications-fixture";

let fixture: Awaited<ReturnType<typeof notificationFixture>>;
const scope = { kind: "workspace", id: "domain:general" } as const;
let now = 3_000_000;

const managers = new Set(["admin"]);
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
    return managers.has(principal);
  },
};

function payload(title = "Maintenance") {
  return {
    title,
    body: "Window at midnight",
    audience: { kind: "explicit", principals: ["alice", "bob"] },
    requireAcknowledgement: false,
  } as const;
}

beforeAll(async () => {
  fixture = await notificationFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

it("accepts admin notices idempotently and rejects unauthorized senders", async () => {
  const first = await sendAdminNotice(
    fixture.db,
    policy,
    "admin",
    scope,
    "window-1",
    payload(),
    now,
  );
  expect(first.status).toBe("accepted");
  expect(first.duplicate).toBe(false);
  const second = await sendAdminNotice(
    fixture.db,
    policy,
    "admin",
    scope,
    "window-1",
    payload(),
    now + 61_000,
  );
  expect(second.duplicate).toBe(true);
  expect(second.eventId).toBe(first.eventId);
  await expect(
    sendAdminNotice(
      fixture.db,
      policy,
      "admin",
      scope,
      "window-1",
      payload("Changed"),
      now,
    ),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    sendAdminNotice(
      fixture.db,
      policy,
      "mallory",
      scope,
      "window-2",
      payload(),
      now,
    ),
  ).rejects.toMatchObject({ status: 403 });
});

it("accepts and deduplicates an administrator key at the API length limit", async () => {
  const workspace = {
    kind: "workspace",
    id: "domain:long-notice-key",
  } as const;
  const key = "x".repeat(200);
  const send = (title: string, sentAt: number) =>
    sendAdminNotice(
      fixture.db,
      policy,
      "admin",
      workspace,
      key,
      payload(title),
      sentAt,
    );
  const first = await send("Long key", now);
  expect(first).toMatchObject({ status: "accepted", duplicate: false });
  expect(await send("Long key", now + 1)).toEqual({
    ...first,
    duplicate: true,
  });
  await expect(send("Changed title", now + 2)).rejects.toMatchObject({
    status: 409,
  });
});

it("keeps zero-delivery administrator status during retention", async () => {
  const workspace = { kind: "workspace", id: "domain:no-deliveries" } as const;
  const send = (sentAt: number) =>
    sendAdminNotice(
      fixture.db,
      policy,
      "admin",
      workspace,
      "zero-deliveries",
      payload(),
      sentAt,
    );
  const { eventId } = await send(now);
  await processNotifications(
    fixture.db,
    {
      ...policy,
      async canReadScope(_principal, candidate) {
        return candidate.id !== workspace.id;
      },
    },
    { now: () => now, workerId: "no-deliveries" },
  );
  await maintainNotifications(fixture.db, now);
  expect(
    await adminEventStatus(fixture.db, policy, "admin", workspace.id, eventId),
  ).toMatchObject({ status: "completed", delivered: 0 });
  expect(await send(now + 1)).toMatchObject({ eventId, duplicate: true });

  const afterRetention = now + 91 * 86_400_000;
  await maintainNotifications(fixture.db, afterRetention);
  await expect(
    adminEventStatus(fixture.db, policy, "admin", workspace.id, eventId),
  ).rejects.toMatchObject({ status: 404 });
  await expect(send(afterRetention)).rejects.toMatchObject({
    status: 409,
    message:
      "This message key belongs to a notice whose retention period ended.",
  });
});

it("enforces the per-minute send quota", async () => {
  for (let i = 0; i < 9; i++) {
    await sendAdminNotice(
      fixture.db,
      policy,
      "admin",
      scope,
      `quota-${i}`,
      payload(),
      now,
    );
  }
  await expect(
    sendAdminNotice(
      fixture.db,
      policy,
      "admin",
      scope,
      "quota-over",
      payload(),
      now,
    ),
  ).rejects.toMatchObject({ status: 429 });
});

it("accepts concurrent retries once and enforces the quota in the same transaction", async () => {
  const workspace = {
    kind: "workspace",
    id: "domain:concurrent-notices",
  } as const;
  const send = (key: string, sentAt = now) =>
    sendAdminNotice(
      fixture.db,
      policy,
      "admin",
      workspace,
      key,
      payload(),
      sentAt,
    );
  const identical = await Promise.all([send("same"), send("same", now + 1)]);
  expect(identical.map(({ duplicate }) => duplicate).sort()).toEqual([
    false,
    true,
  ]);
  expect(new Set(identical.map(({ eventId }) => eventId)).size).toBe(1);

  const distinct = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) => send(`new-${index}`)),
  );
  expect(distinct.filter(({ status }) => status === "fulfilled")).toHaveLength(
    9,
  );
  expect(distinct.filter(({ status }) => status === "rejected")).toEqual(
    Array.from({ length: 3 }, () =>
      expect.objectContaining({
        reason: expect.objectContaining({ status: 429 }),
      }),
    ),
  );
  for (const table of ["notification_events", "notification_admin_audit"]) {
    const column =
      table === "notification_events" ? "scope_id" : "workspace_id";
    expect(
      await fixture.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column}=?`)
        .bind(workspace.id)
        .first("count"),
    ).toBe(10);
  }
});

it("reports delivery status after dispatch", async () => {
  const sent = await sendAdminNotice(
    fixture.db,
    policy,
    "admin",
    scope,
    "status-1",
    payload(),
    now + 61_000,
  );
  const before = await adminEventStatus(
    fixture.db,
    policy,
    "admin",
    scope.id,
    sent.eventId,
  );
  expect(before.status).toBe("accepted");
  await processNotifications(fixture.db, policy, {
    now: () => now + 61_000,
    random: () => 0,
    workerId: "admin-status",
  });
  const after = await adminEventStatus(
    fixture.db,
    policy,
    "admin",
    scope.id,
    sent.eventId,
  );
  expect(after.status).toBe("completed");
  expect(after.delivered).toBe(2);
});

it("reopens a completed notice with a failed delivery and clears the retry on success", async () => {
  const sentAt = now + 122_000;
  const { eventId } = await sendAdminNotice(
    fixture.db,
    policy,
    "admin",
    scope,
    "retry-failed",
    payload(),
    sentAt,
  );
  await fixture.db
    .prepare(
      "INSERT INTO notification_recipient_retries(event_id,recipient_id,attempts,next_retry,error,status) VALUES(?,'bob',4,0,'Temporary failure','pending')",
    )
    .bind(eventId)
    .run();
  await processNotifications(
    fixture.db,
    {
      ...policy,
      async canReadSource(recipient) {
        if (recipient === "bob") throw new Error("Temporarily unavailable");
        return true;
      },
    },
    { now: () => sentAt, workerId: "failed-recipient" },
  );
  expect(
    await adminEventStatus(fixture.db, policy, "admin", scope.id, eventId),
  ).toMatchObject({
    status: "completed",
    delivered: 1,
    failed: 1,
    pendingRetries: 0,
  });

  const retriedAt = sentAt + 1000;
  expect(
    await retryAdminEvent(
      fixture.db,
      policy,
      "admin",
      scope.id,
      eventId,
      retriedAt,
    ),
  ).toEqual({ retried: 1 });
  expect(
    await adminEventStatus(fixture.db, policy, "admin", scope.id, eventId),
  ).toMatchObject({
    status: "accepted",
    delivered: 1,
    failed: 0,
    pendingRetries: 1,
  });
  await processNotifications(fixture.db, policy, {
    now: () => retriedAt,
    workerId: "retry-recipient",
  });
  expect(
    await adminEventStatus(fixture.db, policy, "admin", scope.id, eventId),
  ).toMatchObject({
    status: "completed",
    delivered: 2,
    failed: 0,
    pendingRetries: 0,
  });
});

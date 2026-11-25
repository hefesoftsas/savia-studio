import { beforeAll, afterAll, beforeEach, it, expect } from "vitest";
import type {
  NoticeEventInput,
  NotificationPolicy,
} from "@savia/studio-shared/notifications";
import { NotificationRepository } from "../src/notifications/repository";
import { processNotifications } from "../src/notifications/dispatcher";
import { notificationFixture } from "./notifications-fixture";

let fixture: Awaited<ReturnType<typeof notificationFixture>>;
const scope = { kind: "workspace", id: "domain:general" } as const;
let now = 1_000_000;

function input(key: string, principals: string[]): NoticeEventInput {
  return {
    scope,
    key,
    actor: { kind: "user", id: "admin" },
    source: { kind: "admin-message", id: key },
    title: "Review",
    body: "",
    audience: { kind: "explicit", principals },
    createdAt: now,
    expiresAt: null,
  };
}

function stubPolicy(
  overrides: Partial<{
    members: string[];
    followers: string[];
    inactive: Set<string>;
    failOnce: Set<string>;
    calls: string[];
  }> = {},
): NotificationPolicy {
  const calls = overrides.calls ?? [];
  const failOnce = new Set(overrides.failOnce ?? []);
  return {
    async canReadScope(principal) {
      calls.push(`scope:${principal}`);
      return !overrides.inactive?.has(principal);
    },
    async canReadSource(principal) {
      calls.push(`source:${principal}`);
      if (failOnce.has(principal)) {
        failOnce.delete(principal);
        throw new Error("transient policy outage");
      }
      return !overrides.inactive?.has(principal);
    },
    async canSend() {
      return true;
    },
    async recipients(event, after, limit) {
      const base =
        event.audience.kind === "explicit"
          ? [...event.audience.principals]
          : event.audience.kind === "workspace-members"
            ? [...(overrides.members ?? [])]
            : [...(overrides.followers ?? [])];
      const ordered = [...new Set(base)].sort();
      const start = after === null ? 0 : ordered.findIndex((id) => id > after);
      const ids = start < 0 ? [] : ordered.slice(start, start + limit);
      const last = ids[ids.length - 1];
      return {
        ids,
        nextCursor:
          last !== undefined && start + limit < ordered.length ? last : null,
      };
    },
  };
}

const options = {
  now: () => now,
  random: () => 0,
  workerId: "test",
};

beforeAll(async () => {
  fixture = await notificationFixture();
});

afterAll(async () => {
  await fixture?.dispose();
});

beforeEach(async () => {
  now = 1_000_000;
  await fixture.db.exec(
    "DELETE FROM notification_recipient_retries; DELETE FROM notification_deliveries; DELETE FROM notification_events; DELETE FROM notification_subscriptions;",
  );
});

it("delivers once per recipient with two concurrent workers", async () => {
  const repository = new NotificationRepository(fixture.db);
  await repository.accept(input("two-workers", ["alice", "bob"]));
  const policy = stubPolicy();
  const [a, b] = await Promise.all([
    processNotifications(fixture.db, policy, { ...options, workerId: "a" }),
    processNotifications(fixture.db, policy, { ...options, workerId: "b" }),
  ]);
  expect(a.delivered + b.delivered).toBe(2);
  const count = await fixture.db
    .prepare("SELECT COUNT(*) AS n FROM notification_deliveries")
    .first<number>("n");
  expect(count).toBe(2);
});

it("emits delivery callbacks only after the delivery rows are committed", async () => {
  const repository = new NotificationRepository(fixture.db);
  const { id } = await repository.accept(input("realtime-delivery", ["alice"]));
  const delivered: string[] = [];
  const statusUpdates: Array<{ principalId: string; eventId: string }> = [];
  const report = await processNotifications(fixture.db, stubPolicy(), options, {
    onDelivery: (principalId) => delivered.push(principalId),
    onEventStatus: (principalId, eventId) =>
      statusUpdates.push({ principalId, eventId }),
  });
  expect(report.delivered).toBe(1);
  expect(delivered).toEqual(["alice"]);
  expect(statusUpdates).toEqual([{ principalId: "admin", eventId: id }]);
  expect(
    await fixture.db
      .prepare("SELECT recipient_id FROM notification_deliveries")
      .first<{ recipient_id: string }>(),
  ).toEqual({ recipient_id: "alice" });
});

it("recovers a stale lease after a crash", async () => {
  const repository = new NotificationRepository(fixture.db);
  const { id } = await repository.accept(input("crash", ["alice"]));
  await fixture.db
    .prepare(
      "UPDATE notification_events SET status='processing',lease_token='dead',lease_until=? WHERE id=?",
    )
    .bind(now - 1000, id)
    .run();
  const report = await processNotifications(fixture.db, stubPolicy(), options);
  expect(report.recoveredLeases).toBe(1);
  expect(report.delivered).toBe(1);
});

it("skips inactive members, removed followers, and self-notifications", async () => {
  const repository = new NotificationRepository(fixture.db);
  await repository.accept(input("skip", ["alice", "mallory", "admin"]));
  await fixture.db
    .prepare(
      "INSERT INTO notification_subscriptions(workspace_id,principal_id,collection,created_at) VALUES (?,?,?,?)",
    )
    .bind("domain:general", "carol", "requests", now)
    .run();
  await fixture.db
    .prepare(
      "DELETE FROM notification_subscriptions WHERE workspace_id=? AND principal_id=?",
    )
    .bind("domain:general", "carol")
    .run();
  const policy = stubPolicy({ inactive: new Set(["mallory"]) });
  const report = await processNotifications(fixture.db, policy, options);
  expect(report.delivered).toBe(1);
  expect(report.skipped).toBe(2);
  const rows = (
    await fixture.db
      .prepare("SELECT recipient_id FROM notification_deliveries")
      .all<{ recipient_id: string }>()
  ).results;
  expect(rows.map((r) => r.recipient_id)).toEqual(["alice"]);
});

it("bounds work for oversized audiences", async () => {
  const repository = new NotificationRepository(fixture.db);
  const members = Array.from({ length: 1001 }, (_, i) => `user-${i}`);
  await repository.accept({
    ...input("huge", []),
    audience: { kind: "workspace-members" },
  });
  const report = await processNotifications(
    fixture.db,
    stubPolicy({ members }),
    {
      ...options,
      maxRecipients: 5,
    },
  );
  expect(report.delivered).toBe(5);
  const status = await fixture.db
    .prepare("SELECT status FROM notification_events")
    .first<string>("status");
  expect(status).toBe("pending");
  const next = await processNotifications(fixture.db, stubPolicy({ members }), {
    ...options,
    maxRecipients: 5,
  });
  expect(next.delivered).toBe(5);
  const rows = await fixture.db
    .prepare(
      "SELECT recipient_id FROM notification_deliveries ORDER BY recipient_id",
    )
    .all<{ recipient_id: string }>();
  expect(rows.results.map(({ recipient_id }) => recipient_id)).toEqual(
    [...members].sort().slice(0, 10),
  );
});

it("respects the tick budget and resumes a partly delivered explicit audience", async () => {
  const repository = new NotificationRepository(fixture.db);
  for (const name of ["notice-one", "notice-two"]) {
    await repository.accept(input(name, ["alice", "bob", "carol"]));
  }
  const policy = stubPolicy();
  const budget = { ...options, maxRecipients: 3, maxRecipientAttempts: 4 };
  const first = await processNotifications(fixture.db, policy, budget);
  expect(first.delivered).toBe(4);
  expect(
    (await processNotifications(fixture.db, policy, budget)).delivered,
  ).toBe(2);
  expect(
    await fixture.db
      .prepare("SELECT COUNT(*) AS n FROM notification_deliveries")
      .first("n"),
  ).toBe(6);
  expect(
    await fixture.db
      .prepare(
        "SELECT COUNT(*) AS n FROM notification_events WHERE status='completed'",
      )
      .first("n"),
  ).toBe(2);
});

it("retries transient failures and delivers on the next tick", async () => {
  const repository = new NotificationRepository(fixture.db);
  await repository.accept(input("flaky", ["alice"]));
  const policy = stubPolicy({ failOnce: new Set(["alice"]) });
  const first = await processNotifications(fixture.db, policy, options);
  expect(first.retried).toBe(1);
  expect(first.delivered).toBe(0);
  now += 61_000;
  const second = await processNotifications(fixture.db, policy, options);
  expect(second.delivered).toBe(1);
});

it.each([1, 3])(
  "processes ready recipients without retrying others before their schedule with a budget of %i",
  async (maxRecipients) => {
    const { id } = await new NotificationRepository(fixture.db).accept(
      input("recipient-backoff", ["alice", "bob", "carol"]),
    );
    await fixture.db.batch([
      fixture.db
        .prepare(
          "INSERT INTO notification_recipient_retries(event_id,recipient_id,attempts,next_retry,error,status) VALUES(?,'alice',5,0,'Terminal failure','failed')",
        )
        .bind(id),
      fixture.db
        .prepare(
          "INSERT INTO notification_recipient_retries(event_id,recipient_id,attempts,next_retry,error,status) VALUES(?,'bob',1,?,'Transient failure','pending')",
        )
        .bind(id, now + 60_000),
    ]);
    const calls: string[] = [];
    const policy = stubPolicy({ calls });
    let delivered = 0;
    for (let tick = 0; tick < Math.ceil(3 / maxRecipients); tick++) {
      const report = await processNotifications(fixture.db, policy, {
        ...options,
        maxRecipients,
      });
      delivered += report.delivered;
    }
    expect(delivered).toBe(1);
    expect(calls).toEqual(["scope:carol", "source:carol"]);
    expect(
      (await processNotifications(fixture.db, policy, options)).claimed,
    ).toBe(0);

    now += 60_000;
    const second = await processNotifications(fixture.db, policy, options);
    expect(second.delivered).toBe(1);
    expect(calls).toEqual([
      "scope:carol",
      "source:carol",
      "scope:bob",
      "source:bob",
    ]);
    const retries = await fixture.db
      .prepare(
        "SELECT recipient_id,status FROM notification_recipient_retries WHERE event_id=?",
      )
      .bind(id)
      .all();
    expect(retries.results).toEqual([
      { recipient_id: "alice", status: "failed" },
    ]);
  },
);

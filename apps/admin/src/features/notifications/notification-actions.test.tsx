import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollectionFollow } from "./collection-follow";
import { AdminNoticeForm } from "./admin-notice-form";
import { AdminNoticeStatus } from "./admin-notice-status";
import type { NotificationClient } from "./client";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function baseClient(overrides: Partial<NotificationClient> = {}): NotificationClient {
  return {
    inbox: async () => ({ items: [], nextCursor: null, cutoff: "" }),
    unreadCount: async () => 0,
    setRead: async () => {},
    archive: async () => {},
    readAll: async () => ({ updated: 0, nextCursor: null }),
    resolve: async () => {},
    follows: async () => [],
    follow: async () => {},
    unfollow: async () => {},
    sendAdminNotice: async () => ({ eventId: "e1", status: "accepted", duplicate: false }),
    retryAdminNotice: async () => ({ retried: 0 }),
    adminStatus: async () => ({ status: "accepted", delivered: 0, failed: 0, pendingRetries: 0 }),
    ...overrides,
  } as NotificationClient;
}

function renderWith(client: NotificationClient, ui: React.ReactNode) {
  render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
  return client;
}

it("toggles collection follows and surfaces failures", async () => {
  const follow = vi.fn().mockResolvedValue(undefined);
  const followClient = baseClient({ follows: async () => [], follow });
  renderWith(followClient, <CollectionFollow collection="requests" client={followClient} />);
  const followButton = await screen.findByRole("button", { name: "savia.notificationInbox.follow" });
  await vi.waitFor(() => expect(followButton).not.toBeDisabled());
  fireEvent.click(followButton);
  expect(follow).toHaveBeenCalledWith("requests");

  cleanup();
  const failing = vi.fn().mockRejectedValue(new Error("offline"));
  const failingClient = baseClient({ follows: async () => ["requests"], unfollow: failing });
  renderWith(failingClient, <CollectionFollow collection="requests" client={failingClient} />);
  fireEvent.click(await screen.findByRole("button", { name: "savia.notificationInbox.unfollow" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("savia.notificationInbox.actionError");
});

it("keeps follow actions unavailable until the initial following state is known", async () => {
  const follows = vi
    .fn<NotificationClient["follows"]>()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue(["requests"]);
  const follow = vi.fn(async () => {});
  const client = baseClient({ follows, follow });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <CollectionFollow collection="requests" client={client} />
    </QueryClientProvider>,
  );
  expect(
    await screen.findByText("savia.notificationInbox.followLoadError"),
  ).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "savia.notificationInbox.follow" }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.retry" }),
  );
  expect(
    await screen.findByRole("button", {
      name: "savia.notificationInbox.unfollow",
      pressed: true,
    }),
  ).toBeEnabled();
  expect(follow).not.toHaveBeenCalled();
});

it("hides the administrator form without permission and reports 429", async () => {
  const { container } = (() => {
    const result = render(
      <QueryClientProvider client={new QueryClient()}>
        <AdminNoticeForm scope="agency:1" canAdminister={false} />
      </QueryClientProvider>,
    );
    return result;
  })();
  expect(container).toBeEmptyDOMElement();

  cleanup();
  const sendAdminNotice = vi.fn().mockRejectedValue(new Error("429 quota"));
  renderWith(
    baseClient({ sendAdminNotice }),
    <AdminNoticeForm scope="agency:1" canAdminister client={baseClient({ sendAdminNotice })} />,
  );
  fireEvent.change(screen.getByLabelText("savia.notificationInbox.adminSubject"), {
    target: { value: "Downtime" },
  });
  fireEvent.change(screen.getByLabelText("savia.notificationInbox.adminRecipients"), {
    target: { value: "alice" },
  });
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "savia.notificationInbox.adminRequireAcknowledgement",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "savia.notificationInbox.adminSend" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("savia.notificationInbox.quotaExceeded");
  expect(sendAdminNotice).toHaveBeenCalledWith(
    expect.objectContaining({ requireAcknowledgement: true }),
  );
});

it("shows accepted delivery status for administrators", async () => {
  const client = baseClient({
    sendAdminNotice: async () => ({ eventId: "evt-9", status: "accepted", duplicate: true }),
    adminStatus: async () => ({ status: "processing", delivered: 4, failed: 1, pendingRetries: 2 }),
  });
  renderWith(
    client,
    <>
      <AdminNoticeForm scope="agency:1" canAdminister client={client} />
      <AdminNoticeStatus eventId="evt-9" client={client} />
    </>,
  );
  expect(await screen.findByText("processing")).toBeVisible();
  expect(await screen.findByText("4")).toBeVisible();
});

it("lets administrators retry the initial delivery status lookup", async () => {
  const adminStatus = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue({
      status: "completed",
      delivered: 3,
      failed: 0,
      pendingRetries: 0,
    });
  const client = baseClient({ adminStatus });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <AdminNoticeStatus eventId="evt-offline" client={client} />
    </QueryClientProvider>,
  );
  await screen.findByRole("alert");
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.retry" }),
  );
  expect(await screen.findByText("completed")).toBeVisible();
  expect(adminStatus.mock.calls).toEqual([["evt-offline"], ["evt-offline"]]);
});

it("reuses the same notice key after a failed request and releases it after success", async () => {
  const sendAdminNotice = vi
    .fn()
    .mockRejectedValueOnce(new Error("Connection interrupted"))
    .mockResolvedValue({
      eventId: "retry-event",
      status: "accepted",
      duplicate: false,
    });
  const client = baseClient({ sendAdminNotice });
  renderWith(
    client,
    <AdminNoticeForm scope="tenant:1" canAdminister client={client} />,
  );
  fireEvent.change(
    screen.getByLabelText("savia.notificationInbox.adminSubject"),
    { target: { value: "Notice" } },
  );
  fireEvent.change(
    screen.getByLabelText("savia.notificationInbox.adminRecipients"),
    { target: { value: "alice" } },
  );
  const send = screen.getByRole("button", {
    name: "savia.notificationInbox.adminSend",
  });
  fireEvent.click(send);
  await screen.findByRole("alert");
  fireEvent.click(send);
  await screen.findByRole("status");
  expect(sendAdminNotice.mock.calls[1][0]).toEqual(
    sendAdminNotice.mock.calls[0][0],
  );
  fireEvent.click(send);
  await screen.findByRole("status");
  expect(sendAdminNotice.mock.calls[2][0].key).not.toBe(
    sendAdminNotice.mock.calls[0][0].key,
  );
});

it("does not poll administrative notice status", async () => {
  vi.useFakeTimers();
  const adminStatus = vi.fn().mockResolvedValue({
    status: "processing",
    delivered: 0,
    failed: 0,
    pendingRetries: 1,
  });
  const client = baseClient({ adminStatus });
  renderWith(client, <AdminNoticeStatus eventId="evt-pending" client={client} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(adminStatus).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300_000);
  });
  expect(adminStatus).toHaveBeenCalledTimes(1);
});

it("retries failed deliveries and refreshes the displayed status", async () => {
  const adminStatus = vi.fn()
    .mockResolvedValueOnce({ status: "completed", delivered: 1, failed: 1, pendingRetries: 0 })
    .mockResolvedValue({ status: "accepted", delivered: 1, failed: 0, pendingRetries: 1 });
  const retryAdminNotice = vi.fn().mockResolvedValue({ retried: 1 });
  const client = baseClient({ adminStatus, retryAdminNotice });
  renderWith(client, <AdminNoticeStatus eventId="evt-retry" client={client} />);
  const retry = await screen.findByRole("button", { name: "savia.notificationInbox.retryFailed" });
  fireEvent.click(retry);
  expect(await screen.findByText("accepted")).toBeVisible();
  expect(retryAdminNotice).toHaveBeenCalledWith("evt-retry");
  expect(screen.queryByRole("button", { name: "savia.notificationInbox.retryFailed" })).toBeNull();
});

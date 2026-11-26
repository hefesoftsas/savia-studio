import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { NotificationBell } from "./notification-bell";
import { NotificationInbox } from "./notification-inbox";
import {
  notificationClient,
  type InboxFilter,
  type NoticeItem,
  type NotificationClient,
} from "./client";
import { getSessionGeneration, rotateSessionScope } from "@/auth/session-scope";
import { notificationReadKey } from "./queries";
import { REQUEST_TIMEOUT_MS } from "@/api/request-timeout";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("lets a recipient confirm receipt of a read administrator notice", async () => {
  const item: NoticeItem = {
    id: "acknowledgement",
    title: "Please confirm receipt",
    body: "",
    createdAt: 1,
    readAt: 2,
    archivedAt: null,
    source: { kind: "admin-message" },
    actionState: "pending",
  };
  const resolve = vi.fn(async () => {
    item.actionState = "done";
  });
  setupNoRetry({
    resolve,
    inbox: async () => ({ items: [{ ...item }], nextCursor: null, cutoff: "" }),
  });
  fireEvent.click(
    await screen.findByRole("button", {
      name: "savia.notificationInbox.acknowledge",
    }),
  );
  expect(resolve).toHaveBeenCalledWith(item.id);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "savia.notificationInbox.acknowledge",
      }),
    ).toBeNull(),
  );
});

it("provides an archive action for an unavailable notice", async () => {
  const archive = vi.fn(async () => {});
  setupNoRetry({
    archive,
    inbox: async () => ({
      items: [
        {
          id: "damaged",
          title: "Notification unavailable",
          body: "",
          createdAt: 1,
          readAt: null,
          archivedAt: null,
          source: { kind: "unavailable" },
          actionState: "unavailable",
        },
      ],
      nextCursor: null,
      cutoff: "",
    }),
  });
  expect(
    await screen.findByText("savia.notificationInbox.unavailableNotice"),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.archive" }),
  );
  expect(archive).toHaveBeenCalledWith("damaged");
});

it("links account security notices to the account page", async () => {
  setupNoRetry({
    inbox: async () => ({
      items: [
        {
          id: "security-notice",
          title: "Two-factor authentication enabled",
          body: "",
          createdAt: 2,
          readAt: null,
          archivedAt: null,
          source: { kind: "security-request" },
          actionState: "none",
        },
      ],
      nextCursor: null,
      cutoff: "",
    }),
  });
  const link = await screen.findByRole("link", {
    name: "savia.notificationInbox.openAccount",
  });
  expect(link).toHaveAttribute("href", "/account");
});

it("appends older notices and retries a failed page without losing the inbox", async () => {
  const first: NoticeItem = {
    id: "newer",
    title: "Newer notice",
    body: "",
    createdAt: 2,
    readAt: null,
    archivedAt: null,
    source: { kind: "admin-message" },
    actionState: "none",
  };
  const older = { ...first, id: "older", title: "Older notice", createdAt: 1 };
  const inbox = vi
    .fn()
    .mockResolvedValueOnce({
      items: [first],
      nextCursor: "older-cursor",
      cutoff: "first",
    })
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockResolvedValueOnce({
      items: [older],
      nextCursor: null,
      cutoff: "last",
    });
  setupNoRetry({ inbox });

  await screen.findByText(first.title);
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.loadMore" }),
  );
  expect(
    await screen.findByText("savia.notificationInbox.loadMoreError"),
  ).toBeVisible();
  expect(screen.getByText(first.title)).toBeVisible();

  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.retry" }),
  );
  expect(await screen.findByText(older.title)).toBeVisible();
  expect(screen.getByText(first.title)).toBeVisible();
  expect(inbox.mock.calls.map(([, cursor]) => cursor)).toEqual([
    undefined,
    "older-cursor",
    "older-cursor",
  ]);
  expect(
    screen.queryByRole("button", { name: "savia.notificationInbox.loadMore" }),
  ).toBeNull();
});

it("marks every page of notifications as read from a single action", async () => {
  let unread = 201;
  const readAll = vi.fn(async (cursor?: string) => {
    const updated = Math.min(unread, 100);
    unread -= updated;
    return {
      updated,
      nextCursor: unread > 0 ? `after-${cursor ? 200 : 100}` : null,
    };
  });
  setup({ readAll, unreadCount: async () => unread });
  expect(
    await screen.findByLabelText("savia.notificationInbox.title (201)"),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.markAllRead" }),
  );

  await waitFor(() =>
    expect(readAll.mock.calls).toEqual([
      [undefined],
      ["after-100"],
      ["after-200"],
    ]),
  );
  expect(
    await screen.findByRole("button", {
      name: "savia.notificationInbox.title",
    }),
  ).toBeVisible();
});

it("refreshes counts and resumes the failed bulk-read page without including newer notices", async () => {
  let unread = 101;
  const readAll = vi
    .fn<(cursor?: string) => ReturnType<NotificationClient["readAll"]>>()
    .mockImplementationOnce(async () => {
      unread = 1;
      return { updated: 100, nextCursor: "after-100" };
    })
    .mockRejectedValueOnce(new Error("Unavailable"))
    .mockImplementation(async (cursor) => {
      const updated = cursor ? 1 : unread;
      unread -= updated;
      return { updated, nextCursor: null };
    });
  setup({ readAll, unreadCount: async () => unread });
  await screen.findByLabelText("savia.notificationInbox.title (101)");
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.markAllRead" }),
  );

  expect(
    await screen.findByText("savia.notificationInbox.actionError"),
  ).toBeVisible();
  expect(
    await screen.findByLabelText("savia.notificationInbox.title (1)"),
  ).toBeVisible();
  unread += 1;
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.markAllRead" }),
  );
  await waitFor(() =>
    expect(readAll.mock.calls).toEqual([
      [undefined],
      ["after-100"],
      ["after-100"],
    ]),
  );
  expect(unread).toBe(1);
});

function setupNoRetry(client: Partial<NotificationClient>) {
  const full = {
    inbox: async () => ({ items: [], nextCursor: null, cutoff: "" }),
    unreadCount: async () => 0,
    setRead: async () => {},
    archive: async () => {},
    readAll: async () => ({ updated: 0, nextCursor: null }),
    resolve: async () => {},
    ...client,
  } as NotificationClient;
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false } },
        })
      }
    >
      <MemoryRouter>
        <NotificationInbox client={full} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return full;
}

function setup(client: Partial<NotificationClient>) {
  const full = {
    inbox: async () => ({ items: [], nextCursor: null, cutoff: "" }),
    unreadCount: async () => 0,
    setRead: async () => {},
    archive: async () => {},
    readAll: async () => ({ updated: 0, nextCursor: null }),
    resolve: async () => {},
    ...client,
  } as NotificationClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <NotificationBell client={full} />
        <NotificationInbox client={full} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return full;
}

it("shows the unread badge and opens the inbox dialog", async () => {
  setup({ unreadCount: async () => 3 });
  expect(
    await screen.findByLabelText("savia.notificationInbox.title (3)"),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.title (3)" }),
  );
  expect(await screen.findByRole("dialog")).toBeVisible();
});

it("checks a stale notification count when the bell opens and reuses a fresh count", async () => {
  const unreadCount = vi.fn(async () => 1);
  const cache = new QueryClient();
  cache.setQueryData(
    notificationReadKey(getSessionGeneration(), "unread-count"),
    3,
    { updatedAt: Date.now() - 31_000 },
  );
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <NotificationBell client={{ ...notificationClient, unreadCount }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  const oldCount = screen.getByRole("button", {
    name: "savia.notificationInbox.title (3)",
  });
  expect(unreadCount).not.toHaveBeenCalled();
  fireEvent.click(oldCount);
  const updatedCount = await screen.findByRole("button", {
    name: "savia.notificationInbox.title (1)",
  });
  fireEvent.click(updatedCount);
  fireEvent.click(updatedCount);
  expect(unreadCount).toHaveBeenCalledTimes(1);
});

it("shows loading and retries when the notification count is unavailable", async () => {
  let failCount!: (reason: Error) => void;
  const initialCount = new Promise<number>((_resolve, reject) => {
    failCount = reject;
  });
  const unreadCount = vi
    .fn<NotificationClient["unreadCount"]>()
    .mockReturnValueOnce(initialCount)
    .mockResolvedValue(2);
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={cache}>
      <MemoryRouter>
        <NotificationBell client={{ ...notificationClient, unreadCount }} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.title" }),
  );
  expect(screen.getByText("savia.notificationInbox.loading")).toBeVisible();
  expect(screen.queryByText("savia.notificationInbox.noNew")).toBeNull();
  await act(async () => failCount(new Error("Offline")));
  expect(
    await screen.findByText("savia.notificationInbox.countLoadError"),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.retry" }),
  );
  expect(
    await screen.findByRole("button", {
      name: "savia.notificationInbox.title (2)",
    }),
  ).toBeVisible();
});

it("reads a fresh notification count after the authenticated principal changes", async () => {
  const unreadCount = vi.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
  setup({ unreadCount });
  expect(
    await screen.findByLabelText("savia.notificationInbox.title (4)"),
  ).toBeVisible();

  act(() => rotateSessionScope("principal-change"));

  expect(
    await screen.findByLabelText("savia.notificationInbox.title (1)"),
  ).toBeVisible();
  expect(unreadCount).toHaveBeenCalledTimes(2);
});

it("paginates filters and retries failed mutations", async () => {
  const setRead = vi
    .fn()
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(undefined);
  setup({
    inbox: async () => ({
      items: [
        {
          id: "n1",
          title: "Review",
          body: "",
          createdAt: Date.now(),
          readAt: null,
          archivedAt: null,
          source: { kind: "admin-message", id: "m1" },
          actionState: "pending",
        },
      ],
      nextCursor: null,
      cutoff: "",
    }),
    setRead,
  });
  await screen.findByText("Review");
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.markRead" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "savia.notificationInbox.actionError",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.markRead" }),
  );
  await screen.findByText("Review");
  expect(setRead).toHaveBeenCalledTimes(2);
  fireEvent.click(
    screen.getByRole("tab", { name: "savia.notificationInbox.pending" }),
  );
  await screen.findByText("Review");
});

it.each(["mark-read", "archive", "read-all"] as const)(
  "refreshes cached unread notifications after %s from the all filter",
  async (mutation) => {
    const item: NoticeItem = {
      id: "n1",
      title: "Review",
      body: "Needs attention",
      createdAt: Date.now(),
      readAt: null,
      archivedAt: null,
      source: { kind: "admin-message", id: "m1" },
      actionState: "pending",
    };
    const inbox = vi.fn(async (filter: InboxFilter) => {
      const visible =
        item.archivedAt === null &&
        (filter !== "unread" || item.readAt === null) &&
        (filter !== "pending" || item.actionState === "pending");
      return {
        items: visible ? [{ ...item }] : [],
        nextCursor: null,
        cutoff: "",
      };
    });
    const unreadCount = vi.fn(async () =>
      item.readAt === null && item.archivedAt === null ? 1 : 0,
    );
    const client = {
      inbox,
      unreadCount,
      setRead: vi.fn(async (_id: string, read: boolean) => {
        item.readAt = read ? Date.now() : null;
      }),
      archive: vi.fn(async () => {
        item.archivedAt = Date.now();
      }),
      readAll: vi.fn(async () => {
        item.readAt = Date.now();
        return { updated: 1, nextCursor: null };
      }),
      resolve: vi.fn(async () => {}),
    } as unknown as NotificationClient;
    render(
      <QueryClientProvider
        client={
          new QueryClient({
            defaultOptions: { queries: { retry: false } },
          })
        }
      >
        <MemoryRouter>
          <NotificationBell client={client} />
          <NotificationInbox client={client} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByLabelText("savia.notificationInbox.title (1)"),
    ).toBeVisible();
    expect(await screen.findByText("Review")).toBeVisible();
    fireEvent.click(
      screen.getByRole("tab", { name: "savia.notificationInbox.unread" }),
    );
    await waitFor(() =>
      expect(
        inbox.mock.calls.filter(([filter]) => filter === "unread"),
      ).toHaveLength(1),
    );
    expect(await screen.findByText("Review")).toBeVisible();
    fireEvent.click(
      screen.getByRole("tab", { name: "savia.notificationInbox.all" }),
    );

    if (mutation === "mark-read") {
      fireEvent.click(
        screen.getByRole("button", {
          name: "savia.notificationInbox.markRead",
        }),
      );
      await waitFor(() => expect(client.setRead).toHaveBeenCalledTimes(1));
    } else if (mutation === "archive") {
      fireEvent.click(
        screen.getByRole("button", { name: "savia.notificationInbox.archive" }),
      );
      await waitFor(() => expect(client.archive).toHaveBeenCalledTimes(1));
    } else {
      fireEvent.click(
        screen.getByRole("button", {
          name: "savia.notificationInbox.markAllRead",
        }),
      );
      await waitFor(() => expect(client.readAll).toHaveBeenCalledTimes(1));
    }

    await waitFor(() =>
      expect(
        inbox.mock.calls.filter(([filter]) => filter === "all"),
      ).toHaveLength(2),
    );
    if (mutation === "archive") {
      await waitFor(() =>
        expect(screen.queryByText("Review")).not.toBeInTheDocument(),
      );
    }
    fireEvent.click(
      screen.getByRole("tab", { name: "savia.notificationInbox.unread" }),
    );
    await waitFor(() =>
      expect(
        inbox.mock.calls.filter(([filter]) => filter === "unread"),
      ).toHaveLength(2),
    );
    await waitFor(() =>
      expect(screen.queryByText("Review")).not.toBeInTheDocument(),
    );
    expect(
      await screen.findByRole("button", {
        name: "savia.notificationInbox.title",
      }),
    ).toBeVisible();
  },
);

it("shows an empty state without the load error when the inbox is empty", async () => {
  setup({});
  expect(await screen.findByTestId("notifications-empty")).toBeVisible();
  expect(screen.getByText("savia.notificationInbox.empty")).toBeVisible();
  expect(
    screen.queryByText("savia.notificationInbox.loadError"),
  ).not.toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("tab", { name: "savia.notificationInbox.unread" }),
  );
  expect(
    await screen.findByRole("button", {
      name: "savia.notificationInbox.showAll",
    }),
  ).toBeVisible();
  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.showAll" }),
  );
  expect(
    screen.getByRole("tab", { name: "savia.notificationInbox.all" }),
  ).toHaveAttribute("aria-selected", "true");
});

it("shows a retryable error without the empty state when loading fails", async () => {
  const inbox = vi.fn().mockRejectedValue(new Error("offline"));
  setupNoRetry({ inbox });
  expect(
    await screen.findByText("savia.notificationInbox.loadError"),
  ).toBeVisible();
  expect(screen.queryByTestId("notifications-empty")).not.toBeInTheDocument();

  fireEvent.click(
    screen.getByRole("button", { name: "savia.notificationInbox.retry" }),
  );
  await vi.waitFor(() => expect(inbox.mock.calls.length).toBeGreaterThan(1));
});

it.each(["headers", "body"])(
  "lets the inbox retry after the notification request stalls waiting for %s",
  async (stage) => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => {});
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() =>
        stage === "headers"
          ? stalled
          : Promise.resolve(
              Object.assign(new Response(), { json: () => stalled }),
            ),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { items: [], nextCursor: null, cutoff: "" } }),
      );
    vi.stubGlobal("fetch", fetcher);
    setupNoRetry({ inbox: notificationClient.inbox });

    await act(() => vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1));
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(screen.getByText("savia.notificationInbox.loadError")).toBeVisible();
    expect(screen.queryByTestId("notifications-empty")).not.toBeInTheDocument();

    vi.useRealTimers();
    fireEvent.click(
      screen.getByRole("button", { name: "savia.notificationInbox.retry" }),
    );
    expect(await screen.findByTestId("notifications-empty")).toBeVisible();
    expect(fetcher.mock.calls[1][0]).toBe(fetcher.mock.calls[0][0]);
  },
);

// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { render } from "../studio-engine/test/locale-test-render";
import { afterEach, expect, it, vi } from "vitest";
import { ApiClient, ApiClientError } from "@/api/api-client";
import { beginLogout } from "@/auth/logout-progress";
import { rotateSessionScope } from "@/auth/session-scope";
import {
  ActionsWidgetBody,
  ChartWidgetBody,
  ItemsWidgetBody,
  SummaryWidgetBody,
  WidgetCard,
} from "./widgets";

const subscribe = vi.hoisted(() =>
  vi.fn(
    (_options: {
      topics: string[];
      onEvent: (event: {
        topic: string;
        type: string;
        collection?: string;
      }) => void;
    }) => ({ status: "live" }),
  ),
);
vi.mock("@/realtime/use-realtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/realtime/use-realtime")>()),
  useRealtimeTopics: subscribe,
}));

afterEach(cleanup);

it("retries loading the schema after a temporary error before querying widget records", async () => {
  const widget = {
    id: "summary",
    kind: "summary" as const,
    apiBasePath: "/v1/studio/14",
    collection: "hubspot_contacts",
  };
  const get = vi
    .fn()
    .mockRejectedValueOnce(new Error("Temporary connection failure"))
    .mockResolvedValueOnce({
      data: [
        {
          name: widget.collection,
          config: {
            studio: { collection: { kind: "crm", sourceId: "hubspot" } },
          },
        },
      ],
    })
    .mockResolvedValueOnce({ data: [], total: 6 });
  render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

  expect(
    await screen.findByText("No pudimos leer esta colección."),
  ).toBeVisible();
  expect(get).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Reintentar" }));
  expect(await screen.findByText("6")).toBeVisible();
  expect(get.mock.calls.map(([path]) => path)).toEqual([
    "/v1/studio/14/api/objects",
    "/v1/studio/14/api/objects",
    "/v1/studio/14/api/records/hubspot_contacts/summary",
  ]);
});

it("shows that a missing summary collection is unavailable without querying its records", async () => {
  const get = vi.fn(async () => ({ data: [] }));
  render(
    <SummaryWidgetBody
      apiClient={{ get } as never}
      widget={{
        id: "summary",
        kind: "summary",
        apiBasePath: "/v1/studio/14",
        collection: "removed",
      }}
    />,
  );

  expect(
    await screen.findByText(/Esta colección ya no está disponible/),
  ).toBeVisible();
  expect(get).toHaveBeenCalledTimes(1);
});

it("shows the HubSpot total and status groups from the collection summary", async () => {
  const apiBasePath = "/v1/studio/14";
  const widget = {
    id: "contacts-summary",
    title: "Contactos",
    kind: "summary" as const,
    apiBasePath,
    collection: "hubspot_contacts",
    config: { statusField: "lifecyclestage" },
  };
  const get = vi.fn(async (path: string) => {
    if (path === `${apiBasePath}/api/objects`)
      return {
        data: [
          {
            name: widget.collection,
            config: {
              fields: { lifecyclestage: { type: "select" } },
              studio: { collection: { kind: "crm", sourceId: "hubspot" } },
            },
          },
        ],
      };
    if (
      path ===
      `${apiBasePath}/api/records/hubspot_contacts/summary?group=lifecyclestage`
    )
      return { data: [{ value: "Lead", count: 5 }], total: 6 };
    throw new Error(`Unexpected endpoint: ${path}`);
  });

  render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

  expect(await screen.findByText("6")).toBeVisible();
  expect(screen.getByText("Lead")).toBeVisible();
  expect(screen.getByText("5")).toBeVisible();
  expect(get).toHaveBeenCalledTimes(2);
});

it.each([[null], [{ value: "Lead" }], [{ value: "Lead", count: -1 }]])(
  "keeps the known HubSpot total when the status breakdown contains an invalid row (%j)",
  async (row) => {
    const widget = {
      id: "contacts-incomplete-breakdown",
      kind: "summary" as const,
      apiBasePath: "/v1/studio/14",
      collection: "hubspot_contacts",
      config: { statusField: "lifecyclestage" },
    };
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [
            {
              name: widget.collection,
              config: {
                fields: { lifecyclestage: { type: "Dropdown" } },
                studio: { collection: { kind: "crm", sourceId: "hubspot" } },
              },
            },
          ],
        };
      return { data: [row], total: 6 };
    });
    render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

    expect(await screen.findByText("6")).toBeVisible();
    expect(
      screen.getByText("El desglose por estado no está disponible."),
    ).toBeVisible();
    expect(screen.queryByText("Lead")).not.toBeInTheDocument();
  },
);

it("shows the verified HubSpot count when a group amount is unavailable", async () => {
  const widget = {
    id: "deals-without-amount",
    kind: "summary" as const,
    apiBasePath: "/v1/studio/14",
    collection: "hubspot_deals",
    config: { statusField: "dealstage", amountField: "amount" },
  };
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/objects"))
      return {
        data: [
          {
            name: widget.collection,
            config: {
              fields: {
                dealstage: { type: "Dropdown" },
                amount: { type: "Number" },
              },
              studio: { collection: { kind: "crm", sourceId: "hubspot" } },
            },
          },
        ],
      };
    if (path.endsWith("/summary?group=dealstage&amountField=amount"))
      return {
        total: 3,
        data: [
          { value: "Qualified", count: 2 },
          { value: "Won", count: 1, amount: 20.5 },
        ],
      };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

  expect(await screen.findByText("3")).toBeVisible();
  expect(
    screen.getByText("El desglose por estado no está disponible."),
  ).toBeVisible();
  expect(screen.queryByText("Qualified")).not.toBeInTheDocument();
  expect(get).toHaveBeenCalledTimes(2);
});

it("hides the previous summary after session clearance without reading during logout", async () => {
  const widget = {
    id: "logout-summary",
    kind: "summary" as const,
    apiBasePath: "/v1/studio/14",
    collection: "hubspot_contacts",
  };
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/objects"))
      return {
        data: [
          {
            name: widget.collection,
            config: {
              studio: { collection: { kind: "crm", sourceId: "hubspot" } },
            },
          },
        ],
      };
    if (path.endsWith("/summary")) return { data: [], total: 37 };
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);
  expect(await screen.findByText("37")).toBeVisible();
  const finishLogout = beginLogout();
  try {
    await act(async () => rotateSessionScope("logout"));
    expect(screen.queryByText("37")).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(2);
  } finally {
    finishLogout();
  }
});

it("does not display the old HubSpot total while the new collection is loading", async () => {
  const widget = {
    id: "crm-summary",
    kind: "summary" as const,
    apiBasePath: "/v1/studio/14",
    collection: "hubspot_contacts",
  };
  const next = { ...widget, collection: "hubspot_companies" };
  let finishNext!: (value: { data: []; total: number }) => void;
  const nextSummary = new Promise<{ data: []; total: number }>((resolve) => {
    finishNext = resolve;
  });
  const get = vi.fn(async (path: string) => {
    if (path.endsWith("/objects"))
      return {
        data: [widget.collection, next.collection].map((name) => ({
          name,
          config: {
            studio: { collection: { kind: "crm", sourceId: "hubspot" } },
          },
        })),
      };
    if (path.endsWith("/hubspot_contacts/summary"))
      return { data: [], total: 37 };
    if (path.endsWith("/hubspot_companies/summary")) return nextSummary;
    throw new Error(`Unexpected endpoint: ${path}`);
  });
  const apiClient = { get } as never;
  const { rerender } = render(
    <SummaryWidgetBody apiClient={apiClient} widget={widget} />,
  );
  expect(await screen.findByText("37")).toBeVisible();

  rerender(<SummaryWidgetBody apiClient={apiClient} widget={next} />);
  await waitFor(() =>
    expect(get).toHaveBeenCalledWith(
      `${next.apiBasePath}/api/records/${next.collection}/summary`,
      expect.anything(),
    ),
  );
  expect(screen.queryByText("37")).not.toBeInTheDocument();
  finishNext({ data: [], total: 12 });
  expect(await screen.findByText("12")).toBeVisible();
});

it("cancels the obsolete HubSpot summary when the collection changes", async () => {
  const widget = {
    id: "cancel-hubspot-summary",
    kind: "summary" as const,
    apiBasePath: "/v1/studio/14",
    collection: "hubspot_contacts",
  };
  const next = { ...widget, collection: "hubspot_companies" };
  let previousSignal: AbortSignal | null | undefined;
  const apiClient = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => "test" },
    fetcher: async (url, init) => {
      const path = String(url);
      if (path.endsWith("/objects"))
        return Response.json({
          data: [widget.collection, next.collection].map((name) => ({
            name,
            config: {
              studio: { collection: { kind: "crm", sourceId: "hubspot" } },
            },
          })),
        });
      if (path.endsWith("/hubspot_contacts/summary")) {
        previousSignal = init?.signal;
        return new Promise<Response>((_resolve, reject) =>
          previousSignal?.addEventListener(
            "abort",
            () => reject(previousSignal?.reason),
            { once: true },
          ),
        );
      }
      return Response.json({ data: [], total: 12 });
    },
  });
  const { rerender } = render(
    <SummaryWidgetBody apiClient={apiClient} widget={widget} />,
  );
  await waitFor(() => expect(previousSignal?.aborted).toBe(false));

  rerender(<SummaryWidgetBody apiClient={apiClient} widget={next} />);
  expect(previousSignal?.aborted).toBe(true);
  expect(await screen.findByText("12")).toBeVisible();
  expect(
    screen.queryByText("No pudimos cargar este resumen."),
  ).not.toBeInTheDocument();
});

it.each([
  ["items", ItemsWidgetBody],
  ["chart", ChartWidgetBody],
  ["actions", ActionsWidgetBody],
] as const)(
  "hides the previous collection while the %s widget loads its new source",
  async (kind, Body) => {
    const widget = {
      id: "record-widget",
      kind,
      apiBasePath: "/v1/studio/14",
      collection: "first",
      config: { groupField: "status", dateField: "due" },
    };
    const next = { ...widget, collection: "second" };
    const fixture = (name: string) => ({
      data: [{ id: name, name, value: name, count: 1, due: "2000-01-01" }],
    });
    let finishNext!: (value: ReturnType<typeof fixture>) => void;
    const pending = new Promise<ReturnType<typeof fixture>>((resolve) => {
      finishNext = resolve;
    });
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [widget.collection, next.collection].map((name) => ({
            name,
            config: {
              fields: {
                name: { type: "Textbox" },
                status: { type: "Dropdown" },
                due: { type: "DateControl" },
              },
            },
          })),
        };
      if (path.includes("/records/first"))
        return fixture("Previous collection data");
      if (path.includes("/records/second")) return pending;
      throw new Error(`Unexpected endpoint: ${path}`);
    });
    const apiClient = { get } as never;
    const { rerender } = render(<Body apiClient={apiClient} widget={widget} />);
    expect(await screen.findByText("Previous collection data")).toBeVisible();
    rerender(<Body apiClient={apiClient} widget={next} />);
    await waitFor(() =>
      expect(
        get.mock.calls.some(([path]) => path.includes("/records/second")),
      ).toBe(true),
    );
    expect(
      screen.queryByText("Previous collection data"),
    ).not.toBeInTheDocument();
    finishNext(fixture("Current collection data"));
    expect(await screen.findByText("Current collection data")).toBeVisible();
  },
);

it.each(["records", "studio"])(
  "discards a queued %s refresh when the widget changes collections in the same organization",
  async (topic) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const widget = {
        id: "live-items",
        kind: "items" as const,
        apiBasePath: "/v1/studio/14",
        collection: "first",
      };
      const next = { ...widget, collection: "second" };
      const get = vi.fn(async (path: string) => {
        if (path.endsWith("/objects"))
          return {
            data: [widget.collection, next.collection].map((name) => ({
              name,
              config: { fields: { name: { type: "Textbox" } } },
            })),
          };
        const name = path.includes("/records/first") ? "First" : "Second";
        return { data: [{ id: name, name }], total: 1 };
      });
      const apiClient = { get } as never;
      const { rerender } = render(
        <ItemsWidgetBody apiClient={apiClient} widget={widget} />,
      );
      await act(async () => {});
      expect(screen.getByText("First")).toBeVisible();

      const emit = (collection: string) =>
        subscribe.mock.calls
          .filter(([options]) => options.topics.includes(topic))
          .at(-1)?.[0]
          .onEvent({ topic, type: "updated", collection });
      act(() => emit(widget.collection));
      await act(async () => {
        rerender(<ItemsWidgetBody apiClient={apiClient} widget={next} />);
      });
      expect(screen.getByText("Second")).toBeVisible();
      get.mockClear();

      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(get).not.toHaveBeenCalled();

      act(() => emit(next.collection));
      await act(async () => vi.advanceTimersByTimeAsync(200));
      expect(get).toHaveBeenCalledWith(
        expect.stringContaining("/records/second?"),
        expect.anything(),
      );
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([503, 403])(
  "handles a %s when reloading the metadata of an already visible summary",
  async (status) => {
    const widget = {
      id: "metadata-refresh",
      kind: "summary" as const,
      apiBasePath: "/v1/studio/14",
      collection: "hubspot_contacts",
    };
    const schema = {
      data: [
        {
          name: widget.collection,
          config: {
            studio: { collection: { kind: "crm", sourceId: "hubspot" } },
          },
        },
      ],
    };
    let rejectMetadata!: (error: Error) => void;
    const pendingMetadata = new Promise<typeof schema>((_resolve, reject) => {
      rejectMetadata = reject;
    });
    let schemaReads = 0;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return ++schemaReads === 2 ? pendingMetadata : schema;
      if (path.endsWith("/summary"))
        return { data: [], total: schemaReads === 1 ? 37 : 12 };
      throw new Error(`Unexpected endpoint: ${path}`);
    });
    render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);
    expect(await screen.findByText("37")).toBeVisible();
    const subscription = subscribe.mock.calls
      .filter(([options]) => options.topics.includes("studio"))
      .at(-1)?.[0];
    act(() => subscription?.onEvent({ topic: "studio", type: "updated" }));
    await waitFor(() => expect(schemaReads).toBe(2));
    expect(screen.getByText("37")).toBeVisible();

    await act(async () =>
      rejectMetadata(
        new ApiClientError(status, "READ_FAILED", "Metadata unavailable"),
      ),
    );
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    if (status === 503) {
      expect(screen.getByText("37")).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        "No pudimos leer esta colección.",
      );
    } else {
      expect(screen.queryByText("37")).not.toBeInTheDocument();
    }
    fireEvent.click(retry);
    expect(await screen.findByText("12")).toBeVisible();
  },
);

it.each([503, 403, 409, 429])(
  "handles a %s during refresh of a previously loaded HubSpot summary",
  async (status) => {
    const widget = {
      id: "summary-refresh",
      kind: "summary" as const,
      apiBasePath: "/v1/studio/14",
      collection: "hubspot_contacts",
    };
    let reads = 0;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [
            {
              name: widget.collection,
              config: {
                studio: { collection: { kind: "crm", sourceId: "hubspot" } },
              },
            },
          ],
        };
      if (path.endsWith("/summary")) {
        reads++;
        if (reads === 2)
          throw new ApiClientError(
            status,
            status === 409 ? "HUBSPOT_CONNECTION_UNAVAILABLE" : "READ_FAILED",
            "Refresh failed",
          );
        return { data: [], total: reads === 1 ? 37 : 12 };
      }
      throw new Error(`Unexpected endpoint: ${path}`);
    });
    const apiClient = { get } as never;
    const { rerender } = render(
      <SummaryWidgetBody apiClient={apiClient} widget={widget} />,
    );
    expect(await screen.findByText("37")).toBeVisible();

    rerender(
      <SummaryWidgetBody apiClient={apiClient} widget={{ ...widget }} />,
    );
    const retry = await screen.findByRole("button", { name: "Reintentar" });
    if (status === 503 || status === 429) {
      expect(screen.getByText("37")).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent(
        status === 429
          ? "HubSpot alcanzó el límite de solicitudes. Reintenta más tarde."
          : "No pudimos cargar este resumen.",
      );
    } else {
      expect(screen.queryByText("37")).not.toBeInTheDocument();
    }

    fireEvent.click(retry);
    expect(await screen.findByText("12")).toBeVisible();
  },
);

it.each([422, 403, 429])(
  "keeps the HubSpot total only when the breakdown is rejected with %s",
  async (status) => {
    const apiBasePath = "/v1/studio/14";
    const widget = {
      id: "contacts-summary-fallback",
      title: "Contactos",
      kind: "summary" as const,
      apiBasePath,
      collection: "hubspot_contacts",
      config: { statusField: "lifecyclestage" },
    };
    const summaryPath = `${apiBasePath}/api/records/${widget.collection}/summary`;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [
            {
              name: widget.collection,
              config: {
                fields: { lifecyclestage: { type: "Dropdown" } },
                studio: { collection: { kind: "crm", sourceId: "hubspot" } },
              },
            },
          ],
        };
      if (path === `${summaryPath}?group=lifecyclestage`)
        throw new ApiClientError(
          status,
          "CRM_SUMMARY_UNAVAILABLE",
          "Breakdown unavailable",
        );
      if (path === summaryPath) return { data: [], total: 6 };
      throw new Error(`Unexpected endpoint: ${path}`);
    });
    render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

    if (status === 422) {
      expect(await screen.findByText("6")).toBeVisible();
      expect(
        screen.getByText("El desglose por estado no está disponible."),
      ).toBeVisible();
      expect(get).toHaveBeenCalledWith(summaryPath, expect.anything());
    } else {
      expect(
        await screen.findByText(
          status === 429
            ? "HubSpot alcanzó el límite de solicitudes. Reintenta más tarde."
            : "No pudimos cargar este resumen.",
        ),
      ).toBeVisible();
      expect(get).not.toHaveBeenCalledWith(summaryPath, expect.anything());
    }
  },
);

it("skips live HubSpot summary refreshes during Retry-After", async () => {
  const widget = {
    id: "hubspot-summary-rate-limit",
    kind: "summary" as const,
    apiBasePath: "/v1/studio/14",
    collection: "hubspot_contacts",
  };
  const now = Date.parse("2031-01-01T12:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let reads = 0;
  const apiClient = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => "test" },
    fetcher: async (url) => {
      if (String(url).endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: widget.collection,
              config: {
                studio: { collection: { kind: "crm", sourceId: "hubspot" } },
              },
            },
          ],
        });
      if (++reads === 1)
        return Response.json(
          { error: "Rate limit" },
          {
            status: 429,
            headers: { "Retry-After": "30" },
          },
        );
      return Response.json({ data: [], total: 6 });
    },
  });
  try {
    render(<SummaryWidgetBody apiClient={apiClient} widget={widget} />);
    await screen.findByRole("button", { name: "Reintentar" });
    const subscription = subscribe.mock.calls
      .filter(([options]) => options.topics.includes("records"))
      .at(-1)?.[0];
    expect(subscription).toBeDefined();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const notify = async () => {
      await act(async () => {
        subscription?.onEvent({
          topic: "records",
          type: "updated",
          collection: widget.collection,
        });
        await vi.advanceTimersByTimeAsync(200);
      });
    };
    await notify();
    expect(reads).toBe(1);
    expect(screen.getByText(/Puedes reintentar a partir de/)).toBeVisible();
    clock.mockReturnValue(now + 30_000);
    await notify();
    await act(async () => {});
    expect(reads).toBe(2);
    expect(screen.getByText("6")).toBeVisible();
  } finally {
    vi.useRealTimers();
    clock.mockRestore();
  }
});

it.each([false, true])(
  "enforces HubSpot Retry-After for a manual retry (cached summary: %s)",
  async (cached) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2031-01-01T12:00:00Z"));
    const widget = {
      id: "contacts-manual-retry",
      kind: "summary" as const,
      apiBasePath: "/v1/studio/14",
      collection: "hubspot_contacts",
    };
    const rateLimitedRead = cached ? 2 : 1;
    let reads = 0;
    const apiClient = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async (url) => {
        if (String(url).endsWith("/objects"))
          return Response.json({
            data: [
              {
                name: widget.collection,
                config: {
                  studio: { collection: { kind: "crm", sourceId: "hubspot" } },
                },
              },
            ],
          });
        if (++reads === rateLimitedRead)
          return Response.json(
            { error: "Rate limit" },
            { status: 429, headers: { "Retry-After": "30" } },
          );
        return Response.json({
          data: [],
          total: reads < rateLimitedRead ? 37 : 6,
        });
      },
    });
    try {
      const view = render(
        <SummaryWidgetBody apiClient={apiClient} widget={widget} />,
      );
      await act(async () => {});
      if (cached) {
        expect(screen.getByText("37")).toBeVisible();
        await act(async () => {
          view.rerender(
            <SummaryWidgetBody apiClient={apiClient} widget={{ ...widget }} />,
          );
        });
      }

      const retry = () => screen.getByRole("button", { name: "Reintentar" });
      expect(retry()).toBeDisabled();
      expect(screen.getByText(/Puedes reintentar a partir de/)).toBeVisible();
      if (cached) expect(screen.getByText("37")).toBeVisible();
      await act(async () => {
        fireEvent.click(retry());
        view.rerender(
          <SummaryWidgetBody apiClient={apiClient} widget={{ ...widget }} />,
        );
        await vi.advanceTimersByTimeAsync(29_999);
      });
      expect(reads).toBe(rateLimitedRead);
      expect(retry()).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(retry()).toBeEnabled();
      expect(reads).toBe(rateLimitedRead);
      await act(async () => {
        fireEvent.click(retry());
      });
      expect(reads).toBe(rateLimitedRead + 1);
      expect(screen.getByText("6")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(
  (
    [
      { kind: "items", Body: ItemsWidgetBody, hubspot: true },
      { kind: "chart", Body: ChartWidgetBody, hubspot: true },
      { kind: "actions", Body: ActionsWidgetBody, hubspot: false },
    ] as const
  ).flatMap((source) => [false, true].map((cached) => ({ ...source, cached }))),
)(
  "honors Retry-After for $kind reads with cached data $cached",
  async ({ kind, Body, hubspot, cached }) => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2031-01-01T12:00:00Z"));
    const widget = {
      id: `rate-limited-${kind}`,
      kind,
      apiBasePath: "/v1/studio/14",
      collection: hubspot ? "hubspot_contacts" : "tasks",
      config: { groupField: "status", dateField: "due" },
    };
    const rateLimitedRead = cached ? 2 : 1;
    let reads = 0;
    let schemaReads = 0;
    const apiClient = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => "test" },
      fetcher: async (url) => {
        if (String(url).endsWith("/objects")) {
          schemaReads++;
          return Response.json({
            data: [
              {
                name: widget.collection,
                config: {
                  fields: {
                    name: { type: "Textbox" },
                    status: { type: "Dropdown" },
                    priority: { type: "Dropdown" },
                    due: { type: "DateControl" },
                    expires: { type: "DateControl" },
                  },
                  ...(hubspot && {
                    studio: {
                      collection: {
                        kind: "crm",
                        sourceId: "hubspot",
                        capabilities: { sort: false },
                      },
                    },
                  }),
                },
              },
            ],
          });
        }
        if (++reads === rateLimitedRead)
          return Response.json(
            { error: "Rate limit" },
            { status: 429, headers: { "Retry-After": "30" } },
          );
        const label =
          reads < rateLimitedRead ? "Previous value" : "Updated value";
        return Response.json({
          data: [
            {
              id: "sample",
              name: label,
              value: label,
              count: 1,
              due: "2000-01-01",
              expires: "2000-01-02",
            },
          ],
          total: 1,
        });
      },
    });
    try {
      const view = render(<Body apiClient={apiClient} widget={widget} />);
      await act(async () => {});
      if (cached) {
        expect(screen.getByText("Previous value")).toBeVisible();
        await act(async () => {
          view.rerender(<Body apiClient={apiClient} widget={{ ...widget }} />);
        });
      }
      expect(reads).toBe(rateLimitedRead);
      const retry = () => screen.getByRole("button", { name: "Reintentar" });
      expect(retry()).toBeDisabled();
      expect(screen.getByText(/Puedes reintentar a partir de/)).toBeVisible();
      if (cached) expect(screen.getByText("Previous value")).toBeVisible();

      const subscription = subscribe.mock.calls
        .filter(([options]) => options.topics.includes("records"))
        .at(-1)?.[0];
      expect(subscription).toBeDefined();
      await act(async () => {
        fireEvent.click(retry());
        subscription?.onEvent({
          topic: "records",
          type: "updated",
          collection: widget.collection,
        });
        view.rerender(<Body apiClient={apiClient} widget={{ ...widget }} />);
        await vi.advanceTimersByTimeAsync(29_799);
      });
      expect(reads).toBe(rateLimitedRead);
      expect(retry()).toBeDisabled();

      const metadataSubscription = subscribe.mock.calls
        .filter(([options]) => options.topics.includes("studio"))
        .at(-1)?.[0];
      await act(async () => {
        metadataSubscription?.onEvent({ topic: "studio", type: "updated" });
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(schemaReads).toBe(2);
      expect(reads).toBe(rateLimitedRead);
      expect(retry()).toBeDisabled();

      const editedWidget = {
        ...widget,
        config: { groupField: "priority", dateField: "expires", limit: 3 },
      };
      await act(async () => {
        view.rerender(<Body apiClient={apiClient} widget={editedWidget} />);
      });
      expect(reads).toBe(rateLimitedRead);
      expect(retry()).toBeDisabled();
      expect(screen.queryByText("Previous value")).not.toBeInTheDocument();

      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(retry()).toBeEnabled();
      expect(reads).toBe(rateLimitedRead);
      await act(async () => {
        fireEvent.click(retry());
      });
      expect(reads).toBe(rateLimitedRead + 1);
      expect(screen.getByText("Updated value")).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each([503, 422, 403, 429])(
  "handles a %i from a local status breakdown independently of the list",
  async (status) => {
    const widget = {
      id: "local-summary",
      kind: "summary" as const,
      apiBasePath: "/v1/studio/14",
      collection: "contacts",
      config: { statusField: "status" },
    };
    let summaryReads = 0;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [
            {
              name: "contacts",
              config: { fields: { status: { type: "Dropdown" } } },
            },
          ],
        };
      if (path.includes("/summary?")) {
        if (++summaryReads === 1)
          throw new ApiClientError(
            status,
            "READ_FAILED",
            "Breakdown unavailable",
            undefined,
            status === 429 ? Date.now() + 30_000 : undefined,
          );
        return { data: [{ value: "Lead", count: 6 }] };
      }
      return { data: [{ id: "1" }], total: 6 };
    });
    render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

    if (status === 403) {
      expect(
        await screen.findByText("No pudimos cargar este resumen."),
      ).toBeVisible();
      expect(screen.queryByText("6")).not.toBeInTheDocument();
      return;
    }
    expect(await screen.findByText("6")).toBeVisible();
    expect(
      screen.getByText(/El desglose por estado no está disponible/),
    ).toBeVisible();
    if (status === 422) {
      expect(
        screen.queryByRole("button", { name: "Reintentar" }),
      ).not.toBeInTheDocument();
      return;
    }
    const retry = screen.getByRole("button", { name: "Reintentar" });
    if (status === 429) {
      expect(retry).toBeDisabled();
      fireEvent.click(retry);
      expect(summaryReads).toBe(1);
      return;
    }
    fireEvent.click(retry);
    expect(await screen.findByText("Lead")).toBeVisible();
    expect(
      screen.queryByText(/El desglose por estado no está disponible/),
    ).not.toBeInTheDocument();
    expect(summaryReads).toBe(2);
  },
);

it.each([
  {
    label: "an exact total",
    page: { data: [{ id: "1" }], total: 4 },
    message: "4",
  },
  {
    label: "a total below the returned rows",
    page: { data: [{ id: "1" }], total: 0 },
    message: "El total de registros no está disponible.",
  },
  {
    label: "an empty page with a continuation",
    page: { data: [], total: 0, pageInfo: { hasNextPage: true } },
    message: "El total de registros no está disponible.",
  },
  { label: "a confirmed zero", page: { data: [], total: 0 }, message: "0" },
  {
    label: "an incomplete page",
    page: { data: null, total: 0 },
    message: "No pudimos cargar este resumen.",
  },
])(
  "renders $label for a JSON:API summary using only the list capability",
  async ({ page, message }) => {
    const apiBasePath = "/v1/studio/14";
    const widget = {
      id: "linked-summary",
      kind: "summary" as const,
      apiBasePath,
      collection: "linked_contacts",
      config: { statusField: "status" },
    };
    const listPath = `${apiBasePath}/api/records/linked_contacts?page=1&perPage=1`;
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [
            {
              name: widget.collection,
              config: {
                fields: { status: { type: "Dropdown" } },
                studio: {
                  collection: {
                    kind: "jsonapi",
                    capabilities: { sort: false },
                  },
                },
              },
            },
          ],
        };
      if (path === listPath) return page;
      throw new ApiClientError(
        405,
        "UNSUPPORTED",
        "Unsupported grouped summary",
      );
    });
    render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);
    expect(await screen.findByText(message)).toBeVisible();
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      `${apiBasePath}/api/objects`,
      listPath,
    ]);
  },
);

it.each([
  {
    kind: "summary",
    Body: SummaryWidgetBody,
    perPage: 1,
    message: "El total de registros no está disponible.",
  },
  {
    kind: "items",
    Body: ItemsWidgetBody,
    perPage: 5,
    message: "Sample contact",
  },
  {
    kind: "chart",
    Body: ChartWidgetBody,
    perPage: undefined,
    message: "Esta fuente no admite gráficos por estado.",
  },
  {
    kind: "actions",
    Body: ActionsWidgetBody,
    perPage: undefined,
    message: "Esta fuente no permite ordenar los registros por vencimiento.",
  },
] as const)(
  "loads the Salesforce $kind widget without unsupported queries",
  async ({ kind, Body, perPage, message }) => {
    const apiBasePath = "/v1/studio/14";
    const collection = "salesforce_contacts";
    const widget = {
      id: `salesforce-${kind}`,
      title: "Contactos",
      kind,
      apiBasePath,
      collection,
      config: {
        statusField: "status",
        groupField: "status",
        dateField: "due",
      },
    };
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/objects"))
        return {
          data: [
            {
              name: collection,
              config: {
                fields: {
                  name: { type: "Textbox" },
                  status: { type: "Dropdown" },
                  due: { type: "DateControl" },
                },
                studio: {
                  collection: {
                    kind: "crm",
                    sourceId: "salesforce",
                    capabilities: { sort: false },
                  },
                },
              },
            },
          ],
        };
      if (
        perPage !== undefined &&
        path ===
          `${apiBasePath}/api/records/salesforce_contacts?page=1&perPage=${perPage}`
      )
        return { data: [{ id: "sample", name: "Sample contact" }] };
      throw new Error(`Unexpected endpoint: ${path}`);
    });

    render(<Body apiClient={{ get } as never} widget={widget} />);

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledTimes(perPage === undefined ? 1 : 2);
  },
);

it("renders a tenant ZIP widget through the dashboard card", async () => {
  const widget = {
    id: "plugin-widget",
    title: "Resumen",
    kind: "plugin:custom.demo:resumen",
    apiBasePath: "/v1/studio/0",
    collection: "contracts",
  };
  const apiClient = {
    get: vi.fn(async () => ({
      data: [
        {
          manifest: { id: "custom.demo" },
          builtIn: false,
          store: true,
          widgets: [
            {
              id: "resumen",
              collection: "contracts",
              title: { es: "Resumen" },
            },
          ],
          installed: { enabled: true },
        },
      ],
    })),
  };

  render(
    <WidgetCard
      apiClient={apiClient as never}
      widget={widget as never}
      collectionLabel="Contratos"
      onRemove={vi.fn()}
      onMove={vi.fn()}
      isFirst
      isLast
      disabled={false}
    />,
  );

  expect(await screen.findByTitle("Resumen")).toHaveAttribute(
    "src",
    expect.stringContaining("/api/plugin-store/custom.demo/widget"),
  );
});

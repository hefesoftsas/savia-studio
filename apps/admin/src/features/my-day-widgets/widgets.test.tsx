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

it.each([503, 403, 429])(
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
          throw new ApiClientError(status, "READ_FAILED", "Refresh failed");
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

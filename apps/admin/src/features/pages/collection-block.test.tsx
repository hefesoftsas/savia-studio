import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ApiClient } from "@/api/api-client";
import { CollectionBlock, type CollectionReference } from "./collection-block";

afterEach(cleanup);

it("returns to the last available page when refreshing an out-of-range page", async () => {
  let total = 21;
  const pages: string[] = [];
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => null },
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: "tasks",
              label: "Tasks",
              config: { fields: { title: { type: "Textbox" } } },
            },
          ],
        });
      const page = url.searchParams.get("page")!;
      pages.push(page);
      return Response.json({
        data:
          page === "2" && total === 1
            ? []
            : [
                {
                  id: page,
                  title: total === 1 ? "Remaining record" : `Page ${page}`,
                },
              ],
        total,
      });
    },
  });
  render(
    <CollectionBlock
      api={api}
      reference={{ domain: "/v1/studio/1", collection: "tasks", mode: "table" }}
    />,
  );

  expect(await screen.findByRole("link", { name: "Page 1" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  expect(await screen.findByRole("link", { name: "Page 2" })).toBeVisible();

  total = 1;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    await screen.findByRole("link", { name: "Remaining record" }),
  ).toBeVisible();
  expect(pages).toEqual(["1", "2", "2", "1"]);
  expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
});

it("keeps missing group values separate from a literal dash", async () => {
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => null },
    fetcher: async (input) => {
      if (new URL(String(input)).pathname.endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: "tasks",
              label: "Tasks",
              config: {
                fields: {
                  title: { type: "Textbox" },
                  stage: {
                    type: "Dropdown",
                    options: [{ value: "—", label: "Dash stage" }],
                  },
                },
              },
            },
          ],
        });
      return Response.json({
        data: [
          { id: "1", title: "Unset task", stage: null },
          { id: "2", title: "Dash task", stage: "—" },
          { id: "3", title: "Blank task", stage: "" },
        ],
        total: 3,
      });
    },
  });
  render(
    <CollectionBlock
      api={api}
      reference={{
        domain: "/v1/studio/1",
        collection: "tasks",
        mode: "pipeline",
      }}
    />,
  );

  const ungrouped = (
    await screen.findByRole("heading", { name: "No group" })
  ).closest("section")!;
  const dash = screen
    .getByRole("heading", { name: "Dash stage" })
    .closest("section")!;
  expect(
    within(ungrouped).getByRole("link", { name: "Unset task" }),
  ).toBeVisible();
  expect(
    within(ungrouped).getByRole("link", { name: "Blank task" }),
  ).toBeVisible();
  expect(within(dash).getByRole("link", { name: "Dash task" })).toBeVisible();
  expect(within(dash).queryByRole("link", { name: "Unset task" })).toBeNull();
});

it.each([
  { domain: "/v1/studio/2" },
  { collection: "other_tasks" },
  { viewId: "alternate" },
])(
  "starts a changed collection reference on the first page (%j)",
  async (change) => {
    const requests: URL[] = [];
    const collection = {
      label: "Tasks",
      config: { fields: { title: { type: "Textbox" } } },
    };
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => null },
      fetcher: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/objects"))
          return Response.json({
            data: [
              { ...collection, name: "tasks" },
              { ...collection, name: "other_tasks" },
            ],
          });
        if (url.pathname.includes("/views/"))
          return Response.json({
            data: [
              { id: "initial", config: { q: "initial" } },
              { id: "alternate", config: { q: "alternate" } },
            ],
          });
        requests.push(url);
        const page = url.searchParams.get("page");
        const title =
          requests.length < 3
            ? `Original page ${page}`
            : `Changed page ${page}`;
        return Response.json({ data: [{ id: page, title }], total: 40 });
      },
    });
    const reference: CollectionReference = {
      domain: "/v1/studio/1",
      collection: "tasks",
      viewId: "initial",
      mode: "table",
    };
    const { rerender } = render(
      <CollectionBlock api={api} reference={reference} />,
    );
    expect(
      await screen.findByRole("link", { name: "Original page 1" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(
      await screen.findByRole("link", { name: "Original page 2" }),
    ).toBeVisible();

    const changed = { ...reference, ...change };
    rerender(<CollectionBlock api={api} reference={changed} />);
    expect(
      await screen.findByRole("link", { name: "Changed page 1" }),
    ).toBeVisible();
    expect(requests.map((url) => url.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
    ]);
    expect(requests[2].pathname).toBe(
      `${changed.domain}/api/records/${changed.collection}`,
    );
    expect(requests[2].searchParams.get("q")).toBe(changed.viewId);
  },
);

it("applies the saved view's filters and search field to the viewer's record request", async () => {
  const urls: URL[] = [];
  const filters = {
    logic: "and",
    conditions: [{ field: "status", op: "eq", value: "open" }],
  };
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => null },
    fetcher: async (input) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("objects"))
        return Response.json({
          data: [
            {
              name: "tasks",
              label: "Tasks",
              config: {
                fields: {
                  title: { type: "Text" },
                  status: { type: "Dropdown" },
                },
                studio: { pipeline: { field: "status" } },
              },
            },
          ],
        });
      if (url.pathname.includes("/views/"))
        return Response.json({
          data: [
            {
              id: "active",
              config: {
                q: "launch",
                searchField: "title",
                filters,
                group: "",
                columns: ["title"],
                sort: { field: "title", order: "ASC" },
              },
            },
          ],
        });
      return Response.json({
        data: [{ id: "1", title: "Launch app", status: "open" }],
        total: 1,
      });
    },
  });
  render(
    <CollectionBlock
      api={api}
      reference={{
        domain: "/v1/studio/1",
        collection: "tasks",
        viewId: "active",
        mode: "pipeline",
      }}
    />,
  );
  expect(await screen.findByRole("link", { name: "Launch app" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "open" })).toBeVisible();
  const request = urls.find((url) => url.pathname.includes("/records/"))!;
  expect(request.searchParams.get("searchField")).toBe("title");
  expect(JSON.parse(request.searchParams.get("filters")!)).toEqual(filters);
  expect(request.searchParams.get("sort")).toBe("title");
});
it("does not fetch records when the saved view is unavailable to the viewer", async () => {
  const paths: string[] = [];
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => null },
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Response.json({
        data: path.endsWith("objects")
          ? [{ name: "tasks", label: "Tasks", config: { fields: {} } }]
          : [],
      });
    },
  });
  render(
    <CollectionBlock
      api={api}
      reference={{
        domain: "/v1/studio/1",
        collection: "tasks",
        viewId: "missing",
        mode: "table",
      }}
    />,
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not load");
  expect(paths.some((path) => path.includes("/records/"))).toBe(false);
});

it("shows only selected columns in the saved order and with saved labels", async () => {
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => null },
    fetcher: async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: "tasks",
              label: "Tasks",
              config: {
                fields: {
                  title: { type: "Textbox", label: "Title" },
                  status: { type: "Dropdown", label: "Status" },
                  notes: { type: "Textbox", label: "Notes" },
                },
              },
            },
          ],
        });
      if (path.includes("/views/"))
        return Response.json({
          data: [
            {
              id: "saved",
              config: {
                columns: ["title", "status"],
                columnOrder: ["notes", "status", "title"],
                columnAliases: { status: "Stage", title: "Task" },
              },
            },
          ],
        });
      return Response.json({
        data: [
          { id: "1", title: "Launch app", status: "open", notes: "Internal" },
        ],
        total: 1,
      });
    },
  });
  render(
    <CollectionBlock
      api={api}
      reference={{
        domain: "/v1/studio/1",
        collection: "tasks",
        viewId: "saved",
        mode: "table",
      }}
    />,
  );

  expect(
    (await screen.findAllByRole("columnheader")).map(
      (header) => header.textContent,
    ),
  ).toEqual(["Stage", "Task"]);
  expect(screen.getByRole("link", { name: "open" })).toBeVisible();
  expect(screen.queryByText("Internal")).toBeNull();
});

it("uses the connected CRM's supported search and pagination without requiring a total", async () => {
  const requests: URL[] = [];
  const api = new ApiClient({
    baseUrl: "https://savia.test",
    tokenSource: { getAccessToken: async () => null },
    fetcher: async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/objects"))
        return Response.json({
          data: [
            {
              name: "zoho_contacts",
              label: "Contacts",
              config: {
                fields: { name: { type: "Textbox" } },
                studio: {
                  collection: {
                    kind: "crm",
                    sourceId: "zoho",
                    capabilities: { search: true, filter: false, sort: false },
                  },
                },
              },
            },
          ],
        });
      if (url.pathname.includes("/views/"))
        return Response.json({
          data: [
            {
              id: "saved",
              config: {
                q: "Ana",
                searchField: "name",
                stage: "active",
                sort: { field: "name", order: "ASC" },
                filters: {
                  conditions: [{ field: "name", op: "eq", value: "Ana" }],
                },
              },
            },
          ],
        });
      requests.push(url);
      if (
        ["sort", "order", "filters", "stage", "searchField"].some((parameter) =>
          url.searchParams.has(parameter),
        )
      )
        return Response.json(
          { error: "Unsupported CRM query" },
          { status: 422 },
        );
      const page = url.searchParams.get("page");
      return Response.json({
        data: [{ id: page, name: "Ana " + page }],
        ...(page === "2" ? { total: 100 } : {}),
        pageInfo: { hasNextPage: page === "1" },
      });
    },
  });
  render(
    <CollectionBlock
      api={api}
      reference={{
        domain: "/v1/studio/1",
        collection: "zoho_contacts",
        viewId: "saved",
        mode: "table",
      }}
    />,
  );

  expect(await screen.findByRole("link", { name: "Ana 1" })).toBeVisible();
  const next = screen.getByRole("button", { name: "Next" });
  expect(next).toBeEnabled();
  fireEvent.click(next);
  expect(await screen.findByRole("link", { name: "Ana 2" })).toBeVisible();
  expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  expect(requests.map(({ searchParams }) => searchParams.get("q"))).toEqual([
    "Ana",
    "Ana",
  ]);
});

it.each(["table", "pipeline"] as const)(
  "keeps records openable when the saved %s has no displayable columns",
  async (mode) => {
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => null },
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/objects"))
          return Response.json({
            data: [
              {
                name: "tasks",
                label: "Tasks",
                config: {
                  fields: {
                    title: { type: "Textbox", hidden: true },
                    status: { type: "Dropdown" },
                  },
                },
              },
            ],
          });
        if (path.includes("/views/"))
          return Response.json({
            data: [
              {
                id: "saved",
                config: { columns: ["title", "old_field"] },
              },
            ],
          });
        return Response.json({
          data: [{ id: "task-1", title: "Hidden title", status: "open" }],
          total: 1,
        });
      },
    });
    render(
      <CollectionBlock
        api={api}
        reference={{
          domain: "/v1/studio/1",
          collection: "tasks",
          viewId: "saved",
          mode,
        }}
      />,
    );

    const record = await screen.findByRole("link", { name: "task-1" });
    expect(record).toHaveAttribute(
      "href",
      "#/studio?tenantId=1&object=tasks&record=task-1",
    );
    expect(screen.queryByText("Hidden title")).toBeNull();
    expect(screen.queryByRole("table")).toBeNull();
  },
);

it.each([
  { group: "removed", publicStage: true },
  { group: "internal", publicStage: true },
  { group: "internal", publicStage: false },
])(
  "uses only available grouping fields in an embedded board ($group, $publicStage)",
  async ({ group, publicStage }) => {
    const api = new ApiClient({
      baseUrl: "https://savia.test",
      tokenSource: { getAccessToken: async () => null },
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/objects"))
          return Response.json({
            data: [
              {
                name: "tasks",
                label: "Tasks",
                config: {
                  fields: {
                    title: { type: "Textbox", label: "Title" },
                    internal: { type: "Dropdown", hidden: true },
                    ...(publicStage
                      ? {
                          status: {
                            type: "Dropdown",
                            options: [{ value: "open", label: "Open tasks" }],
                          },
                        }
                      : {}),
                  },
                  studio: { pipeline: { field: "internal" } },
                },
              },
            ],
          });
        if (path.includes("/views/"))
          return Response.json({
            data: [{ id: "saved", config: { group, columns: ["title"] } }],
          });
        return Response.json({
          data: [
            {
              id: "task-1",
              title: "Launch app",
              internal: "Private group",
              status: "open",
            },
          ],
          total: 1,
        });
      },
    });
    render(
      <CollectionBlock
        api={api}
        reference={{
          domain: "/v1/studio/1",
          collection: "tasks",
          viewId: "saved",
          mode: "pipeline",
        }}
      />,
    );

    expect(
      await screen.findByRole("link", { name: "Launch app" }),
    ).toBeVisible();
    if (publicStage)
      expect(screen.getByRole("heading", { name: "Open tasks" })).toBeVisible();
    else expect(screen.getByRole("table")).toBeVisible();
    expect(screen.queryByText("Private group")).toBeNull();
  },
);

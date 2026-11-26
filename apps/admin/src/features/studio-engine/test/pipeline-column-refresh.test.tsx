import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  CoreAdminContext,
  testDataProvider,
  type GetListParams,
} from "ra-core";
import { makeConfig, type StudioObject } from "@savia/studio-shared/metadata";
import { api } from "../api";
import Records, { PipelineColumn } from "../records";
import { setStudioRuntime } from "../runtime";
import { createStudioQueryClient } from "../studio-query-cache";
import { render as renderWithLocale } from "./locale-test-render";

vi.mock("../api", () => ({ api: vi.fn() }));

const object = {
  name: "pipeline_quotes",
  label: "Quotes",
  description: "",
  config: {
    ...makeConfig({
      name: { type: "Textbox", label: "Name" },
      stage: {
        type: "Dropdown",
        label: "Stage",
        options: [{ value: "open", label: "Open" }],
      },
    }),
    studio: { pipeline: { field: "stage" } },
  },
};
const settings = {
  q: "",
  searchField: "",
  stage: "",
  filters: { logic: "and" as const, conditions: [] },
  columns: ["name"],
  columnOrder: ["name"],
  columnAliases: {},
  sort: { field: "name", order: "ASC" as const },
  group: "",
  mode: "pipeline" as const,
  perPage: 25,
};
const record = { id: "quote-1", name: "Draft", stage: "" };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  setStudioRuntime({});
});

function mount(client = createStudioQueryClient()) {
  renderWithLocale(
    <QueryClientProvider client={client}>
      <PipelineColumn
        object={object}
        settings={settings}
        stage=""
        label="Sin etapa"
        onOpen={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return client;
}

it("keeps linked collections in table mode when opening older pipeline views", async () => {
  const linked: StudioObject = {
    ...object,
    config: {
      ...object.config,
      studio: {
        ...object.config.studio,
        collection: {
          kind: "jsonapi",
          sourceId: "remote",
          resource: "/quotes",
          capabilities: {
            list: true,
            read: true,
            create: false,
            update: false,
            delete: false,
            schema: false,
            customFields: false,
            filter: true,
            sort: true,
            search: true,
          },
        },
      },
    },
  };
  vi.mocked(api).mockImplementation(async (path) =>
    path.startsWith("/views/")
      ? {
          data: [
            {
              id: "legacy-view",
              name: "Legacy view",
              config: {
                mode: "pipeline",
                stage: "open",
                sort: { field: "stage", order: "ASC" },
              },
            },
          ],
        }
      : { data: [], total: 0 },
  );
  const getList = vi.fn(async (_resource: string, _params: GetListParams) => ({
    data: [],
    total: 0,
  }));
  renderWithLocale(
    <CoreAdminContext
      dataProvider={testDataProvider({ getList })}
      queryClient={createStudioQueryClient()}
    >
      <Records object={linked} onOpen={vi.fn()} />
    </CoreAdminContext>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Legacy view" }));
  expect(
    screen.queryByRole("button", { name: "Pipeline" }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(getList.mock.calls.at(-1)?.[1].sort).toEqual({
      field: "stage",
      order: "ASC",
    }),
  );
  expect(getList.mock.calls.at(-1)?.[1].filter?.stage).toBeFalsy();
  expect(
    vi.mocked(api).mock.calls.filter(([path]) => path.startsWith("/records/")),
  ).toEqual([]);
});

it("keeps a loaded pipeline card visible when a same-scope refresh fails transiently", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [record], total: 1 })
    .mockRejectedValueOnce(new Error("Temporary pipeline refresh failure"));
  const client = mount();
  expect(await screen.findByLabelText("Etapa de Draft")).toBeVisible();

  void client.invalidateQueries({ queryKey: ["pipeline", "pipeline_quotes"] });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Temporary pipeline refresh failure",
  );
  expect(screen.getByLabelText("Etapa de Draft")).toBeVisible();
});

it("returns to the last available page after moving the only card on the current page", async () => {
  let records = Array.from({ length: 41 }, (_, index) => ({
    id: `quote-${index + 1}`,
    name: `Quote ${index + 1}`,
    stage: "",
    _version: 1,
  }));
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === "PATCH") {
      records = records.filter(({ id }) => id !== "quote-41");
      return { data: { id: "quote-41", stage: "open", _version: 2 } };
    }
    const query = new URL(path, "http://localhost").searchParams;
    const page = Number(query.get("page"));
    const perPage = Number(query.get("perPage"));
    return {
      total: records.length,
      data: records.slice((page - 1) * perPage, page * perPage),
    };
  });

  mount();
  await screen.findByLabelText("Etapa de Quote 1");
  fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
  await screen.findByLabelText("Etapa de Quote 21");
  fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
  fireEvent.change(await screen.findByLabelText("Etapa de Quote 41"), {
    target: { value: "open" },
  });

  expect(await screen.findByLabelText("Etapa de Quote 21")).toBeVisible();
  expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();
  expect(vi.mocked(api)).toHaveBeenCalledWith(
    "/records/pipeline_quotes/quote-41",
    "PATCH",
    { stage: "open", _version: 1 },
  );
});

it("skips a drop in the current stage and refreshes only related reads after moving", async () => {
  const client = createStudioQueryClient();
  const affected = ["summary", object.name];
  const unrelated = ["summary", "unrelated_collection"];
  client.setQueryData(affected, { total: 1 });
  client.setQueryData(unrelated, { total: 9 });
  let current: string | null = null;
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (method === "PATCH") {
      current = "open";
      return { data: { ...record, stage: current, _version: 8 } };
    }
    const stage = new URL(path, "http://localhost").searchParams.get("stage");
    const data =
      stage === (current ?? "")
        ? [{ ...record, stage: current, _version: current === null ? 7 : 8 }]
        : [];
    return { data, total: data.length };
  });
  renderWithLocale(
    <QueryClientProvider client={client}>
      <PipelineColumn
        object={object}
        settings={settings}
        stage=""
        label="Sin etapa"
        onOpen={vi.fn()}
      />
      <PipelineColumn
        object={object}
        settings={settings}
        stage="open"
        label="Open"
        onOpen={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const card = (await screen.findByRole("button", { name: "Draft" })).closest(
    "article",
  )!;
  const destination = screen
    .getByText("Open", { selector: "strong" })
    .closest("section")!;
  const values = new Map<string, string>();
  const dataTransfer = {
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? "",
  };
  fireEvent.dragStart(card, { dataTransfer });
  fireEvent.drop(card.closest("section")!, { dataTransfer });
  expect(
    vi.mocked(api).mock.calls.filter(([, method]) => method === "PATCH"),
  ).toEqual([]);

  fireEvent.drop(destination, { dataTransfer });
  expect(vi.mocked(api)).toHaveBeenCalledWith(
    "/records/pipeline_quotes/quote-1",
    "PATCH",
    { stage: "open", _version: 7 },
  );
  expect(
    await within(destination).findByRole("button", { name: "Draft" }),
  ).toBeVisible();
  expect(client.getQueryState(affected)?.isInvalidated).toBe(true);
  expect(client.getQueryState(unrelated)?.isInvalidated).toBe(false);
});

it.each(["conflict", "lost response"] as const)(
  "refreshes the source and destination after a move reports a %s",
  async (failure) => {
    const before = { ...record, _version: 7 };
    let saved = before;
    vi.mocked(api).mockImplementation(async (path, method) => {
      if (method === "PATCH") {
        if (failure === "conflict") {
          saved = { ...before, name: "Edited draft", _version: 8 };
          throw Object.assign(new Error("Record changed"), { status: 409 });
        }
        saved = { ...before, stage: "open", _version: 8 };
        throw new TypeError("Connection closed");
      }
      const stage = new URL(path, "http://localhost").searchParams.get("stage");
      const data = stage === saved.stage ? [saved] : [];
      return { data, total: data.length };
    });
    renderWithLocale(
      <QueryClientProvider client={createStudioQueryClient()}>
        {[
          { stage: "", label: "Sin etapa" },
          { stage: "open", label: "Open" },
        ].map(({ stage, label }) => (
          <PipelineColumn
            key={stage}
            object={object}
            settings={settings}
            stage={stage}
            label={label}
            onOpen={vi.fn()}
          />
        ))}
      </QueryClientProvider>,
    );
    const draft = await screen.findByRole("button", { name: "Draft" });
    const source = within(draft.closest("section")!);
    const destination = screen
      .getByText("Open", { selector: "strong" })
      .closest("section")!;
    fireEvent.drop(destination, {
      dataTransfer: {
        getData: () => JSON.stringify({ object: object.name, record: before }),
      },
    });

    if (failure === "conflict") {
      expect(
        await source.findByRole("button", { name: "Edited draft" }),
      ).toBeVisible();
    } else {
      expect(
        await within(destination).findByRole("button", { name: "Draft" }),
      ).toBeVisible();
    }
    await waitFor(() =>
      expect(
        source.queryByRole("button", { name: "Draft" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      vi.mocked(api).mock.calls.filter(([, method]) => method === "PATCH"),
    ).toHaveLength(1);
  },
);

it.each(["search", "sort"] as const)(
  "requests only page one when the pipeline %s changes",
  async (change) => {
    const client = createStudioQueryClient();
    vi.mocked(api).mockImplementation(async (path) => {
      const query = new URL(path, "http://localhost").searchParams;
      const changed =
        query.get("q") === "Quote" || query.get("order") === "DESC";
      const page = query.get("page");
      return {
        data: [
          { ...record, name: `${changed ? "Updated" : "Original"} ${page}` },
        ],
        total: 41,
      };
    });
    const column = (
      value: Parameters<typeof PipelineColumn>[0]["settings"],
    ) => (
      <QueryClientProvider client={client}>
        <PipelineColumn
          object={object}
          settings={value}
          stage=""
          label="Sin etapa"
          onOpen={vi.fn()}
        />
      </QueryClientProvider>
    );
    const { rerender } = renderWithLocale(column(settings));
    await screen.findByLabelText("Etapa de Original 1");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByLabelText("Etapa de Original 2");
    vi.mocked(api).mockClear();

    rerender(
      column(
        change === "search"
          ? { ...settings, q: "Quote" }
          : { ...settings, sort: { ...settings.sort, order: "DESC" } },
      ),
    );

    expect(await screen.findByLabelText("Etapa de Updated 1")).toBeVisible();
    expect(
      vi
        .mocked(api)
        .mock.calls.map(([path]) =>
          new URL(path, "http://localhost").searchParams.get("page"),
        ),
    ).toEqual(["1"]);
  },
);

it("removes a cached pipeline card after same-scope authorization is denied", async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [record], total: 1 })
    .mockRejectedValueOnce(
      Object.assign(new Error("Pipeline access revoked"), { status: 403 }),
    );
  const client = mount();
  expect(await screen.findByLabelText("Etapa de Draft")).toBeVisible();

  void client.invalidateQueries({ queryKey: ["pipeline", "pipeline_quotes"] });

  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Pipeline access revoked",
  );
  await waitFor(() =>
    expect(
      client.getQueryCache().findAll({
        queryKey: ["pipeline", "pipeline_quotes"],
      })[0]?.state.data,
    ).toBeUndefined(),
  );
  expect(screen.queryByLabelText("Etapa de Draft")).not.toBeInTheDocument();
});

// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import Root from "../app";
import { makeConfig } from "@savia/studio-shared/metadata";
import { api } from "../api";
import { ApiClientError } from "@/api/api-client";
import { getStudioRuntime, setStudioRuntime } from "../runtime";
import { createStudioQueryClient } from "../studio-query-cache";
const state = vi.hoisted(() => ({
  object: undefined as any,
  objects: undefined as
    | Array<{
        name: string;
        label: string;
        config: ReturnType<typeof makeConfig>;
      }>
    | undefined,
  source: { id: "source", name: "Original", email: "unique", _version: 7 },
  form: undefined as any,
}));
vi.mock("../generated/studio", () => ({
  useListObjects: () => ({
    data: { data: state.objects ?? [state.object] },
    isSuccess: true,
  }),
  getListObjectsQueryKey: () => ["objects"],
}));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  dataProvider: { getList: async () => ({ data: [], total: 0 }) },
  api: vi.fn(),
  studioFetch: vi.fn(),
  downloadCrm: vi.fn(),
}));
vi.mock("../records", () => ({ default: () => <div>Record list</div> }));
vi.mock("../record-detail", () => ({
  default: ({ onDuplicate, onEdit, record }: any) => (
    <>
      <button onClick={() => onDuplicate(state.source)}>
        Duplicate source
      </button>
      <button onClick={() => onEdit(record)}>Edit source</button>
    </>
  ),
}));
vi.mock("../collection-record-form", () => ({
  default: (props: any) => {
    state.form = props;
    return (
      <>
        <input aria-label="Copy name" defaultValue={props.values.name} />
        <button onClick={props.onCancel}>Cancel copy</button>
        <button
          onClick={async () => props.onSaved(await props.onSave(props.values))}
        >
          Save copy
        </button>
      </>
    );
  },
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.objects = undefined;
  setStudioRuntime({});
  window.history.replaceState(null, "", "/");
});

const sourceEditorLink = "object=contacts&view=edit&record=shared";
const targetEditorLink = "object=projects&view=edit&record=shared";
const sourceRecord = { id: "shared", name: "Contact name", _version: 1 };
const targetRecord = { id: "shared", name: "Project name", _version: 4 };

function prepareEditors() {
  const config = {
    ...makeConfig({ name: { type: "Textbox", label: "Name" } }),
    studio: { screen: { editMode: "page" as const } },
  };
  state.objects = [
    { name: "contacts", label: "Contacts", config },
    { name: "projects", label: "Projects", config },
  ];
  const navigate = vi.fn();
  setStudioRuntime({ embedded: true, businessSetupEnabled: false, navigate });
  return navigate;
}

it.each(["loading", "cached"])(
  "opens a different collection's %s record with a fresh editor",
  async (status) => {
    const navigate = prepareEditors();
    const client = createStudioQueryClient();
    let loadTarget!: (result: { data: typeof targetRecord }) => void;
    const waiting = new Promise<{ data: typeof targetRecord }>((resolve) => {
      loadTarget = resolve;
    });
    vi.mocked(api).mockImplementation(async (path, method) => {
      if (path === "/records/contacts/shared") return { data: sourceRecord };
      if (path === "/records/projects/shared")
        return method === "PATCH" ? { data: targetRecord } : waiting;
      return { data: [] };
    });
    const { rerender } = render(
      <Root
        embedded
        search="object=contacts&view=records&record=shared"
        queryClient={client}
      />,
    );
    fireEvent.click(await screen.findByText("Edit source"));
    const oldInput = await screen.findByLabelText("Copy name");
    const staleSave = state.form.onSave;
    fireEvent.change(oldInput, { target: { value: "Draft from contacts" } });

    if (status === "cached")
      client.setQueryData(["open-record", "projects", "shared"], {
        data: targetRecord,
      });
    rerender(<Root embedded search={targetEditorLink} queryClient={client} />);
    expect(oldInput).not.toBeInTheDocument();
    if (status === "loading")
      expect(screen.queryByText("Save copy")).not.toBeInTheDocument();
    await expect(staleSave({ name: "Draft from contacts" })).rejects.toThrow();
    await act(async () => loadTarget({ data: targetRecord }));
    const input = await screen.findByLabelText("Copy name");
    expect(input).toHaveValue("Project name");
    rerender(
      <Root
        embedded
        search={`${targetEditorLink}&tab=details`}
        queryClient={client}
      />,
    );
    expect(screen.getByLabelText("Copy name")).toBe(input);
    fireEvent.click(screen.getByText("Save copy"));
    await waitFor(() =>
      expect(vi.mocked(api)).toHaveBeenCalledWith(
        "/records/projects/shared",
        "PATCH",
        { ...targetRecord },
        {},
      ),
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.some(
          ([path, method]) =>
            path === "/records/contacts/shared" && method === "PATCH",
        ),
    ).toBe(false);
    expect(navigate).toHaveBeenLastCalledWith(
      "object=projects&view=records",
      false,
    );
  },
);

it("does not navigate away from the current editor when an earlier save completes", async () => {
  const navigate = prepareEditors();
  const client = createStudioQueryClient();
  let finishSave!: (response: { data: typeof sourceRecord }) => void;
  const saving = new Promise<{ data: typeof sourceRecord }>((resolve) => {
    finishSave = resolve;
  });
  vi.mocked(api).mockImplementation(async (path, method) => {
    if (path === "/records/contacts/shared")
      return method === "PATCH" ? saving : { data: sourceRecord };
    if (path === "/records/projects/shared") return { data: targetRecord };
    return { data: [] };
  });
  const { rerender } = render(
    <Root embedded search={sourceEditorLink} queryClient={client} />,
  );
  fireEvent.click(await screen.findByText("Save copy"));
  expect(vi.mocked(api)).toHaveBeenCalledWith(
    "/records/contacts/shared",
    "PATCH",
    { ...sourceRecord },
    {},
  );

  rerender(<Root embedded search={targetEditorLink} queryClient={client} />);
  await waitFor(() =>
    expect(screen.getByLabelText("Copy name")).toHaveValue("Project name"),
  );
  await act(async () => finishSave({ data: sourceRecord }));
  expect(screen.getByLabelText("Copy name")).toHaveValue("Project name");
  expect(navigate).not.toHaveBeenCalled();
});

it("uses the original workspace when an editor attaches or discards a draft after navigation", async () => {
  prepareEditors();
  const draft = {
    id: "draft-1",
    field: "contract",
    name: "contract.pdf",
    mime: "application/pdf",
    size: 8,
    version: 1,
    expiresAt: "2026-09-10T00:00:00.000Z",
  };
  const transport = () =>
    vi.fn(async (path: string) =>
      Response.json(path === "/api/bootstrap" ? { ok: true } : { data: draft }),
    );
  const original = transport();
  const next = transport();
  const runtime = getStudioRuntime();
  setStudioRuntime({ ...runtime, tenantId: 1, transport: original });
  vi.mocked(api).mockResolvedValue({ data: sourceRecord });
  const view = render(
    <Root
      embedded
      search={sourceEditorLink}
      queryClient={createStudioQueryClient()}
    />,
  );
  await screen.findByLabelText("Copy name");
  const previousForm = state.form;

  view.unmount();
  setStudioRuntime({ ...runtime, tenantId: 2, transport: next });
  await previousForm.onPersistTemporaryAttachments(sourceRecord, [draft]);
  await previousForm.onDiscardTemporaryAttachments([draft]);

  expect(original.mock.calls.map(([path]) => path)).toEqual([
    "/api/bootstrap",
    "/api/file-drafts/draft-1/attach",
    "/api/file/draft-1",
  ]);
  expect(next).not.toHaveBeenCalled();
});

it.each([true, false])(
  "retries an interrupted backend create (attachment retained: %s)",
  async (retained) => {
    prepareEditors();
    const server = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/file-drafts/contacts")
        return Response.json({ data: { id: "draft", version: 1 } });
      if (path.endsWith("/attach"))
        return Response.json({ data: { id: "draft" } });
      const creates = server.mock.calls.filter(
        ([url]) => url === "/api/records/contacts",
      );
      return creates.length === 1
        ? Response.json({ error: "Connection lost" }, { status: 503 })
        : Response.json({ data: sourceRecord }, { status: 201 });
    });
    const syncNow = vi.fn().mockResolvedValue(undefined);
    const workspace = {
      scope: "fixture",
      store: { subscribeQueryChanges: () => () => {} },
      syncNow,
    } as unknown as ReturnType<typeof getStudioRuntime>["localWorkspace"];
    setStudioRuntime({
      ...getStudioRuntime(),
      localWorkspace: workspace,
      transport: vi.fn(async (path, init) =>
        path === "/api/bootstrap"
          ? Response.json({ ok: true })
          : server(path, init),
      ),
      pluginTransport: server,
    });
    vi.mocked(api).mockResolvedValue({
      data: { id: "local-only", _localPending: true },
    });
    render(
      <Root
        embedded
        search="object=contacts&view=create"
        queryClient={createStudioQueryClient()}
      />,
    );
    await screen.findByLabelText("Copy name");
    const form = state.form;
    const draft = await form.onUploadTemporaryAttachment(
      "contract",
      new File(["test"], "test.pdf"),
    );
    const values = { name: "Test contact" };

    await expect(
      form.onSave(values, undefined, undefined, {
        hasTemporaryAttachments: true,
      }),
    ).rejects.toThrow("Connection lost");
    const record = retained
      ? await form.onSave(values, undefined, undefined, {
          hasTemporaryAttachments: true,
        })
      : await form.onSave(values);
    if (retained) await form.onPersistTemporaryAttachments(record, [draft]);

    const key = (server.mock.calls[0][1]?.body as FormData).get(
      "createRequestKey",
    );
    expect(key).toEqual(expect.any(String));
    expect(record).toEqual(sourceRecord);
    expect(server.mock.calls.map(([path]) => path)).toEqual([
      "/api/file-drafts/contacts",
      "/api/records/contacts",
      "/api/records/contacts",
      ...(retained ? ["/api/file-drafts/draft/attach"] : []),
    ]);
    for (const [, init] of server.mock.calls.slice(1, 3))
      expect(new Headers(init?.headers).get("Idempotency-Key")).toBe(key);
    expect(syncNow).toHaveBeenCalledExactlyOnceWith("contacts", true);
    expect(api).not.toHaveBeenCalledWith(
      "/records/contacts",
      "POST",
      expect.anything(),
      expect.anything(),
    );
  },
);

it("waits for a pending related-record save before associating its attachments", async () => {
  prepareEditors();
  const draft = { id: "draft", version: 1 };
  const server = vi.fn(async () => Response.json({ data: draft }));
  const syncNow = vi.fn().mockResolvedValue(undefined);
  const pending = vi
    .fn()
    .mockResolvedValueOnce({ state: "pending" })
    .mockResolvedValueOnce({ state: "pending" })
    .mockResolvedValueOnce({ state: "pending" })
    .mockResolvedValueOnce(undefined);
  const workspace = {
    scope: "fixture",
    store: { subscribeQueryChanges: () => () => {}, getPendingBundle: pending },
    syncNow,
  } as unknown as ReturnType<typeof getStudioRuntime>["localWorkspace"];
  setStudioRuntime({
    ...getStudioRuntime(),
    localWorkspace: workspace,
    transport: server,
  });
  vi.mocked(api).mockResolvedValue({ data: [] });
  render(
    <Root
      embedded
      search="object=contacts&view=create"
      queryClient={createStudioQueryClient()}
    />,
  );
  await screen.findByLabelText("Copy name");
  server.mockClear();
  const record = { ...sourceRecord, _localPending: true };
  const form = state.form;

  await expect(
    form.onPersistTemporaryAttachments(record, [draft]),
  ).rejects.toThrow();
  expect(server).not.toHaveBeenCalled();
  await form.onPersistTemporaryAttachments(record, [draft]);

  expect(syncNow.mock.calls).toEqual([
    ["contacts", true],
    ["contacts", true],
  ]);
  expect(pending).toHaveBeenLastCalledWith("contacts", record.id);
  expect(server).toHaveBeenCalledExactlyOnceWith(
    "/api/file-drafts/draft/attach",
    expect.anything(),
  );
});

it("clears the editor when access to its record is denied", async () => {
  prepareEditors();
  const client = createStudioQueryClient();
  let deny = false;
  vi.mocked(api).mockImplementation(async (path) => {
    if (path !== "/records/contacts/shared") return { data: [] };
    if (deny) throw new ApiClientError(403, "forbidden", "Access denied");
    return { data: sourceRecord };
  });
  render(
    <Root
      embedded
      search="object=contacts&view=records&record=shared"
      queryClient={client}
    />,
  );
  fireEvent.click(await screen.findByText("Edit source"));
  expect(await screen.findByLabelText("Copy name")).toHaveValue("Contact name");
  deny = true;
  await act(async () =>
    client.invalidateQueries({
      queryKey: ["open-record", "contacts", "shared"],
    }),
  );
  expect(await screen.findByText("Access denied")).toBeVisible();
  expect(screen.queryByLabelText("Copy name")).not.toBeInTheDocument();
});
for (const mode of ["modal", "drawer", "page"] as const) {
  it(`creates an independent copy through the ${mode} create surface and cancellation does not write`, async () => {
    state.object = {
      name: "contacts",
      label: "Contacts",
      description: "",
      config: {
        ...makeConfig({
          name: { type: "Textbox", label: "Name" },
          email: { type: "Textbox", label: "Email", config: { unique: true } },
        }),
        studio: { screen: { createMode: mode } },
      },
    };
    setStudioRuntime({ businessSetupEnabled: false });
    vi.mocked(api).mockImplementation(async (path, method) =>
      path.startsWith("/records/")
        ? {
            data:
              method === "POST"
                ? { id: "fresh", name: "Original" }
                : state.source,
          }
        : { data: [] },
    );
    render(<Root search="object=contacts&view=records&record=source" />);
    fireEvent.click(await screen.findByText("Duplicate source"));
    await screen.findByLabelText("Copy name");
    expect(state.form.values).toEqual({ name: "Original" });
    expect(state.form.ephemeralDraft).toBe(true);
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          ([path, method]) =>
            path.startsWith("/records/") && method && method !== "GET",
        ),
    ).toEqual([]);
    if (mode === "page") {
      expect(window.location.search).not.toContain("record=");
      fireEvent.click(screen.getByRole("button", { name: /Volver/ }));
    } else fireEvent.click(screen.getByText("Cancel copy"));
    await waitFor(() =>
      expect(screen.queryByLabelText("Copy name")).not.toBeInTheDocument(),
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(
          ([path, method]) =>
            path.startsWith("/records/") && method && method !== "GET",
        ),
    ).toEqual([]);
    if (mode === "page") {
      cleanup();
      render(<Root search="object=contacts&view=records&record=source" />);
    }
    fireEvent.click(await screen.findByText("Duplicate source"));
    fireEvent.click(await screen.findByText("Save copy"));
    await waitFor(() =>
      expect(
        vi
          .mocked(api)
          .mock.calls.some(
            (call) => call[0] === "/records/contacts" && call[1] === "POST",
          ),
      ).toBe(true),
    );
    expect(
      vi
        .mocked(api)
        .mock.calls.find(
          (call) => call[0] === "/records/contacts" && call[1] === "POST",
        )?.[2],
    ).toEqual({ name: "Original" });
    expect(vi.mocked(api).mock.calls.some((call) => call[1] === "PATCH")).toBe(
      false,
    );
    expect(state.source).toEqual({
      id: "source",
      name: "Original",
      email: "unique",
      _version: 7,
    });
  });
}

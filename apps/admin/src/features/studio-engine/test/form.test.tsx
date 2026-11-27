// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  act,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { render } from "./locale-test-render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DynamicForm from "../dynamic-form";
import { makeConfig } from "@savia/studio-shared/metadata";
import {
  attachTemporaryR2Attachments,
  type TemporaryR2Attachment,
} from "../r2-attachment-upload";

const futureAttachmentExpiry = () =>
  new Date(Date.now() + 60_000).toISOString();

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("keeps email and calendar date after another field changes and submits them", async () => {
  const save = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "test",
          label: "Test",
          description: "",
          config: makeConfig({
            name: { type: "Textbox", label: "Nombre", required: true },
            email: {
              type: "Textbox",
              label: "Correo",
              config: { format: "email" },
            },
            date: { type: "DateControl", label: "Fecha" },
            amount: { type: "Number", label: "Valor" },
          }),
        }}
        onSave={save}
      />
    </QueryClientProvider>,
  );
  fireEvent.input(await screen.findByRole("textbox", { name: "Nombre" }), {
    target: { value: "Demo" },
  });
  fireEvent.input(screen.getByRole("textbox", { name: "Correo" }), {
    target: { value: "test@example.com" },
  });
  fireEvent.input(screen.getByLabelText("Fecha"), {
    target: { value: "2026-10-15" },
  });
  fireEvent.change(screen.getByRole("spinbutton", { name: "Valor" }), {
    target: { value: "25" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Demo",
        email: "test@example.com",
        date: "2026-10-15",
        amount: 25,
      }),
    ),
  );
});

it("keeps R2 files out of record data and queues them after the record is saved", async () => {
  const file = new File(["contract"], "contract.pdf", {
    type: "application/pdf",
  });
  const save = vi.fn().mockResolvedValue({
    id: "contract-1",
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
  });
  const persistAttachments = vi.fn().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "contracts",
          label: "Contratos",
          description: "",
          config: makeConfig({
            name: { type: "Textbox", label: "Nombre", required: true },
            contract: {
              type: "R2Attachment",
              label: "Contrato",
              config: { accept: ["application/pdf"], maxFiles: 1 },
            },
          }),
        }}
        onPersistAttachments={persistAttachments}
        onSave={save}
      />
    </QueryClientProvider>,
  );

  fireEvent.input(await screen.findByRole("textbox", { name: "Nombre" }), {
    target: { value: "Contrato marco" },
  });
  fireEvent.change(screen.getByTestId("file-picker-input"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));

  await waitFor(() => expect(save).toHaveBeenCalled());
  expect(save).toHaveBeenCalledWith({ name: "Contrato marco" });
  await waitFor(() =>
    expect(persistAttachments).toHaveBeenCalledWith(
      expect.objectContaining({ id: "contract-1" }),
      [{ field: "contract", files: [file] }],
      expect.any(Function),
    ),
  );
});

it("uploads an attachment immediately, then associates it when the record is saved", async () => {
  const file = new File(["contract"], "contract.pdf", {
    type: "application/pdf",
  });
  const temporary = {
    id: "temporary-contract-1",
    name: "contract.pdf",
    mime: "application/pdf",
    size: 8,
    field: "contract",
    version: 1,
    expiresAt: futureAttachmentExpiry(),
  };
  const uploadTemporary = vi.fn().mockResolvedValue(temporary);
  const persistTemporary = vi.fn().mockResolvedValue(undefined);
  const save = vi.fn().mockResolvedValue({
    id: "contract-1",
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "contracts",
          label: "Contratos",
          description: "",
          config: makeConfig({
            name: { type: "Textbox", label: "Nombre", required: true },
            contract: {
              type: "R2Attachment",
              label: "Contrato",
              config: { maxFiles: 1 },
            },
          }),
        }}
        onPersistTemporaryAttachments={persistTemporary}
        onSave={save}
        onUploadTemporaryAttachment={uploadTemporary}
      />
    </QueryClientProvider>,
  );

  fireEvent.input(await screen.findByRole("textbox", { name: "Nombre" }), {
    target: { value: "Contrato marco" },
  });
  fireEvent.change(screen.getByTestId("file-picker-input"), {
    target: { files: [file] },
  });
  await waitFor(() =>
    expect(uploadTemporary).toHaveBeenCalledWith("contract", file, undefined),
  );

  fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  await waitFor(() =>
    expect(persistTemporary).toHaveBeenCalledWith(
      expect.objectContaining({ id: "contract-1" }),
      [temporary],
    ),
  );
});

it.each([false, true])(
  "tracks simultaneous loads and retries only the attachments (conversation: %s)",
  async (conversation) => {
    const files = ["contract.pdf", "appendix.pdf"].map(
      (name) => new File(["file"], name, { type: "application/pdf" }),
    );
    const pending = new Map<File, () => void>();
    const upload = vi.fn(
      (field: string, file: File) =>
        new Promise<TemporaryR2Attachment>((resolve) => {
          pending.set(file, () =>
            resolve({
              id: file.name,
              name: file.name,
              mime: file.type,
              size: file.size,
              field,
              version: 1,
              expiresAt: futureAttachmentExpiry(),
            }),
          );
        }),
    );
    const saved = { id: "record-1" };
    const save = vi.fn().mockResolvedValue(saved);
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("Attachment confirmation interrupted"))
      .mockResolvedValueOnce(undefined);
    const config = makeConfig({
      contract: {
        type: "R2Attachment",
        label: "Contrato",
        config: { maxFiles: 2, step: "attachment" },
      },
    });
    if (conversation)
      config.studio = {
        wizard: {
          enabled: true,
          steps: [{ id: "attachment", title: "Adjuntos" }],
        },
      };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DynamicForm
          object={{
            name: "contracts",
            label: "Contratos",
            description: "",
            config,
          }}
          onPersistTemporaryAttachments={persist}
          onSave={save}
          onUploadTemporaryAttachment={upload}
        />
      </QueryClientProvider>,
    );

    const action = () =>
      screen.getByRole<HTMLButtonElement>("button", {
        name: conversation ? "Revisar respuestas" : "Guardar registro",
      });
    const progress = (file: File) =>
      screen
        .getByRole("progressbar", { name: `Carga de ${file.name}` })
        .getAttribute("aria-valuetext");
    fireEvent.change(await screen.findByTestId("file-picker-input"), {
      target: { files },
    });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(action().disabled).toBe(true);

    await act(async () => pending.get(files[0])?.());
    expect(action().disabled).toBe(true);
    expect(files.map(progress)).toEqual([
      "Archivo cargado",
      "Cargando archivo",
    ]);

    await act(async () => pending.get(files[1])?.());
    expect(action().disabled).toBe(false);
    expect(files.map(progress)).toEqual(["Archivo cargado", "Archivo cargado"]);
    if (conversation) fireEvent.click(action());
    fireEvent.click(
      await screen.findByRole("button", { name: "Guardar registro" }),
    );
    await screen.findByText("Attachment confirmation interrupted");
    fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));
    await waitFor(() =>
      expect(persist).toHaveBeenNthCalledWith(
        2,
        saved,
        files.map((file) => expect.objectContaining({ id: file.name })),
      ),
    );
    expect(save).toHaveBeenCalledOnce();
  },
);

it.each([false, true])(
  "retries only the failed attachment in the same editor (conversation: %s)",
  async (conversation) => {
    const good = new File(["contract"], "contract.pdf");
    const failed = new File(["appendix"], "appendix.pdf");
    const draft = (file: File) => ({
      id: file.name,
      name: file.name,
      field: "contract",
      mime: file.type,
      size: file.size,
      version: 1,
      expiresAt: futureAttachmentExpiry(),
    });
    const upload = vi
      .fn()
      .mockResolvedValueOnce(draft(good))
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(draft(failed));
    const save = vi.fn().mockResolvedValue({ id: "record-1" });
    const persist = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig({
      contract: {
        type: "R2Attachment",
        label: "Contrato",
        config: { maxFiles: 2 },
      },
    });
    if (conversation)
      config.studio = {
        wizard: {
          enabled: true,
          steps: [{ id: "attachment", title: "Adjuntos" }],
        },
      };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DynamicForm
          object={{
            name: "contracts",
            label: "Contratos",
            description: "",
            config,
          }}
          onSave={save}
          onUploadTemporaryAttachment={upload}
          onPersistTemporaryAttachments={persist}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByTestId("file-picker-input"), {
      target: { files: [good, failed] },
    });
    const retry = await screen.findByRole("button", {
      name: "Reintentar carga de appendix.pdf",
    });
    expect(screen.getByText("Connection interrupted")).toBeVisible();
    expect(screen.getAllByText("Archivo cargado")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: conversation ? "Revisar respuestas" : "Guardar registro",
        }),
      );
    });
    expect(retry).toBeVisible();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.getAllByText("Archivo cargado")).toHaveLength(2),
    );
    expect(
      screen.queryByText("Connection interrupted"),
    ).not.toBeInTheDocument();
    expect(upload.mock.calls.map(([, file]) => file)).toEqual([
      good,
      failed,
      failed,
    ]);
    if (conversation)
      fireEvent.click(
        screen.getByRole("button", { name: "Revisar respuestas" }),
      );
    fireEvent.click(
      await screen.findByRole("button", { name: "Guardar registro" }),
    );
    await waitFor(() =>
      expect(persist).toHaveBeenCalledExactlyOnceWith({ id: "record-1" }, [
        expect.objectContaining({ id: good.name }),
        expect.objectContaining({ id: failed.name }),
      ]),
    );
    expect(save).toHaveBeenCalledOnce();
  },
);

it.each([
  { conversation: false, beforeSave: true },
  { conversation: true, beforeSave: true },
  { conversation: false, beforeSave: false },
  { conversation: true, beforeSave: false },
])(
  "reloads only the unavailable attachment (conversation: $conversation, before saving: $beforeSave)",
  async ({ conversation, beforeSave }) => {
    const files = ["contract.pdf", "appendix.pdf"].map(
      (name) => new File(["test"], name, { type: "application/pdf" }),
    );
    const draft = (
      id: string,
      file: File,
      expiresAt = futureAttachmentExpiry(),
    ) => ({
      id,
      name: file.name,
      mime: file.type,
      size: file.size,
      field: "contract",
      version: 1,
      expiresAt,
    });
    const upload = vi
      .fn()
      .mockResolvedValueOnce(draft("kept", files[1]))
      .mockResolvedValueOnce(
        draft(
          "original",
          files[0],
          beforeSave ? "2000-01-01T00:00:00Z" : undefined,
        ),
      )
      .mockResolvedValueOnce(draft("refreshed", files[0]));
    const fetcher = vi.fn(async (path: string) => {
      if (!path.endsWith("/attach")) return Response.json({ data: [] });
      const id = path.split("/").at(-2);
      return id === "original"
        ? Response.json(
            { error: "Expired", code: "ATTACHMENT_DRAFT_UNAVAILABLE" },
            { status: 404 },
          )
        : Response.json({ data: { id } });
    });
    vi.stubGlobal("fetch", fetcher);
    const save = vi.fn(async () => ({ id: "record-1" }));
    const done = vi.fn();
    const config = makeConfig({
      contract: {
        type: "R2Attachment",
        label: "Contrato",
        config: { maxFiles: 2, step: "attachment" },
      },
    });
    if (conversation)
      config.studio = {
        wizard: {
          enabled: true,
          steps: [{ id: "attachment", title: "Adjuntos" }],
        },
      };
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DynamicForm
          object={{
            name: "contracts",
            label: "Contratos",
            description: "",
            config,
          }}
          onSave={save}
          onSaved={done}
          onPersistTemporaryAttachments={(record, uploads) =>
            attachTemporaryR2Attachments(record.id, uploads)
          }
          onUploadTemporaryAttachment={upload}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByTestId("file-picker-input"), {
      target: { files: [files[1], files[0]] },
    });
    await waitFor(() =>
      expect(screen.getAllByText("Archivo cargado")).toHaveLength(2),
    );
    if (conversation)
      fireEvent.click(
        screen.getByRole("button", { name: "Revisar respuestas" }),
      );
    const saveButton = () =>
      screen.getByRole<HTMLButtonElement>("button", {
        name: "Guardar registro",
      });
    fireEvent.click(
      await screen.findByRole("button", { name: "Guardar registro" }),
    );
    await waitFor(() =>
      expect(upload).toHaveBeenNthCalledWith(
        3,
        "contract",
        files[0],
        beforeSave ? undefined : "record-1",
      ),
    );
    expect(save).toHaveBeenCalledTimes(beforeSave ? 0 : 1);
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledTimes(3);
    const associations = fetcher.mock.calls
      .map(([path]) => path)
      .filter((path) => path.endsWith("/attach"))
      .map((path) => path.split("/").at(-2));
    expect(associations).toEqual(
      beforeSave
        ? ["kept", "refreshed"]
        : ["kept", "original", "kept", "refreshed"],
    );
  },
);

it.each([false, true])(
  "finishes attaching a submitted draft after leaving the editor (conversation: %s)",
  async (conversation) => {
    const file = new File(["contract"], "contract.pdf");
    const draft = {
      id: "draft-1",
      name: file.name,
      field: "contract",
      mime: file.type,
      size: file.size,
      version: 1,
      expiresAt: futureAttachmentExpiry(),
    };
    const record = { id: "record-1" };
    let confirmRecord!: (value: typeof record) => void;
    const pendingRecord = new Promise<typeof record>((resolve) => {
      confirmRecord = resolve;
    });
    const save = vi.fn(() => pendingRecord);
    const persist = vi.fn().mockResolvedValue(undefined);
    const discard = vi.fn().mockResolvedValue(undefined);
    const config = makeConfig({
      contract: {
        type: "R2Attachment",
        label: "Contrato",
        config: { maxFiles: 2 },
      },
    });
    if (conversation)
      config.studio = {
        wizard: { enabled: true, steps: [{ id: "files", title: "Adjuntos" }] },
      };
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <DynamicForm
          object={{
            name: "contracts",
            label: "Contratos",
            description: "",
            config,
          }}
          onSave={save}
          onUploadTemporaryAttachment={vi.fn().mockResolvedValue(draft)}
          onDiscardTemporaryAttachments={discard}
          onPersistTemporaryAttachments={persist}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByTestId("file-picker-input"), {
      target: { files: [file] },
    });
    await screen.findByText("Archivo cargado");
    expect(screen.getByTestId("file-picker-input")).toBeEnabled();
    if (conversation)
      fireEvent.click(
        screen.getByRole("button", { name: "Revisar respuestas" }),
      );
    fireEvent.click(
      await screen.findByRole("button", { name: "Guardar registro" }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith(
      expect.any(Object),
      undefined,
      undefined,
      {
        hasTemporaryAttachments: true,
      },
    );
    if (!conversation)
      expect(screen.getByTestId("file-picker-input")).toBeDisabled();

    view.unmount();
    await act(async () => confirmRecord(record));

    expect(discard).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledExactlyOnceWith(record, [draft]);
  },
);

it("closes the record form while temporary attachment cleanup is pending", async () => {
  const file = new File(["contract"], "contract.pdf", {
    type: "application/pdf",
  });
  const temporary = {
    id: "temporary-contract-1",
    name: "contract.pdf",
    mime: "application/pdf",
    size: 8,
    field: "contract",
    version: 1,
    expiresAt: futureAttachmentExpiry(),
  };
  let failCleanup: (error: Error) => void = () => {};
  const discardTemporary = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        failCleanup = reject;
      }),
  );
  const onCancel = vi.fn();
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "contracts",
          label: "Contratos",
          description: "",
          config: makeConfig({
            contract: {
              type: "R2Attachment",
              label: "Contrato",
              config: { maxFiles: 1 },
            },
          }),
        }}
        onCancel={onCancel}
        onDiscardTemporaryAttachments={discardTemporary}
        onSave={vi.fn().mockResolvedValue(undefined)}
        onUploadTemporaryAttachment={vi.fn().mockResolvedValue(temporary)}
      />
    </QueryClientProvider>,
  );

  fireEvent.change(await screen.findByTestId("file-picker-input"), {
    target: { files: [file] },
  });
  await waitFor(() => expect(screen.getByText("Archivo cargado")).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
  await waitFor(() =>
    expect(discardTemporary).toHaveBeenCalledWith([temporary]),
  );
  expect(onCancel).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => failCleanup(new Error("Cleanup unavailable")));
  expect(discardTemporary).toHaveBeenCalledOnce();
});

it("shows R2 transfer progress while an attachment is being uploaded", async () => {
  const file = new File(["contract"], "contract.pdf", {
    type: "application/pdf",
  });
  let finishUpload: () => void = () => {};
  const save = vi.fn().mockResolvedValue({
    id: "contract-1",
    created_at: "2026-09-09T00:00:00.000Z",
    updated_at: "2026-09-09T00:00:00.000Z",
  });
  const persistAttachments = vi.fn(async (_record, _attachments, onStatus) => {
    onStatus({ field: "contract", file, status: "uploading" });
    await new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    onStatus({ field: "contract", file, status: "uploaded" });
  });
  const fetcher = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetcher);

  render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "contracts",
          label: "Contratos",
          description: "",
          config: makeConfig({
            name: { type: "Textbox", label: "Nombre", required: true },
            contract: { type: "R2Attachment", label: "Contrato" },
          }),
        }}
        onPersistAttachments={persistAttachments}
        onSave={save}
      />
    </QueryClientProvider>,
  );

  fireEvent.input(await screen.findByRole("textbox", { name: "Nombre" }), {
    target: { value: "Contrato marco" },
  });
  fireEvent.change(screen.getByTestId("file-picker-input"), {
    target: { files: [file] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));

  expect(await screen.findByText("Cargando archivo…")).toBeTruthy();
  expect(
    screen
      .getByRole("progressbar", { name: "Carga de contract.pdf" })
      .getAttribute("aria-valuetext"),
  ).toBe("Cargando archivo");

  finishUpload();
  await waitFor(() =>
    expect(screen.queryByText("Cargando archivo…")).toBeNull(),
  );
});

it.each([
  { description: "an edit", managed: false, retryName: "Contrato revisado" },
  {
    description: "a reverted edit",
    managed: true,
    retryName: "Contrato original",
  },
])(
  "saves $description before retrying an attachment upload",
  async ({ managed, retryName }) => {
    const file = new File(["contract"], "contract.pdf", {
      type: "application/pdf",
    });
    const savedRecord = {
      id: "contract-1",
      _version: 2,
      created_at: "2026-09-09T00:00:00.000Z",
      updated_at: "2026-09-09T00:00:00.000Z",
    };
    const save = vi.fn().mockResolvedValue(savedRecord);
    const persistAttachments = vi
      .fn()
      .mockRejectedValueOnce(new Error("R2 no está disponible"))
      .mockResolvedValueOnce(undefined);
    const config = makeConfig({
      name: { type: "Textbox", label: "Nombre", required: true },
      contract: { type: "R2Attachment", label: "Contrato" },
    });
    if (managed) config.studio = { business: "managed-customer" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [] })),
    );
    render(
      <QueryClientProvider client={new QueryClient()}>
        <DynamicForm
          object={{
            name: "contracts",
            label: "Contratos",
            description: "",
            config,
          }}
          onPersistAttachments={persistAttachments}
          onSave={save}
          values={
            managed
              ? { id: savedRecord.id, name: "Contrato original" }
              : undefined
          }
        />
      </QueryClientProvider>,
    );

    fireEvent.input(await screen.findByRole("textbox", { name: "Nombre" }), {
      target: { value: "Contrato marco" },
    });
    fireEvent.change(screen.getByTestId("file-picker-input"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));
    await screen.findByText("R2 no está disponible");
    fireEvent.input(screen.getByRole("textbox", { name: "Nombre" }), {
      target: { value: retryName },
    });
    fireEvent.click(screen.getByRole("button", { name: "Guardar registro" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenNthCalledWith(2, { name: retryName }, savedRecord);
  },
);

it("offers a cancel action beside save on a standard record form", async () => {
  const onCancel = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "test",
          label: "Test",
          description: "",
          config: makeConfig({
            name: { type: "Textbox", label: "Nombre", required: true },
          }),
        }}
        onCancel={onCancel}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "Cancelar" }));
  expect(onCancel).toHaveBeenCalledOnce();
});

it("uses a user-facing label for the legacy R2 attachment field", async () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DynamicForm
        object={{
          name: "test",
          label: "Test",
          description: "",
          config: makeConfig({
            attachment: { type: "R2Attachment", label: "Archivo R2" },
          }),
        }}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />
    </QueryClientProvider>,
  );

  expect(await screen.findByText("Archivo adjunto")).toBeTruthy();
});

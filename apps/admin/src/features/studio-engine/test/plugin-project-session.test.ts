// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  PluginProjectSession,
  type RecoveryDraft,
} from "../plugin-project-session";
const draft = (code: string) => ({
  files: {
    "entry.tsx": code,
    "savia-extension.json": "{}",
    "store.json": "{}",
    "preview.json": "{}",
  },
  history: [],
});
it("serializes saves and carries the new version into changes typed during an in-flight save", async () => {
  let finish!: (data: { version: number }) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ version: 3 });
  const recover = vi.fn();
  const session = new PluginProjectSession(
    1,
    draft("one"),
    save,
    recover,
    vi.fn(),
  );
  session.update(draft("two"));
  const pending = session.flush();
  session.update(draft("three"));
  finish({ version: 2 });
  await pending;
  expect(
    save.mock.calls.map(([input]) => [input.version, input.files["entry.tsx"]]),
  ).toEqual([
    [1, "two"],
    [2, "three"],
  ]);
  expect(session.isSaved).toBe(true);
  session.dispose();
});
it("retains recovery content and does not overwrite a conflicted version", async () => {
  const save = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error("Conflict"), { status: 409 }));
  const recover = vi.fn();
  const session = new PluginProjectSession(
    2,
    draft("one"),
    save,
    recover,
    vi.fn(),
  );
  session.update(draft("unsaved"));
  await expect(session.flush()).rejects.toThrow("Conflict");
  expect(session.isSaved).toBe(false);
  expect(recover).toHaveBeenLastCalledWith({ ...draft("unsaved"), version: 2 });
  expect(save).toHaveBeenCalledTimes(1);
  session.dispose();
});

it("keeps the draft unsaved when undoing a change already being saved", async () => {
  let acknowledgeEdit!: (value: { version: number }) => void;
  let acknowledgeUndo!: (value: { version: number }) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledgeEdit = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledgeUndo = resolve;
        }),
    );
  const session = new PluginProjectSession(
    1,
    draft("original"),
    save,
    vi.fn(),
    vi.fn(),
  );

  session.update(draft("edited"));
  const pending = session.flush();
  session.update(draft("original"));
  expect(session.isSaved).toBe(false);

  acknowledgeEdit({ version: 2 });
  await Promise.resolve();
  expect(save).toHaveBeenLastCalledWith({ ...draft("original"), version: 2 });
  expect(session.isSaved).toBe(false);
  acknowledgeUndo({ version: 3 });
  await pending;
  expect(session.isSaved).toBe(true);
  session.dispose();
});

it("retries the current draft if its earlier save was interrupted after an undo", async () => {
  let interrupt!: (reason: Error) => void;
  const save = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          interrupt = reject;
        }),
    )
    .mockResolvedValue({ version: 2 });
  const session = new PluginProjectSession(
    1,
    draft("original"),
    save,
    vi.fn(),
    vi.fn(),
  );

  session.update(draft("edited"));
  const pending = session.flush();
  session.update(draft("original"));
  interrupt(new Error("Lost response"));
  await expect(pending).rejects.toThrow("Lost response");
  expect(session.isSaved).toBe(false);

  await session.flush();
  expect(save).toHaveBeenLastCalledWith({ ...draft("original"), version: 1 });
  expect(session.isSaved).toBe(true);
  session.dispose();
});

it.each([false, true])(
  "confirms a committed save after a lost response with newer edits=%s",
  async (newerEdits) => {
    const initial = draft("initial");
    let server: RecoveryDraft = { ...initial, version: 1 };
    const save = vi.fn(async (input: RecoveryDraft) => {
      if (input.version !== server.version) throw new Error("Conflict");
      server = { ...input, version: input.version + 1 };
      if (input.version === 1) throw new Error("Lost response");
      return { version: server.version };
    });
    const readSaved = vi.fn(async () => ({
      ...server,
      files: { "preview.json": server.files["preview.json"], ...server.files },
      editorExtensions: [],
      installedEditorExtensions: [],
    }));
    const recover = vi.fn();
    const session = new PluginProjectSession(
      1,
      initial,
      save,
      recover,
      vi.fn(),
      readSaved,
    );
    try {
      session.update(draft("sent"));
      await expect(session.flush()).rejects.toThrow("Lost response");
      if (newerEdits) session.update(draft("newer edit"));

      await session.flush();
      expect(readSaved).toHaveBeenCalledTimes(1);
      expect(save.mock.calls.map(([input]) => input.version)).toEqual(
        newerEdits ? [1, 2] : [1],
      );
      expect(server.files["entry.tsx"]).toBe(
        newerEdits ? "newer edit" : "sent",
      );
      expect(session.isSaved).toBe(true);
      expect(recover).toHaveBeenLastCalledWith(null);
    } finally {
      session.dispose();
    }
  },
);

it("keeps the conflict when newer server settings differ from the unconfirmed save", async () => {
  const save = vi
    .fn<(input: RecoveryDraft) => Promise<{ version: number }>>()
    .mockRejectedValueOnce(new Error("Interrupted"))
    .mockRejectedValueOnce(new Error("Conflict"));
  const readSaved = vi.fn(async () => ({
    ...draft("sent"),
    version: 2,
    editorExtensions: ["savia.formatter"],
  }));
  const recover = vi.fn();
  const session = new PluginProjectSession(
    1,
    draft("initial"),
    save,
    recover,
    vi.fn(),
    readSaved,
  );
  try {
    session.update(draft("sent"));
    await expect(session.flush()).rejects.toThrow("Interrupted");
    session.update(draft("new edit"));
    await expect(session.flush()).rejects.toThrow("Conflict");
    expect(readSaved).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith({ ...draft("new edit"), version: 1 });
    expect(session.isSaved).toBe(false);
    expect(recover).toHaveBeenLastCalledWith({
      ...draft("new edit"),
      version: 1,
    });
  } finally {
    session.dispose();
  }
});

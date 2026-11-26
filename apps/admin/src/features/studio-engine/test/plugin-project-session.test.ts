import { expect, it, vi } from "vitest";
import { PluginProjectSession } from "../plugin-project-session";
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

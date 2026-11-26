import { fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InstalledEditorExtension } from "@savia/studio-shared/plugin-editor-extensions";
import { PluginVscodeEditor } from "../plugin-vscode-editor";
import { projectFileUri } from "../plugin-vscode-protocol";

function messageFrom(iframe: HTMLIFrameElement, data: unknown) {
  fireEvent(
    window,
    new MessageEvent("message", {
      source: iframe.contentWindow,
      origin: new URL(iframe.src).origin,
      data: {
        session: Object.fromEntries(
          new URLSearchParams(new URL(iframe.src).hash.slice(1)),
        ),
        message: data,
      },
    }),
  );
}

describe("extension editor bridge", () => {
  it("reports applied extension state only after the matching frame confirms it", () => {
    const applied = vi.fn();
    const props = {
      files: { "entry.tsx": "source" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
      onExtensionsApplied: applied,
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const frame = view.container.querySelector("iframe")!;
    expect(applied).not.toHaveBeenCalled();
    messageFrom(frame, {
      type: "savia-editor-state-applied",
      installedExtensions: [],
      error: "Extension host refused to stop.",
    });
    expect(applied).toHaveBeenCalledWith([], "Extension host refused to stop.");
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it("ignores oversize requests and drops late completion results after a project switch", async () => {
    let finish!: (value: string) => void;
    const fetchCompletion = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const props = {
      files: { "entry.tsx": "source" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
      fetchCompletion,
    };
    const view = render(<PluginVscodeEditor {...props} projectId="first" />);
    const old = view.container.querySelector("iframe")!;
    const post = vi
      .spyOn(old.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    messageFrom(old, {
      type: "savia-editor-completion",
      requestId: "large",
      prefix: "a".repeat(102401),
      suffix: "",
    });
    expect(fetchCompletion).not.toHaveBeenCalled();
    messageFrom(old, {
      type: "savia-editor-completion",
      requestId: "pending",
      prefix: "source",
      suffix: "",
    });
    expect(fetchCompletion).toHaveBeenCalledTimes(1);
    view.rerender(<PluginVscodeEditor {...props} projectId="second" />);
    finish("first project result");
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    const current = view.container.querySelector("iframe")!;
    expect(current).not.toBe(old);
    const session = Object.fromEntries(
      new URLSearchParams(new URL(old.src).hash.slice(1)),
    );
    fireEvent(
      window,
      new MessageEvent("message", {
        source: current.contentWindow,
        origin: location.origin,
        data: {
          session,
          message: {
            type: "savia-editor-change",
            path: "entry.tsx",
            value: "foreign",
            sequence: 1,
          },
        },
      }),
    );
    expect(props.onChange).not.toHaveBeenCalled();
  });

  it("accepts sequenced edits from its own frame and acknowledges the latest controlled value", () => {
    const onChange = vi.fn();
    const props = {
      files: { "src/entry.tsx": "before" },
      activeFile: "src/entry.tsx",
      extensions: [],
      readOnly: false,
      onChange,
      onSearch: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const iframe = view.container.querySelector("iframe")!;
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});

    messageFrom(iframe, { type: "savia-editor-ready" });
    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "src/entry.tsx",
      value: "after",
      sequence: 4,
    });
    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "src/entry.tsx",
      value: "stale duplicate",
      sequence: 4,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("src/entry.tsx", "after");

    view.rerender(
      <PluginVscodeEditor {...props} files={{ "src/entry.tsx": "after" }} />,
    );
    const states = postMessage.mock.calls
      .map(
        ([data]) =>
          (data as { message: { type?: string; acknowledgements?: unknown } })
            .message,
      )
      .filter((data) => data.type === "savia-editor-state");
    expect(states.at(-1)?.acknowledgements).toEqual({ "src/entry.tsx": 4 });

    postMessage.mockClear();
    view.rerender(
      <PluginVscodeEditor
        {...props}
        readOnly
        files={{ "src/entry.tsx": "after" }}
      />,
    );
    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "src/entry.tsx",
      value: "locked edit",
      sequence: 5,
    });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("sends project contents only when the editor state changes", () => {
    const props = {
      files: { "entry.tsx": "source", "src/unused.ts": "unused" },
      activeFile: "entry.tsx",
      extensions: ["savia.formatter"],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const iframe = view.container.querySelector("iframe")!;
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    messageFrom(iframe, { type: "savia-editor-ready" });

    view.rerender(
      <PluginVscodeEditor
        {...props}
        hidden
        files={{ "src/unused.ts": "unused", "entry.tsx": "source" }}
        extensions={["savia.formatter"]}
      />,
    );
    expect(postMessage).toHaveBeenCalledTimes(1);

    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "entry.tsx",
      value: "source",
      sequence: 2,
    });
    view.rerender(<PluginVscodeEditor {...props} />);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          acknowledgements: { "entry.tsx": 2 },
        }),
      }),
      location.origin,
    );

    view.rerender(<PluginVscodeEditor {...props} readOnly />);
    expect(postMessage).toHaveBeenCalledTimes(3);
    expect(postMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({
          type: "savia-editor-state",
          readOnly: true,
        }),
      }),
      location.origin,
    );
  });

  it("resends the project and accepts a fresh edit sequence after the frame reloads", () => {
    const props = {
      files: { "entry.tsx": "source" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const iframe = view.container.querySelector("iframe")!;
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});

    messageFrom(iframe, { type: "savia-editor-ready" });
    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "entry.tsx",
      value: "before reload",
      sequence: 4,
    });
    postMessage.mockClear();
    messageFrom(iframe, { type: "savia-editor-ready" });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: expect.objectContaining({
          type: "savia-editor-state",
          files: props.files,
          acknowledgements: {},
        }),
      }),
      location.origin,
    );
    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "entry.tsx",
      value: "after reload",
      sequence: 1,
    });
    expect(props.onChange.mock.calls).toEqual([
      ["entry.tsx", "before reload"],
      ["entry.tsx", "after reload"],
    ]);
  });

  it("downloads only eligible extensions in dependency order and reuses active ones", async () => {
    const base: InstalledEditorExtension = {
      id: "fixture.base",
      publisher: "fixture",
      name: "base",
      version: "1.0.0",
      installationId: "d4ccc664-5d54-4dd6-8678-a7365486684b",
      sha256: "a".repeat(64),
      source: "vsix",
      createdAt: "2026-01-01T00:00:00.000Z",
      license: null,
      compressedBytes: 1,
      expandedBytes: 1,
      dependencies: [],
      compatibility: { supported: true, reason: null },
    };
    const dependent: InstalledEditorExtension = {
      ...base,
      id: "fixture.dependent",
      name: "dependent",
      installationId: "27289d36-56d3-4a4a-8623-df9b5462cd5a",
      sha256: "b".repeat(64),
      dependencies: [base.id],
    };
    const reference = ({
      installationId,
      sha256,
    }: InstalledEditorExtension) => ({
      installationId,
      sha256,
    });
    const operations: string[] = [];
    const list = vi.fn(async () => [base, dependent]);
    const downloadPackage = vi.fn(async (id: string, _signal?: AbortSignal) => {
      operations.push(`download ${id}`);
      return new Uint8Array([1]);
    });
    const props = {
      runtimeUrl: "https://editor.example.test/plugin-editor",
      files: { "entry.tsx": "source" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
      onExtensionStatus: vi.fn((id: string, error: string | null) => {
        if (!error) operations.push(`active ${id}`);
      }),
      extensionSource: { list, downloadPackage },
    };
    const view = render(
      <PluginVscodeEditor {...props} installedExtensions={[reference(base)]} />,
    );
    const iframe = view.container.querySelector("iframe")!;
    const transfers: string[] = [];
    vi.spyOn(iframe.contentWindow!, "postMessage").mockImplementation(
      ({ message }) => {
        if (message.type !== "savia-editor-package") return;
        if (message.payload.type === "begin")
          transfers.push(message.payload.installationId);
        queueMicrotask(() =>
          messageFrom(iframe, {
            type: "savia-editor-package-ack",
            ackId: message.ackId,
          }),
        );
      },
    );
    messageFrom(iframe, { type: "savia-editor-ready" });
    await waitFor(() =>
      expect(props.onExtensionStatus).toHaveBeenCalledWith(
        base.installationId,
        null,
      ),
    );
    list.mockClear();
    downloadPackage.mockClear();

    view.rerender(
      <PluginVscodeEditor
        {...props}
        installedExtensions={[reference(dependent), reference(base)]}
      />,
    );
    await waitFor(() =>
      expect(props.onExtensionStatus).toHaveBeenCalledWith(
        dependent.installationId,
        null,
      ),
    );
    expect(list).toHaveBeenCalledTimes(1);
    expect(downloadPackage.mock.calls.map(([id]) => id)).toEqual([
      dependent.installationId,
    ]);
    expect(transfers).toEqual([base.installationId, dependent.installationId]);

    list.mockClear();
    downloadPackage.mockClear();
    operations.length = 0;
    downloadPackage.mockImplementationOnce(
      (_id, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    messageFrom(iframe, { type: "savia-editor-ready" });
    await waitFor(() => expect(downloadPackage).toHaveBeenCalledTimes(1));
    const interruptedSignal = downloadPackage.mock.calls[0][1];
    messageFrom(iframe, { type: "savia-editor-ready" });
    expect(interruptedSignal?.aborted).toBe(true);
    await waitFor(() =>
      expect(transfers).toEqual([
        base.installationId,
        dependent.installationId,
        base.installationId,
        dependent.installationId,
      ]),
    );
    expect(list).toHaveBeenCalledTimes(2);
    expect(downloadPackage.mock.calls.map(([id]) => id)).toEqual([
      base.installationId,
      base.installationId,
      dependent.installationId,
    ]);
    expect(operations).toEqual([
      `download ${base.installationId}`,
      `active ${base.installationId}`,
      `download ${dependent.installationId}`,
      `active ${dependent.installationId}`,
    ]);
    expect(
      props.onExtensionStatus.mock.calls.every(([, error]) => !error),
    ).toBe(true);

    downloadPackage.mockClear();
    view.rerender(
      <PluginVscodeEditor
        {...props}
        installedExtensions={[reference(dependent)]}
      />,
    );
    messageFrom(iframe, { type: "savia-editor-ready" });
    await waitFor(() =>
      expect(props.onExtensionStatus).toHaveBeenCalledWith(
        dependent.installationId,
        "Extension packages have missing or circular dependencies.",
      ),
    );
    expect(downloadPackage).not.toHaveBeenCalled();
  });

  it("queues every format request until the iframe is ready and sends each once", () => {
    const props = {
      files: { "entry.tsx": "before" },
      activeFile: "entry.tsx",
      extensions: ["savia.formatter"],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<PluginVscodeEditor {...props} formatRequest={0} />);
    const iframe = view.container.querySelector("iframe")!;
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});

    view.rerender(<PluginVscodeEditor {...props} formatRequest={2} />);
    expect(
      postMessage.mock.calls.filter(
        ([data]) =>
          (data as { message: { type?: string } }).message.type ===
          "savia-editor-format",
      ),
    ).toHaveLength(0);

    messageFrom(iframe, { type: "savia-editor-ready" });
    const formatMessages = () =>
      postMessage.mock.calls.filter(
        ([data]) =>
          (data as { message: { type?: string } }).message.type ===
          "savia-editor-format",
      );
    expect(formatMessages()).toHaveLength(2);
    view.rerender(<PluginVscodeEditor {...props} formatRequest={2} />);
    expect(formatMessages()).toHaveLength(2);
    view.rerender(<PluginVscodeEditor {...props} formatRequest={3} readOnly />);
    expect(formatMessages()).toHaveLength(2);
    view.rerender(<PluginVscodeEditor {...props} formatRequest={3} />);
    expect(formatMessages()).toHaveLength(3);
  });

  it("routes inline completions only for a writable entry file and replies with a result", async () => {
    const fetchCompletion = vi.fn().mockResolvedValue("completion");
    const props = {
      files: { "entry.tsx": "before", "src/app.tsx": "source" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
      fetchCompletion,
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const iframe = view.container.querySelector("iframe")!;
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});

    messageFrom(iframe, {
      type: "savia-editor-completion",
      requestId: "request-1",
      prefix: "const value = ",
      suffix: "",
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          session: expect.any(Object),
          message: {
            type: "savia-editor-completion-result",
            requestId: "request-1",
            value: "completion",
          },
        },
        location.origin,
      ),
    );
    expect(fetchCompletion).toHaveBeenCalledWith(
      "const value = ",
      "",
      expect.any(AbortSignal),
    );

    fetchCompletion.mockClear();
    view.rerender(<PluginVscodeEditor {...props} activeFile="src/app.tsx" />);
    messageFrom(iframe, {
      type: "savia-editor-completion",
      requestId: "request-2",
      prefix: "source",
      suffix: "",
    });
    await waitFor(() =>
      expect(postMessage).toHaveBeenCalledWith(
        {
          session: expect.any(Object),
          message: {
            type: "savia-editor-completion-result",
            requestId: "request-2",
            value: null,
          },
        },
        location.origin,
      ),
    );
    expect(fetchCompletion).not.toHaveBeenCalled();
  });

  it("releases an inline completion slot when the iframe cancels and aborts pending requests on file change", async () => {
    const responses: Array<(value: string | null) => void> = [];
    const fetchCompletion = vi.fn(
      (_prefix: string, _suffix: string, _signal: AbortSignal) =>
        new Promise<string | null>((resolve) => responses.push(resolve)),
    );
    const props = {
      files: { "entry.tsx": "before", "src/app.tsx": "source" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: false,
      onChange: vi.fn(),
      onSearch: vi.fn(),
      onError: vi.fn(),
      fetchCompletion,
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const iframe = view.container.querySelector("iframe")!;
    const postMessage = vi
      .spyOn(iframe.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    const sendRequest = (requestId: string) =>
      messageFrom(iframe, {
        type: "savia-editor-completion",
        requestId,
        prefix: "const value = ",
        suffix: "",
      });
    for (const requestId of ["1", "2", "3", "4"]) sendRequest(requestId);
    sendRequest("beyond-limit");
    expect(fetchCompletion).toHaveBeenCalledTimes(4);

    messageFrom(iframe, {
      type: "savia-editor-completion-cancel",
      requestId: "1",
    });
    sendRequest("replacement");
    expect(fetchCompletion).toHaveBeenCalledTimes(5);
    expect(fetchCompletion.mock.calls[0][2].aborted).toBe(true);
    expect(fetchCompletion.mock.calls[4][2].aborted).toBe(false);
    responses[0]("outdated");
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ value: "outdated" }),
      }),
      location.origin,
    );

    view.rerender(<PluginVscodeEditor {...props} activeFile="src/app.tsx" />);
    expect(
      fetchCompletion.mock.calls.every(([, , signal]) => signal.aborted),
    ).toBe(true);

    view.rerender(<PluginVscodeEditor {...props} />);
    sendRequest("closing");
    const closing = fetchCompletion.mock.lastCall![2];
    expect(closing.aborted).toBe(false);
    view.unmount();
    expect(closing.aborted).toBe(true);
  });

  it("keeps proposal review hidden and prevents the hidden editor from writing", () => {
    const onChange = vi.fn();
    const props = {
      files: { "entry.tsx": "before" },
      activeFile: "entry.tsx",
      extensions: [],
      readOnly: true,
      hidden: true,
      onChange,
      onSearch: vi.fn(),
      onError: vi.fn(),
    };
    const view = render(<PluginVscodeEditor {...props} />);
    const iframe = view.container.querySelector("iframe")!;
    expect(iframe).toHaveAttribute("hidden");
    messageFrom(iframe, {
      type: "savia-editor-change",
      path: "entry.tsx",
      value: "unexpected edit",
      sequence: 1,
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("encodes file paths and rejects traversal outside the project", () => {
    expect(projectFileUri("src/a b.tsx")).toBe(
      "file:///workspace/src/a%20b.tsx",
    );
    for (const path of ["../entry.tsx", "/entry.tsx", "a/../b", "a\\b"])
      expect(() => projectFileUri(path)).toThrow("Invalid");
  });
});

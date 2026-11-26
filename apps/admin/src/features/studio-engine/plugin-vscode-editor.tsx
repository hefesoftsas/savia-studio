import { useEffect, useMemo, useRef, useState } from "react";
import { shallowEqual } from "ra-core";
import type {
  InstalledEditorExtension,
  ProjectEditorExtensionReference,
} from "@savia/studio-shared/plugin-editor-extensions";
import { transferEditorExtension } from "./plugin-editor-extension-transfer";
import type { PluginEditorExtensionClient } from "./plugin-editor-extension-client";
import { useMessages } from "@/i18n/core";
import { pluginEditorExtensionsMessages } from "./plugin-editor-extensions-messages";
import { editorEventSchema, type EditorState } from "./plugin-vscode-protocol";
import {
  acceptEditorEnvelope,
  resolvePluginEditorRuntimeUrl,
} from "./plugin-editor-session";
import { observePluginIdeTheme, readPluginIdeTheme } from "./plugin-ide-theme";

type CompletionRequest = {
  type: "savia-editor-completion";
  requestId: string;
  prefix: string;
  suffix: string;
};

function isCompletionRequest(value: unknown): value is CompletionRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<CompletionRequest>;
  return (
    message.type === "savia-editor-completion" &&
    typeof message.requestId === "string" &&
    message.requestId.length <= 80 &&
    typeof message.prefix === "string" &&
    typeof message.suffix === "string"
  );
}

function abortCompletions(pending: Map<string, AbortController>) {
  for (const controller of pending.values()) controller.abort();
  pending.clear();
}

export function PluginVscodeEditor({
  projectId = "draft",
  runtimeUrl = import.meta.env.VITE_PLUGIN_EDITOR_RUNTIME_URL,
  files,
  activeFile,
  extensions,
  installedExtensions = [],
  extensionSource,
  onExtensionStatus,
  onExtensionsApplied,
  readOnly,
  selection,
  formatRequest = 0,
  hidden = false,
  onChange,
  onSearch,
  onError,
  fetchCompletion,
}: {
  projectId?: string;
  runtimeUrl?: string;
  files: Record<string, string>;
  activeFile: string;
  extensions: string[];
  installedExtensions?: ProjectEditorExtensionReference[];
  extensionSource?: Pick<
    PluginEditorExtensionClient,
    "list" | "downloadPackage"
  >;
  onExtensionStatus?: (installationId: string, error: string | null) => void;
  onExtensionsApplied?: (
    references: ProjectEditorExtensionReference[],
    error?: string,
  ) => void;
  readOnly: boolean;
  selection?: { lineNumber: number; column: number; endColumn: number };
  formatRequest?: number;
  hidden?: boolean;
  onChange(path: string, value: string): void;
  onSearch(): void;
  onError(message: string): void;
  fetchCompletion?: (
    prefix: string,
    suffix: string,
    signal: AbortSignal,
  ) => Promise<string | null>;
}) {
  const runtime = resolvePluginEditorRuntimeUrl(runtimeUrl, location.origin);
  const session = useMemo(
    () => ({
      nonce: crypto.randomUUID(),
      projectId,
      parentOrigin: location.origin,
    }),
    [projectId, runtime?.href],
  );
  const frameOrigin = runtime?.origin ?? location.origin;
  const frameUrl = new URL(
    runtime?.href ?? "/plugin-editor.html",
    location.origin,
  );
  frameUrl.hash = new URLSearchParams(session).toString();
  const t = useMessages(pluginEditorExtensionsMessages);
  const [error, setError] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const [connection, setConnection] = useState<{
    session: typeof session;
  } | null>(null);
  const ready = connection?.session === session ? connection : null;
  const lastPosted = useRef<{
    controls: string;
    files: EditorState["files"];
    acknowledgements: EditorState["acknowledgements"];
  } | null>(null);
  const [theme, setTheme] = useState(() =>
    readPluginIdeTheme(document.documentElement),
  );
  const selectionId = useMemo(() => crypto.randomUUID(), [selection]);
  const loadedExtensions = useRef(new Map<string, InstalledEditorExtension>());
  const extensionTransfer = useRef<AbortController | null>(null);
  const packageAcks = useRef(
    new Map<string, { resolve(): void; reject(error: Error): void }>(),
  );
  const pendingEdits = useRef(
    new Map<string, { sequence: number; value: string }>(),
  );
  const pendingCompletions = useRef(new Map<string, AbortController>());
  const latest = useRef({
    files,
    activeFile,
    extensions,
    readOnly,
    selection,
    onChange,
    onSearch,
    onError,
    fetchCompletion,
    onExtensionStatus,
    onExtensionsApplied,
  });
  latest.current = {
    files,
    activeFile,
    extensions,
    readOnly,
    selection,
    onChange,
    onSearch,
    onError,
    fetchCompletion,
    onExtensionStatus,
    onExtensionsApplied,
  };

  useEffect(
    () => observePluginIdeTheme(document.documentElement, setTheme),
    [],
  );

  useEffect(() => {
    setError("");
    const completions = pendingCompletions.current;
    const resetConnection = () => {
      abortCompletions(completions);
      extensionTransfer.current?.abort();
      pendingEdits.current.clear();
      loadedExtensions.current.clear();
      lastPosted.current = null;
      for (const pending of packageAcks.current.values())
        pending.reject(new Error("Editor session ended."));
      packageAcks.current.clear();
    };
    let sessionActive = true;
    const listener = (event: MessageEvent) => {
      const data = acceptEditorEnvelope(
        event,
        frame.current?.contentWindow,
        frameOrigin,
        session,
      );
      if (!data) return;
      const ack = data as {
        type?: unknown;
        ackId?: unknown;
        error?: unknown;
        requestId?: unknown;
      };
      if (
        ack.type === "savia-editor-completion-cancel" &&
        typeof ack.requestId === "string" &&
        ack.requestId.length <= 80
      ) {
        const controller = completions.get(ack.requestId);
        completions.delete(ack.requestId);
        controller?.abort();
        return;
      }
      if (
        ack.type === "savia-editor-package-ack" &&
        typeof ack.ackId === "string" &&
        ack.ackId.length <= 80
      ) {
        const pending = packageAcks.current.get(ack.ackId);
        if (pending) {
          if (typeof ack.error === "string")
            pending.reject(new Error(ack.error.slice(0, 2000)));
          else pending.resolve();
        }
        return;
      }

      if (isCompletionRequest(data)) {
        if (
          data.prefix.length > 100 * 1024 ||
          data.suffix.length > 100 * 1024 ||
          completions.size >= 4 ||
          completions.has(data.requestId)
        )
          return;
        const controller = new AbortController();
        completions.set(data.requestId, controller);
        const requestFrame = event.source as Window;
        const current = latest.current;
        const canComplete =
          !current.readOnly &&
          current.activeFile === "entry.tsx" &&
          current.fetchCompletion !== undefined;
        void (async () => {
          let value: string | null = null;
          if (canComplete) {
            try {
              value = await current.fetchCompletion!(
                data.prefix,
                data.suffix,
                controller.signal,
              );
            } catch {
              value = null;
            }
          }
          const latestState = latest.current;
          if (latestState.readOnly || latestState.activeFile !== "entry.tsx")
            value = null;
          if (completions.get(data.requestId) !== controller) return;
          completions.delete(data.requestId);
          if (!sessionActive || requestFrame !== frame.current?.contentWindow)
            return;
          requestFrame.postMessage(
            {
              session,
              message: {
                type: "savia-editor-completion-result",
                requestId: data.requestId,
                value,
              },
            },
            frameOrigin,
          );
        })();
        return;
      }

      const parsed = editorEventSchema.safeParse(data);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === "savia-editor-ready") {
        resetConnection();
        setError("");
        setConnection({ session });
      } else if (message.type === "savia-editor-state-applied") {
        if (message.error) lastPosted.current = null;
        latest.current.onExtensionsApplied?.(
          message.installedExtensions,
          message.error,
        );
      } else if (message.type === "savia-editor-search") {
        latest.current.onSearch();
      } else if (message.type === "savia-editor-error") {
        setError(message.message);
        latest.current.onError(message.message);
      } else if (
        !latest.current.readOnly &&
        Object.hasOwn(latest.current.files, message.path)
      ) {
        const previous = pendingEdits.current.get(message.path);
        if (!previous || message.sequence > previous.sequence) {
          pendingEdits.current.set(message.path, {
            sequence: message.sequence,
            value: message.value,
          });
          latest.current.onChange(message.path, message.value);
        }
      }
    };
    window.addEventListener("message", listener);
    return () => {
      sessionActive = false;
      resetConnection();
      window.removeEventListener("message", listener);
    };
  }, [session, frameOrigin]);

  useEffect(() => {
    if (readOnly || activeFile !== "entry.tsx")
      abortCompletions(pendingCompletions.current);
  }, [activeFile, readOnly]);

  const referenceKey = JSON.stringify(
    installedExtensions.map(({ installationId, sha256 }) => ({
      installationId,
      sha256,
    })),
  );
  // Acknowledgements may change between commits with identical file contents.
  useEffect(() => {
    const target = frame.current?.contentWindow;
    if (!ready || !target) return;
    const acknowledgements: Record<string, number> = {};
    for (const [path, pending] of pendingEdits.current) {
      if (!Object.hasOwn(files, path)) pendingEdits.current.delete(path);
      else if (files[path] === pending.value)
        acknowledgements[path] = pending.sequence;
    }
    const controls = JSON.stringify([
      activeFile,
      extensions,
      referenceKey,
      readOnly,
      selectionId,
      theme,
    ]);
    const previous = lastPosted.current;
    if (
      previous?.controls === controls &&
      shallowEqual(previous.files, files) &&
      shallowEqual(previous.acknowledgements, acknowledgements)
    )
      return;
    target.postMessage(
      {
        session,
        message: {
          type: "savia-editor-state",
          files,
          activeFile,
          acknowledgements,
          extensions,
          installedExtensions,
          readOnly,
          selection: selection ?? null,
          selectionId,
          theme,
        } satisfies Omit<EditorState, "extensions"> & { extensions: string[] },
      },
      frameOrigin,
    );
    lastPosted.current = { controls, files, acknowledgements };
  });

  useEffect(() => {
    const source = extensionSource;
    if (!ready || !runtime || !source) return;
    const references = JSON.parse(
      referenceKey,
    ) as ProjectEditorExtensionReference[];
    const active = loadedExtensions.current;
    for (const [id, installation] of active)
      if (
        !references.some(
          (ref) =>
            ref.installationId === id && ref.sha256 === installation.sha256,
        )
      )
        active.delete(id);
    const missing = references.filter((ref) => !active.has(ref.installationId));
    if (!missing.length) return;
    const controller = new AbortController();
    const { signal } = controller;
    extensionTransfer.current = controller;
    const reportFailure = (installationId: string, reason: unknown) =>
      latest.current.onExtensionStatus?.(
        installationId,
        String(reason).slice(0, 2000),
      );
    void (async () => {
      let byInstallation: Map<string, InstalledEditorExtension>;
      try {
        const installed = await source.list(signal);
        byInstallation = new Map(
          installed.map((installation) => [
            installation.installationId,
            installation,
          ]),
        );
      } catch (error) {
        if (!signal.aborted)
          for (const ref of missing) reportFailure(ref.installationId, error);
        return;
      }
      if (signal.aborted) return;
      const pending: InstalledEditorExtension[] = [];
      for (const reference of missing) {
        const installation = byInstallation.get(reference.installationId);
        if (!installation || installation.sha256 !== reference.sha256) {
          reportFailure(
            reference.installationId,
            "Installed extension is unavailable.",
          );
          continue;
        }
        pending.push(installation);
      }
      while (pending.length && !signal.aborted) {
        const activeIds = new Set([...active.values()].map(({ id }) => id));
        const index = pending.findIndex(({ dependencies }) =>
          dependencies.every((dependency) => activeIds.has(dependency)),
        );
        if (index < 0) {
          for (const installation of pending)
            reportFailure(
              installation.installationId,
              "Extension packages have missing or circular dependencies.",
            );
          return;
        }
        const [installation] = pending.splice(index, 1);
        const { installationId } = installation;
        try {
          const bytes = await source.downloadPackage(installationId, signal);
          if (signal.aborted) return;
          await transferEditorExtension(
            session,
            installation,
            bytes,
            async (envelope) => {
              const target = frame.current?.contentWindow;
              if (!target || signal.aborted)
                throw new Error("Editor session changed.");
              const ackId = crypto.randomUUID();
              const payload = envelope as {
                session: unknown;
                message: Record<string, unknown>;
              };
              await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                  clearTimeout(timer);
                  signal.removeEventListener("abort", abort);
                  packageAcks.current.delete(ackId);
                };
                const fail = (error: unknown) => {
                  cleanup();
                  reject(error);
                };
                const abort = () => fail(new Error("Editor session changed."));
                const timer = setTimeout(
                  () => fail(new Error("Extension activation timed out.")),
                  15000,
                );
                packageAcks.current.set(ackId, {
                  resolve: () => {
                    cleanup();
                    resolve();
                  },
                  reject: fail,
                });
                signal.addEventListener("abort", abort, { once: true });
                try {
                  target.postMessage(
                    { ...payload, message: { ...payload.message, ackId } },
                    frameOrigin,
                  );
                } catch (error) {
                  fail(error);
                }
              });
            },
          );
          if (signal.aborted) return;
          active.set(installationId, installation);
          latest.current.onExtensionStatus?.(installationId, null);
        } catch (error) {
          if (signal.aborted) return;
          reportFailure(installationId, error);
        }
      }
    })();
    return () => {
      controller.abort();
      if (extensionTransfer.current === controller)
        extensionTransfer.current = null;
    };
  }, [ready, referenceKey, session, frameOrigin, extensionSource]);

  const observedFormatRequest = useRef(formatRequest);
  const pendingFormatRequests = useRef(0);
  useEffect(() => {
    if (formatRequest < observedFormatRequest.current) {
      observedFormatRequest.current = formatRequest;
      pendingFormatRequests.current = 0;
    } else {
      pendingFormatRequests.current +=
        formatRequest - observedFormatRequest.current;
      observedFormatRequest.current = formatRequest;
    }
    if (!ready || readOnly) return;
    while (pendingFormatRequests.current > 0) {
      frame.current?.contentWindow?.postMessage(
        { session, message: { type: "savia-editor-format" } },
        frameOrigin,
      );
      pendingFormatRequests.current -= 1;
    }
  }, [formatRequest, ready, readOnly, session, frameOrigin]);

  return (
    <>
      {!hidden && (!ready || error) && (
        <p role={error ? "alert" : "status"}>{error || t("loading")}</p>
      )}
      <iframe
        key={session.nonce}
        ref={frame}
        className="plugin-vscode-editor"
        src={frameUrl.href}
        title={activeFile}
        hidden={hidden}
        sandbox="allow-scripts allow-same-origin"
      />
    </>
  );
}

import PluginEditorTypeScriptWorker from "./plugin-editor-typescript-worker?worker";
import type {
  PluginEditorCompletionEntry,
  PluginEditorFileMap,
} from "./plugin-editor-typescript-service";

type Request = {
  id: number;
  files: PluginEditorFileMap;
  path: string;
  offset: number;
};

type Response =
  | { id: number; entries: PluginEditorCompletionEntry[] }
  | { id: number; error: string };

type PendingRequest = {
  resolve: (entries: PluginEditorCompletionEntry[]) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
};

type WorkerSession = { instance: Worker; hasResponded: boolean };

const requestTimeoutMs = 5_000;
const startupTimeoutMs = 20_000;
const pending = new Map<number, PendingRequest>();
let activeWorker: WorkerSession | undefined;
let nextRequestId = 0;

function takePending(id: number) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  clearTimeout(request.timeout);
  request.removeAbortListener?.();
  return request;
}

function retireWorker(session: WorkerSession, error: Error) {
  if (activeWorker !== session) return;
  activeWorker = undefined;
  session.instance.terminate();
  for (const id of pending.keys()) takePending(id)?.reject(error);
}

function ensureWorker(): WorkerSession {
  if (activeWorker) return activeWorker;
  const session: WorkerSession = {
    instance: new PluginEditorTypeScriptWorker(),
    hasResponded: false,
  };
  session.instance.addEventListener(
    "message",
    (event: MessageEvent<Response>) => {
      if (activeWorker !== session) return;
      session.hasResponded = true;
      const response = event.data;
      const request = takePending(response.id);
      if (!request) return;
      if ("error" in response) request.reject(new Error(response.error));
      else request.resolve(response.entries);
    },
  );
  session.instance.addEventListener("error", () => {
    retireWorker(session, new Error("TypeScript completion worker failed"));
  });
  activeWorker = session;
  return session;
}

export function complete(
  files: PluginEditorFileMap,
  path: string,
  offset: number,
  signal?: AbortSignal,
): Promise<PluginEditorCompletionEntry[]> {
  if (signal?.aborted) return Promise.resolve([]);
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    try {
      const session = ensureWorker();
      const timeout = setTimeout(
        () =>
          retireWorker(session, new Error("TypeScript completion timed out")),
        session.hasResponded ? requestTimeoutMs : startupTimeoutMs,
      );
      const cancel = () => takePending(id)?.resolve([]);
      pending.set(id, {
        resolve,
        reject,
        timeout,
        removeAbortListener: signal
          ? () => signal.removeEventListener("abort", cancel)
          : undefined,
      });
      signal?.addEventListener("abort", cancel, { once: true });
      const request: Request = { id, files, path, offset };
      session.instance.postMessage(request);
    } catch (error) {
      takePending(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function disposePluginEditorTypeScriptClient() {
  if (activeWorker)
    retireWorker(
      activeWorker,
      new Error("TypeScript completion worker was disposed"),
    );
}

export class PluginEditorTypescriptClient {
  complete = complete;
  dispose = disposePluginEditorTypeScriptClient;
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", disposePluginEditorTypeScriptClient);
}

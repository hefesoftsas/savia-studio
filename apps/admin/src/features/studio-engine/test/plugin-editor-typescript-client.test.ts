import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  complete,
  disposePluginEditorTypeScriptClient,
} from "../plugin-editor-typescript-client";

const { workers, WorkerFixture } = vi.hoisted(() => {
  const workers: WorkerFixture[] = [];
  class WorkerFixture extends EventTarget {
    postMessage = vi.fn<(message: { id: number }) => void>();
    terminate = vi.fn();
    constructor() {
      super();
      workers.push(this);
    }
  }
  return { workers, WorkerFixture };
});
vi.mock("../plugin-editor-typescript-worker?worker", () => ({
  default: WorkerFixture,
}));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  disposePluginEditorTypeScriptClient();
  workers.length = 0;
  vi.useRealTimers();
});

const request = (signal?: AbortSignal) =>
  complete({ "entry.ts": "const value = 1;" }, "entry.ts", 5, signal);
function respond(worker: InstanceType<typeof WorkerFixture>) {
  const [message] = worker.postMessage.mock.lastCall!;
  worker.dispatchEvent(
    new MessageEvent("message", { data: { id: message.id, entries: [] } }),
  );
}

it("replaces a worker that stops responding and ignores its late errors", async () => {
  const startup = request();
  const oldWorker = workers[0];
  respond(oldWorker);
  await expect(startup).resolves.toEqual([]);

  const first = expect(request()).rejects.toThrow("timed out");
  const second = expect(request()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(5_000);
  await Promise.all([first, second]);
  expect(oldWorker.terminate).toHaveBeenCalledTimes(1);

  const next = request();
  expect(workers).toHaveLength(2);
  oldWorker.dispatchEvent(new Event("error"));
  respond(workers[1]);
  await expect(next).resolves.toEqual([]);
});

it("allows the first response more time while loading TypeScript", async () => {
  expect(workers).toHaveLength(0);
  const settled = vi.fn();
  const startup = request();
  void startup.then(settled, settled);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(settled).not.toHaveBeenCalled();
  respond(workers[0]);
  await expect(startup).resolves.toEqual([]);
});

it("retires a worker that never finishes loading", async () => {
  const startup = expect(request()).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(20_000);
  await startup;
  expect(workers[0].terminate).toHaveBeenCalledTimes(1);
});

it("does not start a worker for an already canceled completion", async () => {
  const abort = new AbortController();
  abort.abort();
  const outcome = vi.fn();
  void request(abort.signal).then(outcome, outcome);
  await vi.advanceTimersByTimeAsync(0);
  expect(workers).toHaveLength(0);
  expect(outcome).toHaveBeenCalledWith([]);
});

it("cancels a stale completion deadline while leaving the next request active", async () => {
  const startup = request();
  const worker = workers[0];
  respond(worker);
  await startup;

  const abort = new AbortController();
  const canceled = vi.fn();
  void request(abort.signal).then(canceled, canceled);
  await vi.advanceTimersByTimeAsync(3_000);
  const upcoming = vi.fn();
  void request().then(upcoming, upcoming);
  abort.abort();

  await vi.advanceTimersByTimeAsync(2_000);
  expect(canceled).toHaveBeenCalledWith([]);
  expect(worker.terminate).not.toHaveBeenCalled();
  expect(upcoming).not.toHaveBeenCalled();
  respond(worker);
  await vi.advanceTimersByTimeAsync(0);
  expect(upcoming).toHaveBeenCalledWith([]);
  expect(workers).toHaveLength(1);
});

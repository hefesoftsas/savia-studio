import { expect, it, vi } from "vitest";
import { RequestTimeoutError, withRequestTimeout } from "./request-timeout";

it("does not start an operation whose caller already cancelled it", async () => {
  const controller = new AbortController();
  const reason = new DOMException("View exited", "AbortError");
  controller.abort(reason);
  const operation = vi.fn(async () => "response");

  await expect(
    withRequestTimeout(operation, 1000, controller.signal),
  ).rejects.toBe(reason);
  expect(operation).not.toHaveBeenCalled();
});

it("rejects caller cancellation when the operation produces a fallback on abort", async () => {
  const controller = new AbortController();
  const reason = new DOMException("View exited", "AbortError");
  const abortOperation = vi.fn();
  const result = withRequestTimeout(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            abortOperation(signal.reason);
            resolve("fallback");
          },
          { once: true },
        );
      }),
    1000,
    controller.signal,
  );

  controller.abort(reason);

  await expect(result).rejects.toBe(reason);
  expect(abortOperation).toHaveBeenCalledWith(reason);
});

it("rejects cancellation triggered while the operation starts", async () => {
  const controller = new AbortController();
  const reason = new DOMException("View exited", "AbortError");

  await expect(
    withRequestTimeout(
      () => {
        controller.abort(reason);
        return Promise.resolve("cached result");
      },
      1000,
      controller.signal,
    ),
  ).rejects.toBe(reason);
});

it("reports the deadline even when the transport rejects with a different abort error", async () => {
  vi.useFakeTimers();
  try {
    const abortOperation = vi.fn();
    const result = withRequestTimeout(
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              abortOperation(signal.reason);
              reject(new DOMException("Transport aborted", "AbortError"));
            },
            { once: true },
          );
        }),
      1000,
    );
    const outcome = result.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(1000);

    const error = await outcome;
    expect(error).toBeInstanceOf(RequestTimeoutError);
    expect(error).toMatchObject({ timeoutMs: 1000 });
    expect(abortOperation).toHaveBeenCalledWith(error);
  } finally {
    vi.useRealTimers();
  }
});

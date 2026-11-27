export const REQUEST_TIMEOUT_MS = 15_000;

export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs = REQUEST_TIMEOUT_MS) {
    super(
      "La solicitud tardó demasiado. Comprueba tu conexión e inténtalo de nuevo.",
    );
    this.name = "RequestTimeoutError";
  }
}

/** Ends a stalled operation and aborts its network request when the limit is reached. */
export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal, restartDeadline: () => void) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS,
  externalSignal?: AbortSignal | null,
): Promise<T> {
  if (externalSignal?.aborted)
    throw externalSignal.reason ?? new DOMException("Aborted", "AbortError");

  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  try {
    return await new Promise<T>((resolve, reject) => {
      const cancel = (reason: unknown) => {
        // Settle the caller's promise before the transport reacts to the abort.
        reject(reason);
        controller.abort(reason);
      };

      if (externalSignal) {
        const abort = () =>
          cancel(
            externalSignal.reason ?? new DOMException("Aborted", "AbortError"),
          );
        externalSignal.addEventListener("abort", abort, { once: true });
        removeAbortListener = () =>
          externalSignal.removeEventListener("abort", abort);
      }

      const onDeadline = () => cancel(new RequestTimeoutError(timeoutMs));
      const restartDeadline = () => {
        if (timeoutId === undefined || controller.signal.aborted) return;
        clearTimeout(timeoutId);
        timeoutId = setTimeout(onDeadline, timeoutMs);
      };
      timeoutId = setTimeout(onDeadline, timeoutMs);
      void operation(controller.signal, restartDeadline).then(resolve, reject);
    });
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    timeoutId = undefined;
    removeAbortListener?.();
  }
}

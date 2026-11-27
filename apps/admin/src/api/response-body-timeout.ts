import { REQUEST_TIMEOUT_MS, withRequestTimeout } from "./request-timeout";

export function readResponseBodyWithInactivityTimeout<T>(
  response: Response,
  read: (input: Response) => Promise<T>,
  callerSignal?: AbortSignal | null,
): Promise<T> {
  const body = response.body;
  if (callerSignal?.aborted) {
    const reason =
      callerSignal.reason ?? new DOMException("Aborted", "AbortError");
    void body?.cancel(reason).catch(() => undefined);
    return Promise.reject(reason);
  }
  if (!body) return read(response);

  return withRequestTimeout(
    (signal, restartDeadline) => {
      const stream = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            if (chunk.byteLength > 0) restartDeadline();
            controller.enqueue(chunk);
          },
        }),
        { signal },
      );
      return read(new Response(stream, { headers: response.headers }));
    },
    REQUEST_TIMEOUT_MS,
    callerSignal,
  );
}

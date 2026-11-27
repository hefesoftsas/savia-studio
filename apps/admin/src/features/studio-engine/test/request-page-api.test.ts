import { afterEach, expect, it, vi } from "vitest";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "@/api/request-timeout";
import { requestPageApi } from "../request-page-api";
import { setStudioRuntime } from "../runtime";

afterEach(() => {
  setStudioRuntime({ embedded: false });
  vi.useRealTimers();
});

it.each([
  { label: "history", status: 200, path: "/runs?tenantId=0&pageName=quote" },
  { label: "submission", status: 200, path: "/runs", body: { id: "test" } },
  { label: "HTTP failure", status: 503, path: "/openapi.json" },
])("cancels a stalled $label response body", async ({ status, path, body }) => {
  vi.useFakeTimers();
  const rejected = vi.fn();
  const cancel = vi.fn();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
  setStudioRuntime({
    embedded: true,
    requestTransport: async () => response,
  });
  try {
    void requestPageApi(path, body).catch(rejected);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(cancel).toHaveBeenCalledExactlyOnceWith(
      expect.any(RequestTimeoutError),
    );
    expect(rejected).toHaveBeenCalledExactlyOnceWith(
      status === 200
        ? expect.any(RequestTimeoutError)
        : expect.objectContaining({ status }),
    );
  } finally {
    if (!cancel.mock.calls.length) stream.close();
  }
});

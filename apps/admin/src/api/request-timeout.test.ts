import { expect, it, vi } from "vitest";
import { withRequestTimeout } from "./request-timeout";

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

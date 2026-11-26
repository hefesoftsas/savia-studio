import { I18nContextProvider } from "ra-core";
import type { ReactElement, ReactNode } from "react";
import {
  act,
  cleanup,
  render as testingRender,
  renderHook,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PublicReceiptResult } from "./public-comparison";
import { usePublicFormSubmission } from "./public-form-submission";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <I18nContextProvider
      value={{
        translate: (key: string) => key,
        changeLocale: async () => {},
        getLocale: () => "es",
      }}
    >
      {children}
    </I18nContextProvider>
  );
}

function render(ui: ReactElement) {
  return testingRender(ui, { wrapper: Wrapper });
}

it("hides unknown receipt structures", () => {
  const { container } = render(<PublicReceiptResult result={{ nope: true }} />);
  expect(container).toBeEmptyDOMElement();
});

it.each(["headers", "body"])(
  "leaves the waiting state when the submission stalls on %s",
  async (stage) => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => {});
    const fetcher = vi.fn((_url: string, _init: RequestInit) =>
      Promise.resolve(Response.json({ ok: true, reference: "retried" })),
    );
    fetcher.mockImplementationOnce(async () => {
      if (stage === "headers") return stalled;
      const response = Response.json({});
      vi.spyOn(response, "json").mockReturnValue(stalled);
      return response;
    });
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(
      () =>
        usePublicFormSubmission({
          definition: { id: "form-id", captchaProvider: "disabled" },
          endpoint: "/api/public/forms/test-link",
        }),
      { wrapper: Wrapper },
    );

    let submission!: Promise<void>;
    act(() => {
      submission = result.current.submit({ name: "Ada" });
    });
    expect(result.current.pending).toBe(true);
    const submissionId = result.current.submissionId;
    await act(async () => vi.advanceTimersByTimeAsync(180_000));
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(result.current.uncertain).toBe(true);
    expect(result.current.submissionId).toBe(submissionId);
    await submission;

    await act(async () => result.current.submit({ name: "Changed" }));
    expect(fetcher.mock.calls[1][1].body).toBe(fetcher.mock.calls[0][1].body);
    expect(result.current.receipt?.reference).toBe("retried");
  },
);

it.each([200, 409, 503])(
  "keeps the recovered receipt when the superseded submit resolves with %s",
  async (status) => {
    let resolvePost!: (response: Response) => void;
    const fetcher = vi.fn(
      (_url: string, _init: RequestInit) =>
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(
      () =>
        usePublicFormSubmission({
          definition: { id: "form-id", captchaProvider: "disabled" },
          endpoint: "/api/public/forms/test-link",
        }),
      { wrapper: Wrapper },
    );

    let submission!: Promise<void>;
    act(() => {
      submission = result.current.submit({ name: "Ada" });
    });
    expect(result.current.pending).toBe(true);
    act(() =>
      result.current.completeFromStatus(result.current.submissionId!, {
        ok: true,
        reference: "recovered-receipt",
        result: { quotes: [] },
      }),
    );
    expect(fetcher.mock.calls[0][1].signal?.aborted).toBe(true);

    await act(async () => {
      resolvePost(
        Response.json({ ok: true, reference: "late-result" }, { status }),
      );
      await submission;
    });
    expect(result.current.receipt?.reference).toBe("recovered-receipt");
    expect(result.current.duplicate).toBe(false);
    expect(result.current.uncertain).toBe(false);
    expect(result.current.error).toBe("");
    expect(result.current.pending).toBe(false);
  },
);

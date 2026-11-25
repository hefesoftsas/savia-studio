import { describe, expect, it, vi } from "vitest";
import { oauthPageResponse } from "../src/oauth-pages";

async function loadingHarness(
  formKind = "sign-in",
  discoverHome?: () => Promise<Response>,
  search = "",
) {
  const loading = { hidden: true };
  const content = { hidden: false };
  const resume = { hidden: true, href: "" };
  const focusCode = vi.fn(() => {
    expect(content.hidden).toBe(false);
    expect(secondFactor.hidden).toBe(false);
  });
  const secondFactor = {
    hidden: formKind === "sign-in",
    querySelector: (selector: string) =>
      selector === 'input[name="code"]' ? { focus: focusCode } : null,
  };
  const status = { textContent: "" };
  const button = { disabled: false };
  let submit!: (event: { preventDefault(): void }) => Promise<void>;
  let resolve!: (response: Response) => void;
  let reject!: (error: unknown) => void;
  let signal: AbortSignal | null | undefined;
  let blurEmail: (() => void) | undefined;
  const email = {
    value: "user@example.test",
    addEventListener(event: string, listener: () => void) {
      if (event === "blur") blurEmail = listener;
    },
  };
  const pending = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const redirects: string[] = [];
  const form = {
    dataset: { oauthForm: formKind },
    hidden: false,
    querySelector: (selector: string) =>
      selector === 'input[name="code"]' ? { focus: focusCode } : button,
    addEventListener: (_: string, listener: typeof submit) => {
      submit = listener;
    },
  };
  const targets: Record<string, unknown> = {
    "[data-oauth-loading]": loading,
    "[data-oauth-content]": content,
    "[data-oauth-resume]": resume,
    "[data-oauth-two-factor]": secondFactor,
    "#oauth-status": status,
    "#email": discoverHome ? email : null,
    [`[data-oauth-form="${formKind}"]`]: form,
  };
  const script = await oauthPageResponse(
    new Request("https://example.test/api/auth/oauth-ui.js"),
  )!.text();
  new Function("window", "document", "fetch", "FormData", script)(
    {
      location: {
        search,
        href: "https://example.test/api/auth/login",
        hostname: "example.test",
        host: "example.test",
        port: "",
        assign: (url: string) => redirects.push(url),
      },
    },
    {
      querySelector: (selector: string) => targets[selector] ?? null,
      querySelectorAll: () => [form],
    },
    (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/auth/tenant-home?")) return discoverHome?.();
      signal = init?.signal;
      signal?.addEventListener("abort", () => reject(signal?.reason), {
        once: true,
      });
      return pending;
    },
    class {
      get(name: string) {
        return name === "email" ? "user@example.test" : "password";
      }
    },
  );
  return {
    loading,
    content,
    resume,
    secondFactor,
    focusCode,
    status,
    button,
    redirects,
    blurEmail: () => blurEmail?.(),
    requestSignal: () => signal,
    resolve,
    submit,
  };
}

describe("shared authentication loading", () => {
  it("focuses the authenticator field after returning from SSO", async () => {
    const h = await loadingHarness("sign-in", undefined, "?mode=sso-mfa");
    expect(h.secondFactor.hidden).toBe(false);
    expect(h.status.textContent).toContain("Ingresa tu segundo factor");
    expect(h.focusCode).toHaveBeenCalledOnce();
    expect(h.requestSignal()).toBeUndefined();
  });

  it.each(["pending", "failed"])(
    "ignores a tenant lookup after the user submits credentials (%s sign-in)",
    async (phase) => {
      let settle!: (response: Response) => void;
      const pendingHome = new Promise<Response>((resolve) => {
        settle = resolve;
      });
      const h = await loadingHarness("sign-in", () => pendingHome);
      h.blurEmail();
      const submitted = h.submit({ preventDefault() {} });

      if (phase === "failed") {
        h.resolve(
          Response.json({ message: "Invalid credentials" }, { status: 401 }),
        );
        await submitted;
      }
      settle(Response.json({ found: true, slug: "acme", tenantId: 42 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.redirects).toEqual([]);

      if (phase === "pending") {
        h.resolve(Response.json({ twoFactorRedirect: true }));
        await submitted;
        expect(h.secondFactor.hidden).toBe(false);
      } else {
        expect(h.status.textContent).toBe("Invalid credentials");
      }
    },
  );

  it.each(["verify-totp", "verify-backup-code", "verify-enrollment"])(
    "restores focus to an unsuccessful %s submission",
    async (formKind) => {
      const h = await loadingHarness(formKind);
      const submitted = h.submit({ preventDefault() {} });
      expect(h.content.hidden).toBe(true);
      h.resolve(Response.json({ message: "Invalid code" }, { status: 400 }));
      await submitted;
      expect(h.status.textContent).toBe("Invalid code");
      expect(h.button.disabled).toBe(false);
      expect(h.focusCode).toHaveBeenCalledOnce();
      expect(h.redirects).toEqual([]);
    },
  );

  it.each(["response headers", "response body"])(
    "restores the form after the authentication request stalls in %s",
    async (phase) => {
      vi.useFakeTimers();
      try {
        const h = await loadingHarness();
        const submitted = h.submit({ preventDefault() {} });
        if (phase === "response body")
          h.resolve(
            new Response(
              new ReadableStream({
                start(controller) {
                  h.requestSignal()?.addEventListener(
                    "abort",
                    () => controller.error(h.requestSignal()?.reason),
                    { once: true },
                  );
                },
              }),
            ),
          );

        await vi.advanceTimersByTimeAsync(15_000);
        expect(h.loading.hidden).toBe(true);
        expect(h.content.hidden).toBe(false);
        expect(h.button.disabled).toBe(false);
        expect(h.status.textContent).toContain("La solicitud tardó demasiado");
        expect(h.requestSignal()?.aborted).toBe(true);
        expect(h.redirects).toEqual([]);
        await submitted;
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["error", "second-factor"] as const)(
    "restores the form for %s",
    async (outcome) => {
      const h = await loadingHarness();
      const submitted = h.submit({ preventDefault() {} });
      expect(h.loading.hidden).toBe(false);
      expect(h.content.hidden).toBe(true);
      expect(h.button.disabled).toBe(true);
      h.resolve(
        outcome === "error"
          ? Response.json({ message: "Invalid credentials" }, { status: 401 })
          : Response.json({ twoFactorRedirect: true }),
      );
      await submitted;
      expect(h.loading.hidden).toBe(true);
      expect(h.content.hidden).toBe(false);
      expect(h.button.disabled).toBe(false);
      if (outcome === "error") {
        expect(h.status.textContent).toBe("Invalid credentials");
        expect(h.focusCode).not.toHaveBeenCalled();
      } else {
        expect(h.secondFactor.hidden).toBe(false);
        expect(h.focusCode).toHaveBeenCalledOnce();
      }
    },
  );

  it("keeps the shared splash visible while navigating to the application", async () => {
    const h = await loadingHarness();
    const submitted = h.submit({ preventDefault() {} });
    h.resolve(Response.json({ url: "https://example.test/auth/callback" }));
    await submitted;
    expect(h.redirects).toEqual(["https://example.test/auth/callback"]);
    expect(h.loading.hidden).toBe(false);
    expect(h.content.hidden).toBe(true);
  });
  it("restores a manual continuation when browser navigation does not finish", async () => {
    vi.useFakeTimers();
    try {
      const h = await loadingHarness();
      const submitted = h.submit({ preventDefault() {} });
      h.resolve(Response.json({ url: "https://example.test/auth/callback" }));
      await submitted;
      await vi.advanceTimersByTimeAsync(10000);
      expect(h.loading.hidden).toBe(true);
      expect(h.content.hidden).toBe(false);
      expect(h.resume.hidden).toBe(false);
      expect(h.resume.href).toBe("https://example.test/auth/callback");
      expect(h.status.textContent).toContain("Continuar");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

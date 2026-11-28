import { describe, expect, it, vi } from "vitest";
import { oauthPageResponse } from "../src/oauth-pages";

async function loadingHarness(
  formKind = "sign-in",
  discoverHome?: () => Promise<Response>,
  search = "",
  honorAbort = true,
  restartUrl?: string,
) {
  const loading = { hidden: true };
  const content = { hidden: false };
  const resume = { hidden: true, href: "" };
  const focusCode = vi.fn(() => {
    expect(content.hidden).toBe(false);
    expect(
      (formKind === "enable-totp" ? enrollment : secondFactor).hidden,
    ).toBe(false);
  });
  const secondFactor = {
    hidden: formKind === "sign-in",
    querySelector: (selector: string) =>
      selector === 'input[name="code"]' ? { focus: focusCode } : null,
  };
  const status = { textContent: "" };
  const button = {
    disabled: false,
    textContent: "Verificar código",
    focus: vi.fn(),
  };
  const codeInput = { disabled: false, value: "123456", focus: focusCode };
  const enrollment = {
    hidden: true,
    querySelector: (selector: string) =>
      selector === 'input[name="code"]' ? codeInput : null,
  };
  const requests: string[] = [];
  const requestBodies: unknown[] = [];
  let retrySSO!: () => Promise<void>;
  const ssoContinue = {
    hidden: true,
    focus: vi.fn(),
    addEventListener(_event: string, listener: () => Promise<void>) {
      retrySSO = listener;
    },
  };
  const ssoComplete =
    formKind === "sso-complete"
      ? {
          querySelector: (selector: string) =>
            selector === "[data-sso-continue]" ? ssoContinue : null,
        }
      : null;
  let submit!: (event: { preventDefault(): void }) => Promise<void>;
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | null | undefined;
  let blurEmail: (() => void) | undefined;
  const email = {
    value: "user@example.test",
    addEventListener(event: string, listener: () => void) {
      if (event === "blur") blurEmail = listener;
    },
  };
  const redirects: string[] = [];
  const form = {
    dataset: { oauthForm: formKind },
    hidden: false,
    querySelector: (selector: string) =>
      selector === 'input[name="code"]' ? codeInput : button,
    addEventListener: (_: string, listener: typeof submit) => {
      submit = listener;
    },
  };
  const targets: Record<string, unknown> = {
    "[data-oauth-loading]": loading,
    "[data-oauth-content]": content,
    "[data-oauth-resume]": resume,
    "[data-oauth-two-factor]": secondFactor,
    "[data-oauth-enrollment]": enrollment,
    "[data-sso-complete]": ssoComplete,
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
        replace: (url: string) => redirects.push(url),
      },
    },
    {
      body: { dataset: { oauthRestartUrl: restartUrl } },
      querySelector: (selector: string) => targets[selector] ?? null,
      querySelectorAll: () => [form],
    },
    (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/auth/tenant-home?")) return discoverHome?.();
      requests.push(url);
      requestBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const requestSignal = init?.signal;
      signal = requestSignal;
      return new Promise<Response>((done, fail) => {
        resolve = done;
        if (honorAbort)
          requestSignal?.addEventListener(
            "abort",
            () => fail(requestSignal?.reason),
            {
              once: true,
            },
          );
      });
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
    enrollment,
    form,
    focusCode,
    status,
    button,
    codeInput,
    requests,
    requestBodies,
    retrySSO: () => retrySSO(),
    ssoContinue,
    redirects,
    blurEmail: () => blurEmail?.(),
    requestSignal: () => signal,
    resolve: (response: Response) => resolve(response),
    submit,
  };
}

describe("shared authentication loading", () => {
  it("retries an interrupted SSO continuation with the same signed request", async () => {
    const query = "sig=test&ba_param=state&state=destination";
    const h = await loadingHarness("sso-complete", undefined, "?" + query);
    expect(h.requests).toEqual(["/api/auth/oauth2/continue"]);
    expect(h.loading.hidden).toBe(false);
    expect(h.ssoContinue.hidden).toBe(true);

    h.resolve(
      Response.json({ message: "Servicio no disponible" }, { status: 503 }),
    );
    await vi.waitFor(() => expect(h.ssoContinue.hidden).toBe(false));
    expect(h.loading.hidden).toBe(true);
    expect(h.ssoContinue.focus).toHaveBeenCalledOnce();

    const retry = h.retrySSO();
    const duplicate = h.retrySSO();
    const destination = "https://example.test/auth/callback?code=accepted";
    h.resolve(Response.json({ url: destination }));
    await Promise.all([retry, duplicate]);
    expect(h.requests).toEqual([
      "/api/auth/oauth2/continue",
      "/api/auth/oauth2/continue",
    ]);
    expect(h.requestBodies).toEqual([
      { postLogin: true, oauth_query: query },
      { postLogin: true, oauth_query: query },
    ]);
    expect(h.redirects).toEqual([destination]);
  });

  it("starts a new sign-in with the original destination if the SSO session is gone", async () => {
    const restartUrl = "https://example.test/#/login?resume=bookings";
    const h = await loadingHarness(
      "sso-complete",
      undefined,
      "?sig=test&ba_param=state&state=destination",
      true,
      restartUrl,
    );
    h.resolve(Response.json({ message: "Unauthorized" }, { status: 401 }));

    await vi.waitFor(() => expect(h.redirects).toEqual([restartUrl]));
    expect(h.ssoContinue.hidden).toBe(true);
    expect(h.requests).toEqual(["/api/auth/oauth2/continue"]);
  });

  it("returns to sign-in for the same application when consent loses its session", async () => {
    const query = new URLSearchParams([
      ["sig", "active-request"],
      ["ba_param", "client_id"],
      ["ba_param", "redirect_uri"],
      ["ba_param", "state"],
      ["client_id", "savia-integration"],
      ["redirect_uri", "https://client.example.test/oauth/callback"],
      ["state", "original-request"],
    ]).toString();
    const h = await loadingHarness(
      "consent",
      undefined,
      "?" + query + "&mode=forgot",
      true,
      "https://example.test/#/login",
    );
    const submission = h.submit({ preventDefault() {} });
    h.resolve(Response.json({ code: "UNAUTHORIZED" }, { status: 401 }));
    await submission;

    expect(h.requests).toEqual(["/api/auth/oauth2/consent"]);
    expect(h.requestBodies).toEqual([{ accept: true, oauth_query: query }]);
    expect(h.redirects).toEqual(["/api/auth/login?" + query]);
    expect(h.loading.hidden).toBe(false);
  });

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

  it.each([
    ["verify-totp", "verify-totp"],
    ["verify-backup-code", "verify-backup-code"],
    ["verify-enrollment", "verify-totp"],
  ])(
    "retries OAuth continuation after %s was accepted",
    async (formKind, endpoint) => {
      const h = await loadingHarness(
        formKind,
        undefined,
        "?sig=test&ba_param=state&state=admin",
      );
      const submission = h.submit({ preventDefault() {} });
      h.resolve(Response.json({ user: { id: "verified" } }));
      await vi.waitFor(() =>
        expect(h.requests).toEqual([
          `/api/auth/two-factor/${endpoint}`,
          "/api/auth/oauth2/continue",
        ]),
      );
      h.resolve(
        Response.json({ message: "Service unavailable" }, { status: 503 }),
      );
      await submission;
      expect(h.status.textContent).toContain("Pulsa Continuar a Savia");
      expect(h.button.disabled).toBe(false);
      expect(h.button.textContent).toBe("Continuar a Savia");
      expect(h.button.focus).toHaveBeenCalledOnce();
      expect(h.codeInput.disabled).toBe(true);
      expect(h.codeInput.value).toBe("");

      const retry = h.submit({ preventDefault() {} });
      expect(h.requests).toEqual([
        `/api/auth/two-factor/${endpoint}`,
        "/api/auth/oauth2/continue",
        "/api/auth/oauth2/continue",
      ]);
      const destination = "https://example.test/callback";
      h.resolve(Response.json({ url: destination }));
      await retry;
      expect(h.redirects).toEqual([destination]);
    },
  );

  it("restarts sign-in when continuation reports that the verified session is gone", async () => {
    const restartUrl = "https://example.test/#/login?resume=bookings";
    const h = await loadingHarness(
      "verify-totp",
      undefined,
      "?sig=test&ba_param=state&state=admin",
      true,
      restartUrl,
    );
    const submission = h.submit({ preventDefault() {} });
    h.resolve(Response.json({ user: { id: "verified" } }));
    await vi.waitFor(() =>
      expect(h.requests.at(-1)).toBe("/api/auth/oauth2/continue"),
    );
    h.resolve(Response.json({ message: "Unauthorized" }, { status: 401 }));
    await submission;

    expect(h.redirects).toEqual([restartUrl]);
    expect(h.button.textContent).toBe("Verificar código");
  });

  it("restarts the requested authorization when the MFA setup session expires", async () => {
    vi.useFakeTimers();
    try {
      const restartUrl =
        "https://example.test/#/login?resume=bookings&tab=reservations&date=2026-11-25";
      const h = await loadingHarness(
        "enable-totp",
        undefined,
        "",
        true,
        restartUrl,
      );
      const submission = h.submit({ preventDefault() {} });
      h.resolve(Response.json({ code: "UNAUTHORIZED" }, { status: 401 }));
      await submission;

      expect(h.requests).toEqual(["/api/auth/two-factor/enable"]);
      expect(h.redirects).toEqual([restartUrl]);
      expect(h.loading.hidden).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["verify-totp", "TOTP_NOT_ENABLED"],
    ["verify-enrollment", "TOTP_NOT_ENABLED"],
    ["verify-backup-code", "BACKUP_CODES_NOT_ENABLED"],
  ])(
    "starts a new sign-in when %s has lost its MFA configuration",
    async (formKind, code) => {
      const restartUrl =
        "https://example.test/#/login?resume=bookings&tab=reservations";
      const h = await loadingHarness(
        formKind,
        undefined,
        "?sig=test&ba_param=state&state=admin",
        true,
        restartUrl,
      );
      const submission = h.submit({ preventDefault() {} });
      h.resolve(
        Response.json(
          { code, message: "MFA is no longer configured" },
          { status: 400 },
        ),
      );
      await submission;

      expect(h.redirects).toEqual([restartUrl]);
      expect(h.loading.hidden).toBe(false);
      expect(h.requests).toHaveLength(1);
    },
  );

  it("lets the user correct the password on an active MFA setup form", async () => {
    const h = await loadingHarness(
      "enable-totp",
      undefined,
      "",
      true,
      "https://example.test/#/login",
    );
    const submission = h.submit({ preventDefault() {} });
    h.resolve(
      Response.json(
        { code: "INVALID_PASSWORD", message: "Invalid password" },
        { status: 400 },
      ),
    );
    await submission;

    expect(h.redirects).toEqual([]);
    expect(h.status.textContent).toBe("Invalid password");
    expect(h.button.disabled).toBe(false);
    expect(h.content.hidden).toBe(false);
  });

  it("focuses the authenticator code when the MFA setup is ready", async () => {
    const h = await loadingHarness("enable-totp");
    const submission = h.submit({ preventDefault() {} });
    h.resolve(Response.json({ totpURI: "otpauth://totp/Savia:fixture" }));
    await submission;

    expect(h.form.hidden).toBe(true);
    expect(h.enrollment.hidden).toBe(false);
    expect(h.focusCode).toHaveBeenCalledOnce();
  });

  it("keeps the MFA setup form available when the setup URI is missing", async () => {
    const h = await loadingHarness("enable-totp");
    const submission = h.submit({ preventDefault() {} });
    h.resolve(Response.json({}));
    await submission;

    expect(h.form.hidden).toBe(false);
    expect(h.enrollment.hidden).toBe(true);
    expect(h.button.disabled).toBe(false);
    expect(h.status.textContent).toContain("Inténtalo de nuevo.");
  });

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

  it.each(["headers", "body"])(
    "restores the form and ignores a late %s response when abort is ignored",
    async (phase) => {
      vi.useFakeTimers();
      try {
        const h = await loadingHarness("sign-in", undefined, "", false);
        const submitted = h.submit({ preventDefault() {} });
        let body!: ReadableStreamDefaultController<Uint8Array>;
        if (phase === "body") {
          h.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  body = controller;
                },
              }),
            ),
          );
        }
        await vi.advanceTimersByTimeAsync(15_000);
        expect(h.content.hidden).toBe(false);
        expect(h.loading.hidden).toBe(true);
        expect(h.button.disabled).toBe(false);
        expect(h.status.textContent).toContain("La solicitud tardó demasiado");
        expect(h.requestSignal()?.aborted).toBe(true);

        const lateResult = {
          redirect_uri: "https://example.test/after-sign-in",
        };
        if (phase === "body") {
          body.enqueue(new TextEncoder().encode(JSON.stringify(lateResult)));
          body.close();
        } else h.resolve(Response.json(lateResult));
        await vi.advanceTimersByTimeAsync(0);
        await submitted;
        expect(h.redirects).toEqual([]);
        expect(h.status.textContent).toContain("La solicitud tardó demasiado");
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

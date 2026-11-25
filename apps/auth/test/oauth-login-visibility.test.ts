import { describe, expect, it, vi } from "vitest";
import { oauthPageResponse } from "../src/oauth-pages";

function visibilityHarness(
  providerResult: unknown,
  provider = "google",
  fetchLogin?: (url: string, init?: RequestInit) => Promise<Response>,
) {
  const socialLogin = {
    hidden: true,
    dataset: {} as Record<string, string>,
    querySelectorAll: () => [] as Array<Record<string, unknown>>,
  };
  const loginSubmit = { disabled: false };
  const loginPanel = { hidden: false, querySelector: () => loginSubmit };
  const ssoPanel = {
    hidden: true,
    querySelectorAll: () => [] as unknown[],
    querySelector: () => null,
  };
  let openSSO!: () => void;
  const ssoTrigger = {
    hidden: true,
    dataset: { oauthShow: "sso" },
    addEventListener: (_: string, listener: () => void) => {
      openSSO = listener;
    },
  };
  let startSocial!: () => Promise<void>;
  let submitSSO!: () => Promise<void>;
  let blurEmail!: () => void;
  const redirects: string[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  const loading = { hidden: true };
  const content = { hidden: false };
  const status = { textContent: "" };
  let changeSSOEmail: (() => void) | undefined;
  const ssoEmail = {
    value: "user@example.test",
    addEventListener(event: string, handler: () => void) {
      if (event === "input") changeSSOEmail = handler;
    },
  };
  const connectionButtons: {
    textContent: string;
    disabled: boolean;
    click: () => Promise<void>;
  }[] = [];
  const choices = {
    replaceChildren: () => {
      connectionButtons.length = 0;
    },
    append: (button: (typeof connectionButtons)[number]) => {
      connectionButtons.push(button);
    },
    querySelectorAll: () => connectionButtons,
  };
  const ssoSubmit = { disabled: false };
  const ssoForm = {
    dataset: { oauthForm: "sso-discover" },
    querySelector: () => ssoSubmit,
    addEventListener(
      _event: string,
      handler: (event: { preventDefault(): void }) => Promise<void>,
    ) {
      submitSSO = () => handler({ preventDefault() {} });
    },
  };
  const button = {
    hidden: true,
    disabled: false,
    dataset: { socialProvider: provider },
    addEventListener: (_event: string, handler: () => Promise<void>) => {
      startSocial = handler;
    },
  };
  socialLogin.querySelectorAll = () => [button];
  const targets: Record<string, unknown> = {
    "[data-social-login]": socialLogin,
    '[data-oauth-form="sign-in"]': loginPanel,
    '[data-oauth-show="sso"]': ssoTrigger,
    '[data-oauth-panel="sso"]': ssoPanel,
    "[data-oauth-loading]": loading,
    "[data-oauth-content]": content,
    "#oauth-status": status,
    "#sso-email": ssoEmail,
    "[data-sso-connections]": choices,
    "#email": {
      value: "user@example.test",
      addEventListener(event: string, handler: () => void) {
        if (event === "blur") blurEmail = handler;
      },
    },
  };
  const fetchCalls: string[] = [];
  const scriptPromise = oauthPageResponse(
    new Request("https://tenant.example.test/api/auth/oauth-ui.js"),
  )!.text();

  return scriptPromise.then((script) => {
    new Function(
      "window",
      "document",
      "fetch",
      "setTimeout",
      "FormData",
      script,
    )(
      {
        location: {
          search: "",
          origin: "https://example.test",
          href: "https://example.test/api/auth/login",
          hostname: "example.test",
          host: "example.test",
          port: "",
          assign: (url: string) => redirects.push(url),
        },
      },
      {
        querySelector: (selector: string) => targets[selector] ?? null,
        querySelectorAll: (selector: string) => {
          if (selector === "[data-oauth-show]") return [ssoTrigger];
          if (selector === "[data-oauth-form]") return [ssoForm];
          return [];
        },
        addEventListener: () => {},
        createElement: () => {
          let onClick: (() => Promise<void>) | undefined;
          return {
            textContent: "",
            disabled: false,
            addEventListener(_event: string, handler: () => Promise<void>) {
              onClick = handler;
            },
            async click() {
              await onClick?.();
            },
          };
        },
      },
      (url: string, init?: RequestInit) => {
        fetchCalls.push(url);
        if (fetchLogin && url !== "/api/auth/savia-social/providers")
          return fetchLogin(url, init);
        if (providerResult instanceof Error)
          return Promise.reject(providerResult);
        return Promise.resolve({
          ok: true,
          json: async () => providerResult,
        });
      },
      (callback: () => void, delay: number) => {
        timers.push({ callback, delay });
      },
      class {
        get() {
          return ssoEmail.value;
        }
      },
    );
    return new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => ({
      socialLogin,
      loginPanel,
      ssoPanel,
      ssoTrigger,
      button,
      fetchCalls,
      openSSO,
      startSocial,
      blurEmail,
      redirects,
      timers,
      loading,
      content,
      status,
      submitSSO,
      ssoSubmit,
      connectionButtons,
      changeSSOEmail(value: string) {
        ssoEmail.value = value;
        changeSSOEmail?.();
      },
    }));
  });
}

describe("tenant login method visibility", () => {
  it("restores the social sign-in controls when the browser does not navigate", async () => {
    let attempts = 0;
    const h = await visibilityHarness(
      { providers: ["google"] },
      "google",
      async (url) => {
        if (url !== "/api/auth/sign-in/social")
          throw new Error(`Unexpected path: ${url}`);
        attempts++;
        return Response.json({
          url: `https://provider.test/authorize/${attempts}`,
        });
      },
    );
    await h.startSocial();
    await h.startSocial();
    expect(attempts).toBe(1);
    expect(h.redirects).toEqual(["https://provider.test/authorize/1"]);
    expect(h.content.hidden).toBe(true);

    h.timers.find((timer) => timer.delay === 10_000)?.callback();
    expect(h.content.hidden).toBe(false);
    expect(h.button.disabled).toBe(false);
    expect(h.status.textContent).toContain("La redirección no se completó");

    await h.startSocial();
    expect(attempts).toBe(2);
    expect(h.redirects).toEqual([
      "https://provider.test/authorize/1",
      "https://provider.test/authorize/2",
    ]);
  });

  it("starts one selected SSO connection at a time and permits retry after failure", async () => {
    let failFirst!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      failFirst = resolve;
    });
    const started: string[] = [];
    const h = await visibilityHarness(
      { providers: [], ssoEnabled: true },
      "google",
      async (url, init) => {
        if (url.startsWith("/api/auth/savia-sso/connections?"))
          return Response.json({
            connections: [
              { providerId: "first", displayName: "First workspace" },
              { providerId: "second", displayName: "Second workspace" },
            ],
          });
        if (url !== "/api/auth/sign-in/sso")
          throw new Error(`Unexpected path: ${url}`);
        started.push(JSON.parse(String(init?.body)).providerId);
        return started.length === 1
          ? pending
          : Response.json({ url: "https://provider.test/authorize" });
      },
    );
    h.openSSO();
    await h.submitSSO();
    const [first, second] = h.connectionButtons;
    const firstLogin = first.click();
    await second.click();
    expect(started).toEqual(["first"]);
    expect(second.disabled).toBe(true);

    failFirst(
      Response.json({ message: "Provider unavailable" }, { status: 503 }),
    );
    await firstLogin;
    expect(h.status.textContent).toBe("Provider unavailable");
    expect(first.disabled).toBe(false);
    expect(second.disabled).toBe(false);

    await second.click();
    expect(started).toEqual(["first", "second"]);
    expect(h.redirects).toEqual(["https://provider.test/authorize"]);
  });

  it.each(["new email", "failed refresh"])(
    "clears previous SSO connection choices after %s",
    async (reason) => {
      let lookups = 0;
      const h = await visibilityHarness(
        { providers: [], ssoEnabled: true },
        "google",
        async (url) => {
          if (!url.startsWith("/api/auth/savia-sso/connections?"))
            throw new Error(`Unexpected path: ${url}`);
          if (++lookups > 1) return new Response(null, { status: 503 });
          return Response.json({
            connections: [
              { providerId: "first", displayName: "First workspace" },
              { providerId: "second", displayName: "Second workspace" },
            ],
          });
        },
      );
      h.openSSO();
      await h.submitSSO();
      expect(h.connectionButtons.map((button) => button.textContent)).toEqual([
        "First workspace",
        "Second workspace",
      ]);
      if (reason === "new email") h.changeSSOEmail("user@other.example.test");
      else {
        await h.submitSSO();
        expect(h.status.textContent).toContain("No fue posible consultar");
      }
      expect(h.connectionButtons).toHaveLength(0);
      expect(h.redirects).toEqual([]);
    },
  );

  it("restores the SSO form when discovering connections times out", async () => {
    let lookups = 0;
    const h = await visibilityHarness(
      { providers: [], ssoEnabled: true },
      "google",
      async (url, init) => {
        if (url !== "/api/auth/savia-sso/connections?domain=example.test")
          throw new Error(`Unexpected path: ${url}`);
        if (++lookups > 1) return Response.json({ connections: [] });
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        });
      },
    );
    h.openSSO();
    const pending = h.submitSSO();
    expect(h.content.hidden).toBe(true);
    expect(h.loading.hidden).toBe(false);
    const expiry = h.timers.find((timer) => timer.delay === 15_000);
    expect(expiry).toBeDefined();
    expiry?.callback();
    await pending;
    expect(h.content.hidden).toBe(false);
    expect(h.loading.hidden).toBe(true);
    expect(h.ssoSubmit.disabled).toBe(false);
    expect(h.status.textContent).toContain("La solicitud tardó demasiado");
    expect(lookups).toBe(1);

    await h.submitSSO();
    expect(lookups).toBe(2);
    expect(h.status.textContent).toContain("No encontramos una conexión SSO");
    expect(h.redirects).toEqual([]);
  });

  it.each(["google", "microsoft"])(
    "ignores pending workspace discovery after selecting %s",
    async (provider) => {
      let finishHome!: (response: Response) => void;
      let finishSocial!: (response: Response) => void;
      const home = new Promise<Response>((resolve) => {
        finishHome = resolve;
      });
      const social = new Promise<Response>((resolve) => {
        finishSocial = resolve;
      });
      const h = await visibilityHarness(
        { providers: [provider] },
        provider,
        (url) => {
          if (url.startsWith("/api/auth/tenant-home?")) return home;
          if (url === "/api/auth/sign-in/social") return social;
          throw new Error(`Unexpected path: ${url}`);
        },
      );
      h.blurEmail();
      const signedIn = h.startSocial();
      finishHome(Response.json({ found: true, slug: "acme", tenantId: 42 }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(h.redirects).toEqual([]);
      finishSocial(Response.json({ url: "https://provider.test/authorize" }));
      await signedIn;
      expect(h.redirects).toEqual(["https://provider.test/authorize"]);
      expect(
        h.fetchCalls.filter((url) => url === "/api/auth/sign-in/social"),
      ).toHaveLength(1);
    },
  );

  it("shows only tenant-enabled providers and the active tenant SSO action", async () => {
    const h = await visibilityHarness({
      providers: ["google"],
      ssoEnabled: true,
    });

    expect(h.fetchCalls).toContain("/api/auth/savia-social/providers");
    expect(h.button.hidden).toBe(false);
    expect(h.socialLogin.hidden).toBe(false);
    expect(h.ssoTrigger.hidden).toBe(false);
    h.openSSO();
    expect(h.ssoPanel.hidden).toBe(false);
  });

  it("keeps social and SSO controls hidden when the tenant has no enabled methods", async () => {
    const h = await visibilityHarness({ providers: [], ssoEnabled: false });

    expect(h.button.hidden).toBe(true);
    expect(h.socialLogin.hidden).toBe(true);
    expect(h.ssoTrigger.hidden).toBe(true);
    h.openSSO();
    expect(h.ssoPanel.hidden).toBe(true);
  });

  it("allows SSO for an SSO-only tenant without showing social buttons", async () => {
    const h = await visibilityHarness({ providers: [], ssoEnabled: true });

    expect(h.socialLogin.hidden).toBe(true);
    expect(h.ssoTrigger.hidden).toBe(false);
    h.openSSO();
    expect(h.ssoPanel.hidden).toBe(false);
  });

  it("hides both login methods when discovery fails", async () => {
    const h = await visibilityHarness(new Error("discovery failed"));

    expect(h.socialLogin.hidden).toBe(true);
    expect(h.ssoTrigger.hidden).toBe(true);
    h.openSSO();
    expect(h.ssoPanel.hidden).toBe(true);
  });
});

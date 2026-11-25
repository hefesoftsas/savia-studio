import { describe, expect, it, vi } from "vitest";
import { oauthPageResponse } from "../src/oauth-pages";

describe("tenant-home login redirect", () => {
  it.each(["http error", "no tenant returned"])(
    "retries discovery for the same unconfirmed email after %s",
    async (outcome) => {
      const script = await oauthPageResponse(
        new Request("https://savia.test/api/auth/oauth-ui.js"),
      )!.text();
      let blur!: () => void;
      const email = {
        value: "user@example.test",
        addEventListener(event: string, listener: () => void) {
          if (event === "blur") blur = listener;
        },
      };
      let finishFirst!: (response: Response) => void;
      const pending = new Promise<Response>((resolve) => {
        finishFirst = resolve;
      });
      const fetchHome = vi
        .fn()
        .mockReturnValueOnce(pending)
        .mockImplementation(async () =>
          Response.json({ found: true, slug: "acme", tenantId: 42 }),
        );
      const assign = vi.fn();
      const resume = { hidden: true, href: "" };
      let navigationTimedOut: (() => void) | undefined;
      const destination =
        "https://acme.savia.test/api/auth/login?email=user%40example.test";
      new Function("window", "document", "fetch", "setTimeout", script)(
        {
          location: {
            search: "",
            href: "https://savia.test/api/auth/login",
            hostname: "savia.test",
            host: "savia.test",
            port: "",
            assign,
          },
        },
        {
          querySelector: (selector: string) => {
            if (selector === "#email") return email;
            if (selector === "[data-oauth-resume]") return resume;
            return null;
          },
          querySelectorAll: () => [],
        },
        fetchHome,
        (callback: () => void, delay: number) => {
          if (delay === 10_000) navigationTimedOut = callback;
        },
      );

      blur();
      blur();
      expect(fetchHome).toHaveBeenCalledOnce();
      finishFirst(
        outcome === "http error"
          ? new Response(null, { status: 503 })
          : Response.json({ found: false }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(assign).not.toHaveBeenCalled();

      blur();
      await vi.waitFor(() => expect(assign).toHaveBeenCalledWith(destination));
      expect(fetchHome).toHaveBeenCalledTimes(2);
      blur();
      expect(fetchHome).toHaveBeenCalledTimes(2);

      expect(navigationTimedOut).toBeDefined();
      navigationTimedOut?.();
      expect(resume).toEqual({ hidden: false, href: destination });
      blur();
      await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
      expect(fetchHome).toHaveBeenCalledTimes(3);
      expect(resume.hidden).toBe(true);
    },
  );

  it("prepopulates the email input from ?email=", async () => {
    const html = await oauthPageResponse(
      new Request(
        "https://savia.hefesoft.com/api/auth/login?email=User@Example.COM",
      ),
    )!.text();
    expect(html).toContain('value="user@example.com"');
    expect(html).toContain('id="email"');
  });

  it("ignores an invalid ?email= value", async () => {
    const html = await oauthPageResponse(
      new Request(
        "https://savia.hefesoft.com/api/auth/login?email=not-an-email",
      ),
    )!.text();
    expect(html).not.toContain('value="not-an-email"');
  });

  it("ships blur discovery that preserves the typed email", async () => {
    const script = await oauthPageResponse(
      new Request("https://savia.hefesoft.com/api/auth/oauth-ui.js"),
    )!.text();
    expect(script).toContain("/api/auth/tenant-home?email=");
    expect(script).toContain('addEventListener("blur"');
    expect(script).toContain('searchParams.set("email"');
    expect(script).toContain("Redirigiendo a tu espacio de trabajo");
  });

  it("relies on server-resolved host context without hard-coded domains", async () => {
    const script = await oauthPageResponse(
      new Request("https://savia.hefesoft.com/api/auth/oauth-ui.js"),
    )!.text();
    expect(script).not.toContain("savia.hefesoft.com");
    expect(script).not.toContain("savia-preview.hefesoft.com");
    expect(script).toContain("currentTenantId");
  });

  it("ignores stale lookup responses edited before they arrive", async () => {
    const script = await oauthPageResponse(
      new Request("https://savia.hefesoft.com/api/auth/oauth-ui.js"),
    )!.text();
    expect(script).toContain("tenantHomeRedirecting");
    // The input value is re-verified against the queried email after await.
    expect(script).toContain("currentValue");
  });
});

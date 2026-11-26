import { describe, expect, it } from "vitest";
import { firstForm } from "../scripts/saml-smoke-form";

const base = "http://127.0.0.1:8080/sso";

describe("Keycloak smoke form reader", () => {
  it("reads a relative action and decodes HTML references in attributes", () => {
    const form = firstForm(
      `<form action="/consume?code=one&amp;client=two">
        <input type="hidden" name="SAMLResponse" value="c2FtbA==">
        <input type="hidden" name="RelayState" value="&quot;&lt;&gt;&#39;&apos;&amp;">
      </form>`,
      base,
    );

    expect(form).toEqual({
      action: "http://127.0.0.1:8080/consume?code=one&client=two",
      fields: { SAMLResponse: "c2FtbA==", RelayState: `"<>''&` },
    });
  });

  it("preserves literal entity text in both the action and the relay state", () => {
    const form = firstForm(
      `<form action="/consume?code=one&amp;lt;label=value">
        <input type="hidden" name="RelayState" value="&amp;lt;&amp;quot;&amp;#39;&amp;amp;">
      </form>`,
      base,
    );

    expect(form).toEqual({
      action: "http://127.0.0.1:8080/consume?code=one&lt;label=value",
      fields: { RelayState: "&lt;&quot;&#39;&amp;" },
    });
  });
});

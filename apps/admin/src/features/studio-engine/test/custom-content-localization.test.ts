// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { displayTextConfigSchema } from "@savia/studio-shared/display-text";
import {
  formHtmlConfigSchema,
  buildFormHtmlRuntimeContext,
  renderFormHtmlTemplate,
} from "@savia/studio-shared/form-html";
import { resolveLocalizedContent } from "@savia/studio-shared/plugin-localization";
import { resultSurfaceDocument } from "../result-html-surface";

describe("custom authored localization", () => {
  it("preserves optional translations and legacy defaults", () => {
    expect(
      displayTextConfigSchema.parse({
        content: "Base",
        translations: { en: "English" },
      }).translations,
    ).toEqual({ en: "English" });
    expect(
      formHtmlConfigSchema.parse({
        html: "Base",
        translations: { pt: "Português" },
      }).translations,
    ).toEqual({ pt: "Português" });
    expect(
      formHtmlConfigSchema.parse({ html: "Base" }).translations,
    ).toBeUndefined();
    expect(
      displayTextConfigSchema.safeParse({ translations: { fr: "Non" } })
        .success,
    ).toBe(false);
    expect(resolveLocalizedContent("Base", { en: "" }, "en")).toBe("Base");
  });
  it("escapes data after resolving translated templates", () => {
    const html = resolveLocalizedContent(
      "Base",
      { en: "<p>{{values.name}}</p>" },
      "en",
    );
    expect(renderFormHtmlTemplate(html, { values: { name: "<script>" } })).toBe(
      "<p>&lt;script&gt;</p>",
    );
    const ctx = buildFormHtmlRuntimeContext({
      values: {},
      setValue: vi.fn(),
      container: document.createElement("div"),
      locale: "pt",
    });
    expect(ctx.locale).toBe("pt");
    expect(
      ctx.t({ hello: ["Hola", "Hello", "Olá %{name}"] }, "hello", {
        name: "%{other}",
      }),
    ).toBe("Olá %{other}");
  });
  it("passes locale safely and accepts updates only from its parent", () => {
    const hostLanguage = document.documentElement.lang;
    const source = resultSurfaceDocument("<p>content</p>", [], [], false, "en");
    const frameDocument = new DOMParser().parseFromString(source, "text/html");
    const policy = frameDocument.querySelector<HTMLMetaElement>(
      'meta[http-equiv="Content-Security-Policy"]',
    );
    expect(policy?.content).toContain("default-src 'none'");
    expect(frameDocument.scripts).toHaveLength(1);
    const handlers: Record<string, (event: any) => void> = {};
    const parent = { postMessage: vi.fn() };
    const scope: any = {};
    const dispatch = vi.fn();
    new Function(
      "window",
      "parent",
      "addEventListener",
      "dispatchEvent",
      "document",
      frameDocument.scripts[0].text,
    )(
      scope,
      parent,
      (name: string, fn: any) => {
        handlers[name] = fn;
      },
      dispatch,
      frameDocument,
    );
    const catalog = { hello: ["Hola", "Hello %{name}", "Olá"] };
    expect(scope.savia.locale).toBe("en");
    expect(scope.savia.t(catalog, "hello", { name: "%{name}" })).toBe(
      "Hello %{name}",
    );
    handlers.message({
      source: {},
      data: { type: "savia-result-locale", locale: "pt" },
    });
    expect(scope.savia.locale).toBe("en");
    handlers.message({
      source: parent,
      data: { type: "savia-result-locale", locale: "pt" },
    });
    expect(scope.savia.t(catalog, "hello")).toBe("Olá");
    expect(frameDocument.documentElement.lang).toBe("pt");
    expect(document.documentElement.lang).toBe(hostLanguage);
    expect(dispatch).toHaveBeenCalledOnce();
    handlers.message({
      source: parent,
      data: { type: "savia-result-locale", locale: "fr" },
    });
    expect(scope.savia.locale).toBe("pt");
  });
});

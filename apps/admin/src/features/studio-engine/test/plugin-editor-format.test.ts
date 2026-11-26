import { describe, expect, it, vi } from "vitest";
import { formatPluginDocument } from "../plugin-editor-format";

describe("verified formatter", () => {
  it("formats TSX without changing a translation value", async () => {
    expect(
      await formatPluginDocument(
        'const C=()=> <p>{"Changed 2"}</p>',
        "typescriptreact",
      ),
    ).toBe('const C = () => <p>{"Changed 2"}</p>;\n');
  });
  it("formats JSON and rejects unsupported languages", async () => {
    expect(await formatPluginDocument('{"a":1}', "json")).toBe('{ "a": 1 }\n');
    await expect(formatPluginDocument("hello", "binary")).rejects.toThrow(
      "Unsupported",
    );
  });
  it.each([
    {
      language: "json",
      source: '{"a":1}',
      formatted: '{ "a": 1 }\n',
      unavailable: ["typescript", "postcss", "html"],
    },
    {
      language: "css",
      source: ".sample{color:red}",
      formatted: ".sample {\n  color: red;\n}\n",
      unavailable: ["typescript", "babel", "estree", "html"],
    },
  ])(
    "formats $language even if unrelated parsers fail to load",
    async ({ language, source, formatted, unavailable }) => {
      for (const parser of unavailable) {
        vi.doMock(`prettier/plugins/${parser}`, () => {
          throw new Error(`Could not load ${parser}`);
        });
      }
      try {
        await expect(formatPluginDocument(source, language)).resolves.toBe(
          formatted,
        );
      } finally {
        for (const parser of unavailable)
          vi.doUnmock(`prettier/plugins/${parser}`);
      }
    },
  );
  it("formats HTML with embedded JavaScript and CSS", async () => {
    const markup = await formatPluginDocument(
      "<script>const value={a:1}</script><style>.sample{color:red}</style>",
      "html",
    );
    expect(markup).toContain("const value = { a: 1 };");
    expect(markup).toContain("color: red;");
  });
});

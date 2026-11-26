import type { Plugin } from "prettier";

const parsers: Record<string, string> = {
  typescript: "typescript",
  typescriptreact: "typescript",
  javascript: "babel",
  javascriptreact: "babel",
  json: "json",
  css: "css",
  html: "html",
};

function loadFormattingPlugins(parser: string): Promise<Plugin[]> {
  if (parser === "css")
    return import("prettier/plugins/postcss").then((postcss) => [postcss]);

  const javascriptPlugins = [
    import("prettier/plugins/babel"),
    // Prettier's estree plugin ships an empty declaration file in this release.
    import("prettier/plugins/estree") as unknown as Promise<Plugin>,
  ];
  if (parser === "json") return Promise.all(javascriptPlugins);

  // Keep embedded scripts, styles, and markup available to the other parsers.
  return Promise.all([
    ...javascriptPlugins,
    import("prettier/plugins/typescript"),
    import("prettier/plugins/postcss"),
    import("prettier/plugins/html"),
  ]);
}

export async function formatPluginDocument(text: string, language: string) {
  const parser = parsers[language];
  if (!parser) throw new Error(`Unsupported formatting language: ${language}`);
  const [{ format }, plugins] = await Promise.all([
    import("prettier/standalone"),
    loadFormattingPlugins(parser),
  ]);
  return format(text, { parser, plugins, tabWidth: 2 });
}

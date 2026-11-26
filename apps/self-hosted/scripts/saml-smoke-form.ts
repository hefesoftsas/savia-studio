import assert from "node:assert/strict";

type Form = { action: string; fields: Record<string, string> };

function htmlDecode(value: string): string {
  // Decode ampersands last so literal entity text survives a single pass.
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

export function firstForm(html: string, base: string): Form {
  const form = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  assert.ok(form, `Expected an HTML form in response: ${html.slice(0, 300)}`);
  const attr = (source: string, name: string) => {
    const found = source.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
    return found ? htmlDecode(found[1]) : "";
  };
  const action = new URL(attr(form[1], "action") || base, base).toString();
  const fields: Record<string, string> = {};
  for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
    const name = attr(input[1], "name");
    if (name) fields[name] = attr(input[1], "value");
  }
  return { action, fields };
}

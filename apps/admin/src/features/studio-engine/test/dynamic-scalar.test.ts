// @vitest-environment node
import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { expect, it, vi } from "vitest";
import { scalarTransportScript } from "../../../../../api/src/studio/dynamic-scalar";

it("returns an absolute response URL for Scalar and honors Request overrides", async () => {
  let listener: (event: unknown) => void = () => {};
  const sent: any[] = [];
  const parent = {
    postMessage: (data: any) => {
      sent.push(data);
      listener({
        source: parent,
        data: {
          type: "savia-studio-response",
          id: data.id,
          status: 200,
          headers: { "content-type": "application/json" },
          body: '{"data":[]}',
        },
      });
    },
  };
  const window = {
    parent,
    fetch: vi.fn(),
    addEventListener: (_name: string, fn: typeof listener) => {
      listener = fn;
    },
  };
  const scripts = JSDOM.fragment(scalarTransportScript(101)).querySelectorAll(
    "script",
  );
  expect(scripts).toHaveLength(1);
  runInNewContext(scripts[0].text, {
    window,
    Map,
    URL,
    Request,
    Response,
    crypto,
    setTimeout,
    clearTimeout,
  });
  const response = await window.fetch(
    new Request(
      "https://api.example.test/v1/studio/101/api/published/clientes",
      { method: "POST", body: '{"name":"old"}' },
    ),
    { method: "PATCH", body: '{"name":"new"}' },
  );
  expect(response.url).toBe(
    "https://api.example.test/v1/studio/101/api/published/clientes",
  );
  expect(sent[0].url).toBe("/v1/studio/101/api/published/clientes");
  expect(sent[0].method).toBe("PATCH");
  expect(sent[0].body).toBe('{"name":"new"}');
  expect(await response.json()).toEqual({ data: [] });
});

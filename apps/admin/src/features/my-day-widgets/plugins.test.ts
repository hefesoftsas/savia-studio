import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/api/api-client";
import { REQUEST_TIMEOUT_MS, RequestTimeoutError } from "@/api/request-timeout";
import {
  availablePluginWidgets,
  isPluginWidgetEnabled,
  parsePluginKind,
  pluginContributionFor,
  pluginRequestFor,
  pluginWidgetTitle,
  storeWidgetContributions,
  storeWidgetFor,
} from "./plugins";
import { releaseCatalog } from "@savia/release-catalog";

describe("pluginRequestFor", () => {
  it.each([
    { operation: "download", status: 200 },
    { operation: "download", status: 503 },
    { operation: "upload", status: 201 },
  ])(
    "stops an attachment $operation waiting for the HTTP $status body",
    async ({ operation, status }) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      let stream!: ReadableStreamDefaultController<Uint8Array>;
      const rejected = vi.fn();
      try {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(Uint8Array.of(1));
            },
            cancel,
          }),
          { status },
        );
        const api = new ApiClient({
          baseUrl: "https://savia.example.test",
          tokenSource: { getAccessToken: async () => null },
          fetcher: async () => response,
        });
        const request = pluginRequestFor(api, "");
        if (operation === "upload") {
          const data = new FormData();
          data.set("file", new File(["content"], "report.txt"));
          void request("/files/reports/1", "POST", data).catch(rejected);
        } else {
          void request("/file/report/download", "GET", undefined, {
            responseType: "blob",
          }).catch(rejected);
        }
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(rejected).toHaveBeenCalledWith(
          status === 503
            ? expect.objectContaining({ message: "Error 503" })
            : expect.any(RequestTimeoutError),
        );
        expect(cancel).toHaveBeenCalledExactlyOnceWith(
          expect.any(RequestTimeoutError),
        );
      } finally {
        if (!cancel.mock.calls.length) stream?.close();
        vi.useRealTimers();
      }
    },
  );
});

describe("parsePluginKind", () => {
  it("parses dotted extension ids", () => {
    expect(
      parsePluginKind("plugin:service.portfolio-dashboard:summary"),
    ).toEqual({
      extensionId: "service.portfolio-dashboard",
      widgetId: "summary",
    });
  });

  it("rejects built-in kinds and malformed values", () => {
    expect(parsePluginKind("summary")).toBeNull();
    expect(parsePluginKind("plugin:only-one")).toBeNull();
    expect(parsePluginKind("plugin:a:b:c")).toBeNull();
    expect(parsePluginKind("plugin:BAD:summary")).toBeNull();
  });
});

describe("plugin registry", () => {
  it("ships no compiled widgets after the store migration", () => {
    expect(releaseCatalog.extensionWidgets).toEqual([]);
    expect(
      pluginContributionFor({
        extensionId: "service.portfolio-dashboard",
        widgetId: "summary",
      }),
    ).toBeUndefined();
    expect(
      pluginWidgetTitle("plugin:service.portfolio-dashboard:summary"),
    ).toBeUndefined();
    expect(pluginWidgetTitle("summary")).toBeUndefined();
    expect(pluginWidgetTitle("plugin:unknown:missing")).toBeUndefined();
  });

  it("enables widgets with the same rule as extension screens", () => {
    const contribution = {
      id: "summary",
      extensionId: "service.portfolio-dashboard",
      collection: "contracts",
      title: { es: "Resumen de cartera" },
      Widget: () => null,
    };
    expect(isPluginWidgetEnabled(contribution, undefined)).toBe(false);
    expect(isPluginWidgetEnabled(contribution, [])).toBe(false);
    expect(
      isPluginWidgetEnabled(contribution, [
        {
          manifest: { id: "service.portfolio-dashboard" },
          builtIn: false,
          installed: { enabled: false },
        },
      ]),
    ).toBe(false);
    expect(
      isPluginWidgetEnabled(contribution, [
        {
          manifest: { id: "service.portfolio-dashboard" },
          builtIn: true,
          installed: null,
        },
      ]),
    ).toBe(true);
  });

  it("offers store widgets for their collection when enabled", () => {
    const enabled = [
      {
        manifest: { id: "service.portfolio-dashboard" },
        builtIn: false,
        store: true,
        widgets: [
          {
            id: "summary",
            collection: "contracts",
            title: { es: "Resumen de cartera" },
          },
        ],
        installed: { enabled: true },
      },
    ];
    expect(
      availablePluginWidgets("contracts", enabled).map((entry) => entry.id),
    ).toEqual(["summary"]);
    expect(availablePluginWidgets("clientes", enabled)).toEqual([]);
    expect(availablePluginWidgets("contracts", [])).toEqual([]);
    expect(availablePluginWidgets("contracts", undefined)).toEqual([]);
    expect(
      storeWidgetContributions(undefined),
      "ignora catálogos ausentes",
    ).toEqual([]);
    expect(
      storeWidgetFor(
        { extensionId: "service.portfolio-dashboard", widgetId: "summary" },
        enabled,
      ),
    ).toMatchObject({ collection: "contracts" });
    expect(
      storeWidgetFor(
        { extensionId: "service.portfolio-dashboard", widgetId: "otro" },
        enabled,
      ),
    ).toBeUndefined();
  });
});

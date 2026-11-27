import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { render } from "../studio-engine/test/locale-test-render";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, type ApiClient } from "@/api/api-client";
import { beginLogout } from "@/auth/logout-progress";
import { rotateSessionScope } from "@/auth/session-scope";
import { PluginWidgetBody } from "./plugin-widget";

afterEach(cleanup);

const widget = {
  id: "widget-projects",
  apiBasePath: "/v1/studio/14",
  collection: "projects",
  kind: "plugin:example.projects:overview",
};

function catalog(enabled: boolean) {
  return {
    data: [
      {
        manifest: { id: "example.projects" },
        builtIn: false,
        store: true,
        widgets: [
          {
            id: "overview",
            collection: "projects",
            title: { es: "Proyectos" },
          },
        ],
        installed: { enabled, version: "1.0.0" },
      },
    ],
  };
}

const enableMessage = "Activa la extensión Proyectos para ver este widget.";

function apiWithCatalog(get: ApiClient["get"]): ApiClient {
  return { get } as ApiClient;
}

describe("PluginWidgetBody", () => {
  it("asks to enable the store extension when it is inactive", async () => {
    const apiClient = apiWithCatalog(vi.fn().mockResolvedValue(catalog(false)));
    render(<PluginWidgetBody apiClient={apiClient} widget={widget} />);
    expect(await screen.findByText(enableMessage)).toBeVisible();
  });

  it("falls back gracefully for an unknown plugin", async () => {
    const apiClient = apiWithCatalog(vi.fn().mockResolvedValue({ data: [] }));
    render(<PluginWidgetBody apiClient={apiClient} widget={widget} />);
    expect(
      await screen.findByText(
        "Este tipo de widget estará disponible próximamente. Mientras tanto puedes abrir la colección completa.",
      ),
    ).toBeVisible();
  });

  it("lets the user retry catalog verification from the widget", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiClientError(403, "FORBIDDEN", "Forbidden"))
      .mockResolvedValueOnce(catalog(true));
    render(
      <PluginWidgetBody apiClient={apiWithCatalog(get)} widget={widget} />,
    );

    const retry = await screen.findByRole("button", { name: "Reintentar" });
    expect(screen.queryByTitle("Proyectos")).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(await screen.findByTitle("Proyectos")).toHaveAttribute(
      "src",
      expect.stringContaining(
        "/v1/studio/14/api/plugin-store/example.projects/widget?widget=overview",
      ),
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each(["organization", "account", "API client"])(
    "rechecks installation before rendering a widget after changing the %s",
    async (change) => {
      let finish!: (value: ReturnType<typeof catalog>) => void;
      const verification = new Promise<ReturnType<typeof catalog>>(
        (resolve) => {
          finish = resolve;
        },
      );
      const get = vi
        .fn()
        .mockResolvedValueOnce(catalog(true))
        .mockReturnValueOnce(verification);
      const apiClient = apiWithCatalog(get);
      const { rerender } = render(
        <PluginWidgetBody apiClient={apiClient} widget={widget} />,
      );
      expect(await screen.findByTitle("Proyectos")).toBeInTheDocument();

      const next =
        change === "organization"
          ? { ...widget, apiBasePath: "/v1/studio/15" }
          : widget;
      const client = change === "API client" ? apiWithCatalog(get) : apiClient;
      if (change === "account")
        act(() => rotateSessionScope("principal-change"));
      else rerender(<PluginWidgetBody apiClient={client} widget={next} />);

      expect(screen.queryByTitle("Proyectos")).not.toBeInTheDocument();
      expect(get).toHaveBeenLastCalledWith(
        `${next.apiBasePath}/api/extensions`,
        expect.anything(),
      );
      expect(get).toHaveBeenCalledTimes(2);
      await act(async () => finish(catalog(false)));
      expect(screen.getByText(enableMessage)).toBeVisible();
    },
  );

  it("aborts verification when logout starts and ignores the late response", async () => {
    let finish!: (value: ReturnType<typeof catalog>) => void;
    const verification = new Promise<ReturnType<typeof catalog>>((resolve) => {
      finish = resolve;
    });
    const get = vi
      .fn<
        (
          path: string,
          options?: RequestInit,
        ) => Promise<ReturnType<typeof catalog>>
      >()
      .mockReturnValueOnce(verification)
      .mockResolvedValueOnce(catalog(false));
    render(
      <PluginWidgetBody
        apiClient={apiWithCatalog(get as ApiClient["get"])}
        widget={widget}
      />,
    );
    const signal = get.mock.calls[0]?.[1]?.signal;
    let cancelLogout!: ReturnType<typeof beginLogout>;
    act(() => {
      cancelLogout = beginLogout();
    });
    try {
      await act(async () => finish(catalog(true)));
      expect(screen.queryByTitle("Proyectos")).not.toBeInTheDocument();
      expect(signal?.aborted).toBe(true);
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => cancelLogout());
    }
    expect(screen.getByText(enableMessage)).toBeVisible();
  });
});

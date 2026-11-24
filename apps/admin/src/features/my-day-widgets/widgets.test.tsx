// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen } from "@testing-library/react";
import { render } from "../studio-engine/test/locale-test-render";
import { afterEach, expect, it, vi } from "vitest";
import { SummaryWidgetBody, WidgetCard } from "./widgets";

afterEach(cleanup);

it("shows the HubSpot total and status groups from the collection summary", async () => {
  const apiBasePath = "/v1/studio/14";
  const widget = {
    id: "contacts-summary",
    title: "Contactos",
    kind: "summary" as const,
    apiBasePath,
    collection: "hubspot_contacts",
    config: { statusField: "lifecyclestage" },
  };
  const get = vi.fn(async (path: string) => {
    if (path === `${apiBasePath}/api/objects`)
      return {
        data: [
          {
            name: widget.collection,
            config: {
              fields: { lifecyclestage: { type: "select" } },
              studio: { collection: { kind: "crm", sourceId: "hubspot" } },
            },
          },
        ],
      };
    if (
      path ===
      `${apiBasePath}/api/records/hubspot_contacts/summary?group=lifecyclestage`
    )
      return { data: [{ value: "Lead", count: 5 }], total: 6 };
    throw new Error(`Unexpected endpoint: ${path}`);
  });

  render(<SummaryWidgetBody apiClient={{ get } as never} widget={widget} />);

  expect(await screen.findByText("6")).toBeVisible();
  expect(screen.getByText("Lead")).toBeVisible();
  expect(screen.getByText("5")).toBeVisible();
  expect(get).toHaveBeenCalledTimes(2);
});

it("renders a tenant ZIP widget through the dashboard card", async () => {
  const widget = {
    id: "plugin-widget",
    title: "Resumen",
    kind: "plugin:custom.demo:resumen",
    apiBasePath: "/v1/studio/0",
    collection: "contracts",
  };
  const apiClient = {
    get: vi.fn(async () => ({
      data: [
        {
          manifest: { id: "custom.demo" },
          builtIn: false,
          store: true,
          widgets: [
            {
              id: "resumen",
              collection: "contracts",
              title: { es: "Resumen" },
            },
          ],
          installed: { enabled: true },
        },
      ],
    })),
  };

  render(
    <WidgetCard
      apiClient={apiClient as never}
      widget={widget as never}
      collectionLabel="Contratos"
      onRemove={vi.fn()}
      onMove={vi.fn()}
      isFirst
      isLast
      disabled={false}
    />,
  );

  expect(await screen.findByTitle("Resumen")).toHaveAttribute(
    "src",
    expect.stringContaining("/api/plugin-store/custom.demo/widget"),
  );
});

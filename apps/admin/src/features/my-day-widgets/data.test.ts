import { describe, expect, it } from "vitest";
import {
  normalizeCollections,
  normalizeSchema,
  widgetDeepLink,
  type ObjectsResponse,
} from "./data";
import type { MyDayWidget } from "@savia/studio-shared/my-day-widgets";

const response: ObjectsResponse = {
  data: [
    {
      name: "contracts",
      label: "Contratos",
      count: 42,
      config: {
        fields: { estado: { type: "Dropdown", label: "Estado" } },
        studio: {},
      },
    },
    {
      name: "hidden_one",
      label: "Oculta",
      hidden: true,
      config: { fields: {} },
    },
    {
      name: "form_only",
      label: "Formulario",
      config: { fields: {}, studio: { requestPage: {} } },
    },
    { label: "Sin nombre", config: { fields: {} } },
  ],
};

describe("normalizeCollections", () => {
  it("shows catalog counts for local collections only", () => {
    const collections = normalizeCollections("/v1/studio/0", {
      data: [
        { name: "Local", count: 0 },
        {
          name: "Salesforce",
          count: 0,
          config: {
            studio: { collection: { kind: "crm", sourceId: "salesforce" } },
          },
        },
        {
          name: "PostgreSQL",
          count: 4,
          config: {
            studio: { collection: { kind: "postgres", sourceId: "db" } },
          },
        },
      ],
    });
    expect(
      collections.find((collection) => collection.name === "Local")?.count,
    ).toBe(0);
    expect(
      collections.find((collection) => collection.name === "Salesforce")?.count,
    ).toBeUndefined();
    expect(
      collections.find((collection) => collection.name === "PostgreSQL")?.count,
    ).toBeUndefined();
  });

  it("keeps visible collections sorted by label", () => {
    const collections = normalizeCollections("/v1/studio/0", response);
    expect(collections.map((entry) => entry.name)).toEqual(["contracts"]);
    expect(collections[0]).toMatchObject({
      apiBasePath: "/v1/studio/0",
      label: "Contratos",
      count: 42,
    });
  });
});

describe("normalizeSchema", () => {
  it("extracts typed fields", () => {
    expect(normalizeSchema("/v1/studio/0", response, "contracts")).toEqual({
      apiBasePath: "/v1/studio/0",
      name: "contracts",
      label: "Contratos",
      fields: [{ name: "estado", label: "Estado", type: "Dropdown" }],
    });
  });

  it("returns undefined for hidden or unknown collections", () => {
    expect(
      normalizeSchema("/v1/studio/0", response, "hidden_one"),
    ).toBeUndefined();
    expect(
      normalizeSchema("/v1/studio/0", response, "missing"),
    ).toBeUndefined();
  });
});

describe("widgetDeepLink", () => {
  it("links tenant widgets to the studio screen", () => {
    expect(
      widgetDeepLink({
        id: "w_1",
        apiBasePath: "/v1/studio/0",
        collection: "contracts",
        kind: "summary",
      } as MyDayWidget),
    ).toBe("/studio?tenantId=0&object=contracts");
  });

  it("links legacy dynamic CRM widgets with tenantId", () => {
    expect(
      widgetDeepLink({
        id: "w_2",
        apiBasePath: "/v1/dynamic-crm/101",
        collection: "clientes",
        kind: "items",
      } as MyDayWidget),
    ).toBe("/studio?tenantId=101&object=clientes");
  });

  it("links tenant widgets on the canonical /v1/studio base", () => {
    expect(
      widgetDeepLink({
        id: "w_3",
        apiBasePath: "/v1/studio/101",
        collection: "clientes",
        kind: "items",
      } as MyDayWidget),
    ).toBe("/studio?tenantId=101&object=clientes");
  });
});

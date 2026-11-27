import { describe, expect, it } from "vitest";
import {
  makeConfig,
  objectSchema,
  validateRecord,
  type StudioObject,
} from "../src/metadata";
import { mapCsvRow } from "../src/csv";

describe("currency field type", () => {
  const object: StudioObject = {
    name: "deal",
    label: "Negocio",
    description: "",
    config: makeConfig({
      name: { type: "Textbox", label: "Nombre", required: true },
      price: {
        type: "Currency",
        label: "Precio",
        required: true,
        config: { currency: "COP", minimum: 1000, maximum: 50000000 },
      },
      discount: {
        type: "Currency",
        label: "Descuento",
        config: { currency: "COP", minimum: 0 },
      },
      total: {
        type: "Currency",
        label: "Total",
        config: {
          currency: "COP",
          formula: { op: "difference", fields: ["price", "discount"] },
        },
      },
    }),
  };

  it("validates valid and invalid currency values", () => {
    const valid = validateRecord(object, {
      name: "Producto Todo Riesgo",
      price: 2500000,
      discount: 200000,
    });
    expect(valid.errors).toEqual({});
    expect(valid.data.price).toBe(2500000);
    expect(valid.data.total).toBe(2300000);

    const invalid = validateRecord(object, {
      name: "Producto Inválido",
      price: "no-es-numero",
      discount: -50,
    });
    expect(invalid.errors.price).toBe("Precio: debe ser un número");
    expect(invalid.errors.discount).toBe(
      "Descuento: fuera del rango permitido",
    );
  });

  it("supports Currency in pipeline amountField", () => {
    const pipelineObject = {
      name: "pipeline_deal",
      label: "Oportunidades",
      description: "",
      config: {
        ...makeConfig({
          name: { type: "Textbox", label: "Nombre" },
          amount: {
            type: "Currency",
            label: "Monto",
            config: { currency: "USD" },
          },
          stage: {
            type: "Dropdown",
            label: "Etapa",
            options: [
              { label: "Nuevo", value: "new" },
              { label: "Ganado", value: "won" },
            ],
          },
        }),
        studio: {
          pipeline: {
            field: "stage",
            amountField: "amount",
            wonValues: ["won"],
          },
        },
      },
    };

    const parsed = objectSchema.safeParse(pipelineObject);
    expect(parsed.success).toBe(true);
  });

  it.each([
    ["1500000", "50000"],
    ["COP 1.500.000,00", "50.000,00 COP"],
    ["$ 1,500,000.00", "50 000,00"],
  ])("parses currency in CSV import from %s and %s", (price, discount) => {
    const result = mapCsvRow(
      object,
      ["Nombre", "Precio", "Descuento"],
      ["Contrato Auto", price, discount],
      { Nombre: "name", Precio: "price", Descuento: "discount" },
    );
    expect(result.errors).toEqual({});
    expect(result.data.price).toBe(1500000);
    expect(result.data.discount).toBe(50000);
    expect(result.data.total).toBe(1450000);
  });

  it.each(["USD 1500000", "COP 1USD500000", "COP 1.234", "COP"])(
    "reports an error for the amount %s",
    (price) => {
      const result = mapCsvRow(
        object,
        ["Nombre", "Precio"],
        ["Contrato Auto", price],
        { Nombre: "name", Precio: "price" },
      );
      expect(result.errors.price).toBeDefined();
      expect(result.data.price).toBeNull();
    },
  );

  it("imports an unambiguous decimal comma into a number field", () => {
    const measurements: StudioObject = {
      ...object,
      config: makeConfig({ measure: { type: "Number", label: "Measure" } }),
    };
    const result = mapCsvRow(measurements, ["Measure"], ["-12,5"], {
      Measure: "measure",
    });
    expect(result).toEqual({ data: { measure: -12.5 }, errors: {} });
  });
});

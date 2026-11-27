// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, cleanup, within } from "@testing-library/react";
import { mapCsvRow, parseCsv } from "@savia/studio-shared/csv";
import { objectSchema } from "@savia/studio-shared/metadata";
import { render } from "./studio-test-render";
import userEvent from "@testing-library/user-event";
import { CollectionImportWizard } from "../collection-import-wizard";
import { parseSpreadsheetFile } from "../spreadsheet-parser";
import * as XLSX from "xlsx";
import * as apiModule from "../api";

vi.mock("../api", () => ({
  api: vi.fn(),
}));

beforeEach(() => {
  (apiModule.api as any).mockImplementation((path: string) => {
    if (path === "/objects") {
      return Promise.resolve({
        data: [
          { name: "clientes", label: "Clientes" },
          { name: "contracts", label: "Contratos" },
        ],
      });
    }
    return Promise.resolve({ data: {} });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Spreadsheet Parser", () => {
  it("parses CSV file into headers and rows", async () => {
    const csvContent =
      "Nombre,Email,Edad\nAna,ana@example.com,28\nCarlos,carlos@example.com,34";
    const file = new File([csvContent], "clientes.csv", { type: "text/csv" });

    const result = await parseSpreadsheetFile(file);
    expect(result.fileName).toBe("clientes.csv");
    expect(result.headers).toEqual(["Nombre", "Email", "Edad"]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual(["Ana", "ana@example.com", "28"]);
    expect(result.rows[1]).toEqual(["Carlos", "carlos@example.com", "34"]);
  });

  it("parses Excel (.xlsx) file with XLSX utility and supports multiple sheets", async () => {
    const wb = XLSX.utils.book_new();
    const wsContratos = XLSX.utils.aoa_to_sheet([
      ["Contrato", "Valor", "Activo"],
      ["POL-100", 150000, true],
      ["POL-200", 250000, false],
    ]);
    const wsIncidentes = XLSX.utils.aoa_to_sheet([
      ["Numero", "Fecha"],
      ["SIN-1", "2026-01-01"],
    ]);
    XLSX.utils.book_append_sheet(wb, wsContratos, "Contratos");
    XLSX.utils.book_append_sheet(wb, wsIncidentes, "Incidentes");
    const buffer = XLSX.write(wb, { type: "array", bookType: "xlsx" });

    const file = new File([buffer], "datos.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    const result = await parseSpreadsheetFile(file);
    expect(result.fileName).toBe("datos.xlsx");
    expect(result.sheetNames).toEqual(["Contratos", "Incidentes"]);
    expect(result.selectedSheet).toBe("Contratos");
    expect(result.headers).toEqual(["Contrato", "Valor", "Activo"]);
    expect(result.rows).toHaveLength(2);

    // Switch sheet
    const switched = await parseSpreadsheetFile(file, "Incidentes");
    expect(switched.selectedSheet).toBe("Incidentes");
    expect(switched.headers).toEqual(["Numero", "Fecha"]);
    expect(switched.rows).toHaveLength(1);
  });
});

describe("CollectionImportWizard Component", () => {
  it("renders wizard header, stepper and dropzone on mount", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();

    render(<CollectionImportWizard onClose={onClose} onCreated={onCreated} />);

    expect(
      screen.getByText("Crear Colección y Pantalla desde Archivo"),
    ).toBeInTheDocument();
    expect(screen.getByText("Archivo")).toBeInTheDocument();
    expect(screen.getByText("Pantalla")).toBeInTheDocument();
    expect(screen.getByText("Campos y Tipos")).toBeInTheDocument();
    expect(screen.getByText("Confirmar")).toBeInTheDocument();
    expect(
      screen.getByText(/Arrastra y suelta tu archivo Excel/i),
    ).toBeInTheDocument();
  });

  it("allows switching to blank object creation if callback provided", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const onSwitchToBlank = vi.fn();
    const user = userEvent.setup();

    render(
      <CollectionImportWizard
        onClose={onClose}
        onCreated={onCreated}
        onSwitchToBlank={onSwitchToBlank}
      />,
    );

    const switchBtn = screen.getByText(
      /¿Prefieres diseñar un objeto en blanco desde cero\?/i,
    );
    await user.click(switchBtn);
    expect(onSwitchToBlank).toHaveBeenCalledTimes(1);
  });

  it("imports repeated headers and untitled Excel columns separately", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const api = vi.mocked(apiModule.api);
    api.mockImplementation(async (path, method, body) => {
      if (path === "/objects" && method === "POST")
        return { data: objectSchema.parse(body) };
      if (path.endsWith("/preview")) return { importId: "headers-import" };
      if (path.endsWith("/commit"))
        return { data: [], summary: { created: 1, skipped: 0, errors: 0 } };
      return { data: [] };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Nombre", null, "Nombre", "Nombre (2)", "Columna_2", null, ""],
        ["Ana", "Ventas", "María", "Elena", "Norte", "Móvil", ""],
      ]),
      "Personas",
    );
    const file = new File(
      [XLSX.write(workbook, { type: "array", bookType: "xlsx" })],
      "personas.xlsx",
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );
    render(<CollectionImportWizard onClose={vi.fn()} onCreated={onCreated} />);
    await user.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      file,
    );
    await screen.findByText("personas.xlsx");
    expect(screen.getByText("6 columnas detectadas")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Continuar a Pantalla/i }),
    );
    await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));
    await user.click(
      screen.getByRole("button", { name: /Confirmar e Importar/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /Crear e Importar 1 registros/i }),
    );
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));

    const [, object] = onCreated.mock.calls[0];
    const [, , body] = api.mock.calls.find(([path]) =>
      path.endsWith("/commit"),
    )!;
    const { csv, mapping } = body as {
      csv: string;
      mapping: Record<string, string>;
    };
    const { headers, rows } = parseCsv(csv);
    expect(headers).toEqual([
      "Nombre",
      "Columna_2 (2)",
      "Nombre (3)",
      "Nombre (2)",
      "Columna_2",
      "Columna_6",
    ]);
    expect(mapCsvRow(object, headers, rows[0], mapping)).toEqual({
      data: {
        nombre: "Ana",
        columna_2_2: "Ventas",
        nombre_3: "María",
        nombre_2: "Elena",
        columna_2: "Norte",
        columna_6: "Móvil",
      },
      errors: {},
    });
  });

  it.each([false, true])("imports sheet date1904=%s", async (date1904) => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const api = vi.mocked(apiModule.api);
    api.mockImplementation(async (path, method, body) => {
      if (path === "/objects" && method === "POST") return { data: body };
      if (path.endsWith("/preview")) return { importId: "inventory-import" };
      if (path.endsWith("/commit"))
        return { data: [], summary: { created: 2, skipped: 0, errors: 0 } };
      return { data: [] };
    });

    const workbook = XLSX.utils.book_new();
    workbook.Workbook = { WBProps: { date1904 } };
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([["Nombre"], ["Ana"]]),
      "Personas",
    );
    const november27 = 46353 - (date1904 ? 1462 : 0);
    const inventory = XLSX.utils.aoa_to_sheet([
      ["Producto", "Cantidad", "Teléfono", "Fecha", "Saldo"],
      ["Mesa", 3, "+57 300 123 4567", november27 + 22.5 / 24, "-12.5"],
      ["Silla", 6, "+57 300 123 4568", november27 + 1, "-15.5"],
    ]);
    inventory.D2.z = "yyyy-mm-dd hh:mm";
    inventory.D3.z = "yyyy-mm-dd";
    XLSX.utils.book_append_sheet(workbook, inventory, "Inventario");
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([]),
      "Vacia",
    );
    const file = new File(
      [XLSX.write(workbook, { type: "array", bookType: "xlsx" })],
      "plantilla.xlsx",
      {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      },
    );

    render(<CollectionImportWizard onClose={vi.fn()} onCreated={onCreated} />);
    await user.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      file,
    );
    const sheet = await screen.findByRole("combobox", {
      name: "Hoja de cálculo activa",
    });
    expect(sheet).toHaveValue("Personas");
    expect(screen.getByText("1 registros")).toBeInTheDocument();

    await user.selectOptions(sheet, "Inventario");
    expect(await screen.findByText("2 registros")).toBeInTheDocument();
    expect(screen.getByText("5 columnas detectadas")).toBeInTheDocument();

    await user.selectOptions(sheet, "Vacia");
    expect(await screen.findByRole("alert")).toHaveTextContent(/está vacía/i);
    expect(sheet).toHaveValue("Inventario");
    expect(screen.getByText("2 registros")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /Continuar a Pantalla/i }),
    );
    expect(screen.getByDisplayValue("Inventario")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));
    expect(screen.getByDisplayValue("Producto")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Cantidad")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Nombre")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: /Confirmar e Importar/i }),
    );
    await user.click(
      screen.getByRole("button", { name: /Crear e Importar 2 registros/i }),
    );

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const payload = {
      csv:
        '\uFEFF"Producto","Cantidad","Teléfono","Fecha","Saldo"\r\n' +
        '"Mesa","3","+57 300 123 4567","2026-11-27","-12.5"\r\n' +
        '"Silla","6","+57 300 123 4568","2026-11-28","-15.5"\r\n',
      mapping: {
        Producto: "producto",
        Cantidad: "cantidad",
        Teléfono: "telefono",
        Fecha: "fecha",
        Saldo: "saldo",
      },
    };
    expect(api).toHaveBeenCalledWith(
      "/import/inventario/preview",
      "POST",
      payload,
    );
    expect(api).toHaveBeenCalledWith("/import/inventario/commit", "POST", {
      ...payload,
      importId: "inventory-import",
    });
    const { headers, rows } = parseCsv(payload.csv);
    const [, object] = onCreated.mock.calls[0];
    expect(mapCsvRow(object, headers, rows[0], payload.mapping)).toEqual({
      data: {
        producto: "Mesa",
        cantidad: 3,
        telefono: "+57 300 123 4567",
        fecha: "2026-11-27",
        saldo: -12.5,
      },
      errors: {},
    });
  });

  it("progresses through wizard steps, detects relations/formulas and creates object on submit", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const user = userEvent.setup();

    (apiModule.api as any).mockImplementation(
      (path: string, method?: string, body?: unknown) => {
        if (path === "/objects" && (!method || method === "GET")) {
          return Promise.resolve({
            data: [
              { name: "clientes", label: "Clientes" },
              { name: "contracts", label: "Contratos" },
            ],
          });
        }
        if (path === "/objects" && method === "POST") {
          return Promise.resolve({ data: objectSchema.parse(body) });
        }
        if (path.includes("/import") && path.includes("/preview")) {
          return Promise.resolve({ importId: "import_123" });
        }
        if (path.includes("/import") && path.includes("/commit")) {
          return Promise.resolve({
            data: [],
            summary: { created: 2, skipped: 0, errors: 0 },
          });
        }
        return Promise.resolve({ data: [] });
      },
    );

    render(<CollectionImportWizard onClose={onClose} onCreated={onCreated} />);

    // File with:
    // 1. Cliente ID (FK to 'clientes')
    // 2. Cantidad, Precio, Total (Formula: total = cantidad * precio)
    const csvContent =
      "Cliente ID,Cantidad,Precio,Total\n" +
      "cli_1,2,500,1000\n" +
      "cli_2,3,100,300";
    const file = new File([csvContent], "cotizaciones.csv", {
      type: "text/csv",
    });

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByText("cotizaciones.csv")).toBeInTheDocument();
      expect(screen.getByText("2 registros")).toBeInTheDocument();
    });

    // Step 1 -> Step 2
    const toScreenBtn = screen.getByRole("button", {
      name: /Continuar a Pantalla/i,
    });
    await user.click(toScreenBtn);

    expect(screen.getByDisplayValue("Cotizaciones")).toBeInTheDocument();
    expect(screen.getByDisplayValue("cotizaciones")).toBeInTheDocument();

    // Step 2 -> Step 3
    const toFieldsBtn = screen.getByRole("button", { name: /Revisar Campos/i });
    await user.click(toFieldsBtn);

    expect(screen.getByText("Etiqueta en pantalla")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Cliente ID")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Cantidad")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Precio")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Total")).toBeInTheDocument();

    // Verify formula detection badge and relation badge exist
    expect(screen.getByText(/cantidad × precio/i)).toBeInTheDocument();
    expect(screen.getByText(/Relación:/i)).toBeInTheDocument();

    // Step 3 -> Step 4
    const toConfirmBtn = screen.getByRole("button", {
      name: /Confirmar e Importar/i,
    });
    await user.click(toConfirmBtn);

    expect(
      screen.getByText("Resumen de la nueva Pantalla"),
    ).toBeInTheDocument();

    // Execute create
    const createBtn = screen.getByRole("button", {
      name: /Crear e Importar 2 registros/i,
    });
    await user.click(createBtn);

    await waitFor(() => {
      expect(apiModule.api).toHaveBeenCalledWith(
        "/objects",
        "POST",
        expect.objectContaining({
          name: "cotizaciones",
          label: "Cotizaciones",
          config: expect.objectContaining({
            version: 2,
            fields: expect.objectContaining({
              cliente_id: expect.objectContaining({
                type: "Dropdown",
                config: expect.objectContaining({
                  relation: "clientes",
                  collectionRelation: "manual",
                }),
              }),
              total: expect.objectContaining({
                config: expect.objectContaining({
                  formula: expect.objectContaining({
                    op: "product",
                    fields: ["cantidad", "precio"],
                  }),
                }),
              }),
            }),
          }),
        }),
      );
      expect(onCreated).toHaveBeenCalledWith(
        "cotizaciones",
        expect.objectContaining({ name: "cotizaciones" }),
      );
    });
  });

  it.each(["exclude", "retype"] as const)(
    "keeps a valid schema after %s",
    async (edit) => {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      const api = vi.mocked(apiModule.api);
      api.mockImplementation(async (path, method, body) => {
        if (path === "/objects" && method === "POST")
          return { data: objectSchema.parse(body) };
        if (path.endsWith("/preview")) return { importId: "orders-import" };
        if (path.endsWith("/commit"))
          return { data: [], summary: { created: 2, skipped: 0, errors: 0 } };
        return { data: [] };
      });

      render(
        <CollectionImportWizard onClose={vi.fn()} onCreated={onCreated} />,
      );
      await user.upload(
        document.querySelector<HTMLInputElement>('input[type="file"]')!,
        new File(
          [
            "Etapa,Cantidad,Precio,Total,Correo,Teléfono,Notas\n" +
              "Nueva,2,500,1000,ana@example.com,+57 300 123 4567,Entregar temprano\n" +
              "Cerrada,3,100,300,luis@example.com,+57 300 123 4568,Recibido",
          ],
          "pedidos.csv",
          { type: "text/csv" },
        ),
      );
      await user.click(
        await screen.findByRole("button", { name: /Continuar a Pantalla/i }),
      );
      const screenName = screen.getByLabelText(
        "Nombre visible de la Colección",
      );
      await user.clear(screenName);
      await user.type(screenName, "Pedidos confirmados");
      await user.selectOptions(
        screen.getByLabelText("Distribución de columnas"),
        "1",
      );
      await user.selectOptions(
        screen.getByLabelText("Sección en el Menú lateral"),
        "administration",
      );
      if (edit === "retype") {
        await user.selectOptions(
          screen.getByRole("combobox", { name: "Campo de importe (opcional)" }),
          "total",
        );
      }
      await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));
      expect(screen.getByText("cantidad × precio")).toBeInTheDocument();
      if (edit === "exclude") {
        const quantity = within(
          screen.getByDisplayValue("Cantidad").closest("tr")!,
        );
        await user.click(quantity.getByRole("checkbox"));
      } else {
        for (const label of ["Etapa", "Precio"]) {
          const row = within(screen.getByDisplayValue(label).closest("tr")!);
          await user.selectOptions(row.getByRole("combobox"), "Textbox");
        }
      }
      const notes = within(screen.getByDisplayValue("Notas").closest("tr")!);
      await user.click(notes.getByRole("checkbox"));
      const total = screen.getByDisplayValue("Total");
      const totalRow = within(total.closest("tr")!);
      await user.clear(total);
      await user.type(total, "Total confirmado");
      await user.click(totalRow.getByRole("switch"));
      expect(screen.queryByText("cantidad × precio")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Anterior" }));
      const sections = screen.getByRole("switch", {
        name: "Organizar campos en Secciones",
      });
      await user.click(sections);
      expect(sections).not.toBeChecked();
      if (edit === "retype") await user.click(sections);
      expect(
        screen.getByLabelText("Nombre visible de la Colección"),
      ).toHaveValue("Pedidos confirmados");
      expect(screen.getByLabelText("Distribución de columnas")).toHaveValue(
        "1",
      );
      expect(
        screen.getByRole("combobox", { name: "Campo de etapa / estado" }),
      ).toHaveValue(edit === "exclude" ? "etapa" : "");
      expect(
        screen.getByRole("combobox", { name: "Campo de importe (opcional)" }),
      ).toHaveValue(edit === "exclude" ? "" : "total");
      await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));

      await user.click(
        screen.getByRole("button", { name: /Confirmar e Importar/i }),
      );
      await user.click(
        screen.getByRole("button", { name: /Crear e Importar 2 registros/i }),
      );
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
      const [, object] = onCreated.mock.calls[0];
      expect(object.name).toBe("pedidos_confirmados");
      expect(object.config.studio.screen.section).toBe("administration");
      expect(object.config.studio.columns).toBe(1);
      expect(object.config.fields.notas).toBeUndefined();
      expect(object.config.fields.total).toMatchObject({
        label: "Total confirmado",
        required: true,
      });
      if (edit === "exclude") {
        expect(object.config.studio.sections).toBeUndefined();
        expect(object.config.fields.total.config?.section).toBeUndefined();
      } else {
        expect(object.config.fields.total.config?.section).toBe("sec_valores");
        expect(object.config.studio.sections).not.toContainEqual(
          expect.objectContaining({ id: "sec_detalles" }),
        );
      }
      expect(object.config.fields.total.config?.formula).toBeUndefined();
      expect(object.config.studio.pipeline).toEqual(
        edit === "exclude" ? { field: "etapa" } : undefined,
      );
      const [, , body] = api.mock.calls.find(([path]) =>
        path.endsWith("/commit"),
      )!;
      const { csv, mapping } = body as {
        csv: string;
        mapping: Record<string, string>;
      };
      const { headers, rows } = parseCsv(csv);
      expect(headers).not.toContain("Notas");
      expect(csv).not.toContain("Entregar temprano");
      expect(mapCsvRow(object, headers, rows[0], mapping)).toMatchObject({
        data: { total: 1000 },
        errors: {},
      });
    },
  );

  it.each([false, true])(
    "omits rows empty after field selection (%s)",
    async (allEmpty) => {
      const user = userEvent.setup();
      const onCreated = vi.fn();
      const api = vi.mocked(apiModule.api);
      api.mockImplementation(async (path, method, body) => {
        if (path === "/objects" && method === "POST")
          return { data: objectSchema.parse(body) };
        if (path.endsWith("/preview")) return { importId: "notes-import" };
        if (path.endsWith("/commit"))
          return { data: [], summary: { created: 1, skipped: 0, errors: 0 } };
        return { data: [] };
      });

      render(
        <CollectionImportWizard onClose={vi.fn()} onCreated={onCreated} />,
      );
      await user.upload(
        document.querySelector<HTMLInputElement>('input[type="file"]')!,
        new File(
          [
            `Cantidad,Notas\n${allEmpty ? "" : "0"},Primera nota\n,Segunda nota`,
          ],
          "notas.csv",
          { type: "text/csv" },
        ),
      );
      await user.click(
        await screen.findByRole("button", { name: /Continuar a Pantalla/i }),
      );
      await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));
      const notes = within(screen.getByDisplayValue("Notas").closest("tr")!);
      await user.click(notes.getByRole("checkbox"));
      await user.click(
        screen.getByRole("button", { name: /Confirmar e Importar/i }),
      );
      expect(
        screen.getByText(
          `Se omitirán las filas sin datos en los campos seleccionados (${allEmpty ? 2 : 1}).`,
        ),
      ).toBeInTheDocument();
      await user.click(
        screen.getByRole("button", {
          name: allEmpty
            ? "Crear Colección y Pantalla"
            : /Crear e Importar 1 registros/,
        }),
      );

      const summary = await screen.findByRole("status");
      expect(summary).toHaveTextContent(
        allEmpty
          ? "0 importados · 2 omitidos · 0 con errores"
          : "1 importados · 1 omitidos · 0 con errores",
      );
      const requests = api.mock.calls.filter(([path]) =>
        path.startsWith("/import/"),
      );
      expect(requests).toHaveLength(allEmpty ? 0 : 2);
      if (!allEmpty) {
        for (const [, , body] of requests) {
          const { csv, mapping } = body as {
            csv: string;
            mapping: Record<string, string>;
          };
          expect(parseCsv(csv)).toEqual({
            headers: ["Cantidad"],
            rows: [["0"]],
          });
          expect(mapping).toEqual({ Cantidad: "cantidad" });
        }
      }
      expect(onCreated).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Abrir pantalla" }));
      await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    },
  );

  it("splits large CSV payloads and reports a row too large for a batch", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const api = vi.mocked(apiModule.api);
    const limit = 1024 * 1024;
    const previews: { csv: string }[] = [];
    api.mockImplementation(async (path, method, body) => {
      if (path === "/objects" && method === "POST")
        return { data: objectSchema.parse(body) };
      if (path.endsWith("/preview")) {
        const request = body as { csv: string };
        if (request.csv.length > limit)
          throw new Error("CSV exceeded API limit");
        previews.push(request);
        return { importId: `size-batch-${previews.length}` };
      }
      if (path.endsWith("/commit"))
        return { data: [], summary: { created: 1, skipped: 0, errors: 0 } };
      return { data: [] };
    });

    const longValue = "Texto largo. ".repeat(45_000);
    const hugeValue = "x".repeat(limit);
    const file = new File(
      [
        `Nombre,Notas\nPrimero,${longValue}\nEnorme,${hugeValue}\nÚltimo,${longValue}`,
      ],
      "notas_extensas.csv",
      { type: "text/csv" },
    );
    render(<CollectionImportWizard onClose={vi.fn()} onCreated={onCreated} />);
    await user.upload(
      document.querySelector<HTMLInputElement>('input[type="file"]')!,
      file,
    );
    await user.click(
      await screen.findByRole("button", { name: /Continuar a Pantalla/i }),
    );
    await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));
    await user.click(
      screen.getByRole("button", { name: /Confirmar e Importar/i }),
    );
    await user.click(screen.getByRole("button", { name: /Crear e Importar/i }));

    const result = await screen.findByRole("status");
    expect(result).toHaveTextContent(
      "2 importados · 0 omitidos · 1 con errores",
    );
    expect(result).toHaveTextContent(/registro 2 supera el tamaño máximo/i);
    expect(previews.map(({ csv }) => parseCsv(csv).rows[0][0])).toEqual([
      "Primero",
      "Último",
    ]);
    expect(previews.every(({ csv }) => csv.length <= limit)).toBe(true);
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/commit")),
    ).toHaveLength(2);
  });

  it.each([
    { scenario: "without interruption", loseResponse: false, partial: false },
    {
      scenario: "after losing the second batch response",
      loseResponse: true,
      partial: false,
    },
    {
      scenario: "with rejected and omitted rows across resumed batches",
      loseResponse: true,
      partial: true,
    },
  ])("imports batches $scenario", async ({ loseResponse, partial }) => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    const user = userEvent.setup();

    const previewCalls: any[] = [];
    const commitCalls: any[] = [];
    const createCollection = vi
      .fn()
      .mockResolvedValueOnce({ data: { name: "grandes_contracts" } })
      .mockRejectedValue(new Error("Collection already exists"));

    (apiModule.api as any).mockImplementation(
      (path: string, method: string, body: any) => {
        if (path === "/objects" && method === "POST") {
          return createCollection();
        }
        if (path.includes("/import") && path.includes("/preview")) {
          previewCalls.push({ path, body });
          return Promise.resolve({
            importId: `import_chunk_${previewCalls.length}`,
          });
        }
        if (path.includes("/import") && path.includes("/commit")) {
          commitCalls.push({ path, body });
          if (loseResponse && commitCalls.length === 2)
            return Promise.reject(new Error("Connection interrupted"));
          const batch = Number(body.importId.at(-1));
          const skipped = partial && batch !== 2 ? 1 : 0;
          const errors = partial && batch === 2 ? 1 : 0;
          return Promise.resolve({
            summary: {
              created: (batch === 3 ? 250 : 1000) - skipped - errors,
              skipped,
              errors,
            },
            data: errors
              ? [{ row: 2, status: "error", error: "Cantidad inválida" }]
              : [],
          });
        }
        return Promise.resolve({ data: [] });
      },
    );

    render(<CollectionImportWizard onClose={onClose} onCreated={onCreated} />);

    // Generate 2,250 rows to trigger 3 sequential chunks: [1..1000], [1001..2000], [2001..2250]
    let csvContent = "Codigo,Descripcion\n";
    for (let i = 1; i <= 2250; i++) {
      csvContent += `POL-${i},Producto ${i}\n`;
    }
    const file = new File([csvContent], "grandes_contracts.csv", {
      type: "text/csv",
    });

    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(input, file);

    await waitFor(() => {
      expect(screen.getByText("2250 registros")).toBeInTheDocument();
      expect(screen.getByText(/3 lotes automáticos/i)).toBeInTheDocument();
    });

    // Advance to Step 2
    await user.click(
      screen.getByRole("button", { name: /Continuar a Pantalla/i }),
    );
    // Advance to Step 3
    await user.click(screen.getByRole("button", { name: /Revisar Campos/i }));
    // Advance to Step 4
    await user.click(
      screen.getByRole("button", { name: /Confirmar e Importar/i }),
    );

    // Confirm button shows 3 lotes notice
    const createBtn = screen.getByRole("button", {
      name: /Crear e Importar 2250 registros/i,
    });
    expect(createBtn).toBeInTheDocument();
    await user.click(createBtn);

    if (loseResponse) {
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Connection interrupted",
      );
      expect(previewCalls).toHaveLength(2);
      expect(onCreated).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Anterior" })).toBeDisabled();
      expect(screen.getByRole("switch")).toBeDisabled();
      await user.click(
        screen.getByRole("button", { name: "Reanudar importación" }),
      );
    }

    if (partial) {
      expect(onCreated).not.toHaveBeenCalled();
      const outcome = await screen.findByRole("status");
      expect(outcome).toHaveTextContent(
        /2247 importados.*2 omitidos.*1 con errores/i,
      );
      expect(outcome).toHaveTextContent("Cantidad inválida");
      await user.click(screen.getByRole("button", { name: "Abrir pantalla" }));
    }

    await waitFor(() => {
      expect(createCollection).toHaveBeenCalledTimes(1);
      expect(previewCalls).toHaveLength(3);
      expect(commitCalls).toHaveLength(loseResponse ? 4 : 3);
      expect(onCreated).toHaveBeenCalledTimes(1);
    });

    // Chunk 1: rows 0 to 1000
    expect(previewCalls[0].body.csv).toContain("POL-1");
    expect(previewCalls[0].body.csv).toContain("POL-1000");
    expect(previewCalls[0].body.csv).not.toContain("POL-1001");
    expect(commitCalls[0].body.importId).toBe("import_chunk_1");

    // Chunk 2: rows 1000 to 2000
    expect(previewCalls[1].body.csv).toContain("POL-1001");
    expect(previewCalls[1].body.csv).toContain("POL-2000");
    expect(previewCalls[1].body.csv).not.toContain("POL-2001");
    expect(commitCalls[1].body.importId).toBe("import_chunk_2");

    // Chunk 3: remaining 250 rows
    expect(previewCalls[2].body.csv).toContain("POL-2001");
    expect(previewCalls[2].body.csv).toContain("POL-2250");
    if (loseResponse) expect(commitCalls[2]).toEqual(commitCalls[1]);
    expect(commitCalls.at(-1).body.importId).toBe("import_chunk_3");

    // Final navigation called
    expect(onCreated).toHaveBeenCalledWith(
      "grandes_contracts",
      expect.objectContaining({ name: "grandes_contracts" }),
    );
  });
});

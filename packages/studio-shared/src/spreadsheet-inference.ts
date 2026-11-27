import type { IFieldConfig, IFormConfig } from "@form-eng/core";
import {
  identifier,
  reservedRecordFields,
  supportedTypes,
  type StudioObject,
  type RecordSurface,
  type ScreenNavigationIcon,
  type ScreenNavigationSection,
  type StudioConfig,
} from "./metadata";
import { calculateFormulaValue } from "./rules";
import { protectedAccessFields } from "./access-control";

export type InferredFormula = {
  op: "sum" | "difference" | "product" | "ratio";
  fields: string[];
};

export type InferredRelation = {
  targetObject: string;
  label?: string;
};

export type InferredColumn = {
  key: string;
  originalHeader: string;
  label: string;
  type: (typeof supportedTypes)[number];
  required: boolean;
  config?: Record<string, unknown>;
  options?: { value: string; label: string }[];
  sampleValues: string[];
  formula?: InferredFormula;
  relation?: InferredRelation;
  section?: string;
};

export type InferredSpreadsheetSchema = {
  collectionName: string;
  collectionLabel: string;
  description: string;
  columns: InferredColumn[];
  config: IFormConfig & { studio?: StudioConfig };
  suggestedPipeline?: {
    field: string;
    amountField?: string;
  };
  suggestedMenuSection: ScreenNavigationSection;
  suggestedIcon: ScreenNavigationIcon;
};

/**
 * Normalizes a column header into a valid Savia CRM identifier:
 * /^[a-z][a-z0-9_]{0,47}$/
 */
export function normalizeHeaderToIdentifier(
  header: string,
  existingKeys: Set<string> = new Set(),
): string {
  let clean = (header || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!clean || !/^[a-z]/.test(clean)) {
    clean = `col_${clean || "field"}`;
  }

  clean = clean.slice(0, 42);

  let candidate = clean;
  let counter = 1;
  while (existingKeys.has(candidate)) {
    counter++;
    candidate = `${clean}_${counter}`.slice(0, 47);
  }

  existingKeys.add(candidate);
  return candidate;
}

/**
 * Derives a readable label from a file or sheet name.
 */
export function deriveLabelFromFilename(name: string): {
  label: string;
  name: string;
} {
  const base = name.replace(/\.[^/.]+$/, "").trim();
  const label =
    base.charAt(0).toUpperCase() + base.slice(1).replace(/[_-]+/g, " ");
  const identifierKey = normalizeHeaderToIdentifier(base);
  return { label: label || "Nueva Colección", name: identifierKey };
}

const BOOLEAN_REGEX = /^(true|false|si|sí|no|1|0)$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_REGEX = /^https?:\/\/[^\s]+$/i;
const PHONE_REGEX = /^\+?[\d\s().-]{7,25}$/;
const currencyMark = "[$€£¥]|COP|USD|EUR|MXN|CLP|GBP|JPY";
const leadingCurrency = new RegExp(`^([+-]?)\\s*(${currencyMark})\\s*`, "i");
const trailingCurrency = new RegExp(`(${currencyMark})$`, "i");
const currencySymbols: Record<string, string> = {
  "€": "EUR",
  "£": "GBP",
  "¥": "JPY",
};

function parseCurrencyText(value: string) {
  const text = value.trim();
  const prefix = leadingCurrency.exec(text);
  const suffix = prefix ? null : trailingCurrency.exec(text);
  const marker = prefix?.[2] ?? suffix?.[1];
  const amount = prefix
    ? prefix[1] + text.slice(prefix[0].length)
    : text.slice(0, suffix?.index ?? text.length).trimEnd();
  // A single separator followed by three digits can change the magnitude.
  if (marker && /^[+-]?\d{1,3}[.,]\d{3}$/.test(amount)) return null;
  const number = parseNumberValue(amount);
  if (number === null) return null;
  const currency =
    marker && marker !== "$"
      ? (currencySymbols[marker] ?? marker.toUpperCase())
      : undefined;
  return { amount: number, marker, currency };
}

export function parseCurrencyValue(value: unknown, expectedCurrency?: string) {
  if (typeof value !== "string") return parseNumberValue(value);
  const parsed = parseCurrencyText(value);
  if (
    !parsed ||
    (parsed.currency &&
      expectedCurrency &&
      parsed.currency !== expectedCurrency.toUpperCase())
  )
    return null;
  return parsed.amount;
}

function isDateValue(val: unknown): boolean {
  if (val instanceof Date && !isNaN(val.getTime())) return true;
  if (typeof val !== "string") return false;
  const trimmed = val.trim();
  if (!trimmed || /^\d+$/.test(trimmed)) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return !isNaN(Date.parse(trimmed));
  }
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/.test(trimmed)) {
    const parts = trimmed.split(/[/-]/);
    if (parts.length >= 3) return true;
  }
  return false;
}

export function parseNumberValue(val: unknown): number | null {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val !== "string") return null;
  const text = val.trim();
  if (!text || /^[+-]?\d{1,3},\d{3}$/.test(text)) return null;
  const direct = Number(text);
  if (Number.isFinite(direct)) return direct;

  let normalized: string;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text))
    normalized = text.replace(/,/g, "");
  else if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text))
    normalized = text.replace(/\./g, "").replace(",", ".");
  else if (/^[+-]?\d{1,3}([ \u00a0\u202f]\d{3})+([.,]\d+)?$/.test(text))
    normalized = text.replace(/[ \u00a0\u202f]/g, "").replace(",", ".");
  else if (/^[+-]?\d+,\d+$/.test(text)) normalized = text.replace(",", ".");
  else return null;

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

/**
 * Detects the most appropriate field type given a sample of column values.
 */
export function detectColumnType(
  rawValues: unknown[],
  headerName = "",
): {
  type: (typeof supportedTypes)[number];
  config?: Record<string, unknown>;
  options?: { value: string; label: string }[];
} {
  if (headerName.trim().toLowerCase() === "id") return { type: "Textbox" };
  const values = rawValues
    .map((v) => (v instanceof Date ? v : typeof v === "string" ? v.trim() : v))
    .filter((v) => v !== null && v !== undefined && v !== "");

  if (values.length === 0) {
    return { type: "Textbox" };
  }

  // 1. Check for Booleans
  const allBooleans = values.every(
    (v) =>
      typeof v === "boolean" ||
      (typeof v === "string" && BOOLEAN_REGEX.test(v)),
  );
  if (allBooleans) {
    return { type: "Toggle" };
  }

  // 2. Check for Dates
  const dateMatches = values.filter(isDateValue).length;
  if (dateMatches / values.length >= 0.8) {
    return { type: "DateControl" };
  }

  // 3. Check for Currency
  const currencyMatches = values
    .map((value) =>
      typeof value === "string" ? parseCurrencyText(value) : null,
    )
    .filter((value) => value?.marker);
  if (currencyMatches.length / values.length >= 0.6) {
    const detectedCurrency =
      currencyMatches.find((value) => value?.currency)?.currency ?? "USD";
    return {
      type: "Currency",
      config: { currency: detectedCurrency, decimals: 2 },
    };
  }

  // 4. Check for Email
  const allEmails = values.every(
    (v) => typeof v === "string" && EMAIL_REGEX.test(v),
  );
  if (allEmails) {
    return { type: "Email" };
  }

  // 5. Check for URL
  const allUrls = values.every(
    (v) => typeof v === "string" && URL_REGEX.test(v),
  );
  if (allUrls) {
    return { type: "Url" };
  }

  // 6. Check for Phone
  const allPhones = values.every(
    (v) =>
      typeof v === "string" &&
      PHONE_REGEX.test(v) &&
      (v.match(/\d/g) ?? []).length >= 7 &&
      (v.includes("+") ||
        v.includes(" ") ||
        v.includes("-") ||
        v.includes("(") ||
        v.length >= 10),
  );
  if (allPhones) {
    return { type: "Phone" };
  }

  // 7. Check for Numbers (integers / decimals)
  const numbers = values.map((value) =>
    typeof value === "string" && value.startsWith("+")
      ? null
      : parseNumberValue(value),
  );

  if (numbers.every((value) => value !== null)) {
    const allIntegers = numbers.every((value) => Number.isInteger(value));

    const lowerHeader = headerName.toLowerCase();
    if (
      /precio|valor|costo|tarifa|importe|total|amount|price|cost|comision|cuota/.test(
        lowerHeader,
      )
    ) {
      return {
        type: "Currency",
        config: { currency: "COP", decimals: allIntegers ? 0 : 2 },
      };
    }

    return {
      type: "Number",
      config: { integer: allIntegers },
    };
  }

  // 8. Check for Dropdown (Low cardinality strings)
  const stringValues = values.map((v) => String(v));
  const uniqueValues = Array.from(new Set(stringValues));

  const isStageHeader =
    /estado|etapa|fase|status|stage|categoria|tipo|prioridad|genero|sexo|canal|sector/.test(
      headerName.toLowerCase(),
    );

  const hasRepetitions = uniqueValues.length < values.length;
  const isCandidateDropdown =
    (isStageHeader && uniqueValues.length <= 25) ||
    (hasRepetitions && uniqueValues.length >= 1 && uniqueValues.length <= 15);

  if (
    isCandidateDropdown &&
    uniqueValues.every((val) => val.length <= 60 && !val.includes("\n"))
  ) {
    return {
      type: "Dropdown",
      options: uniqueValues.map((opt) => ({ value: opt, label: opt })),
    };
  }

  // 9. Check for Textarea
  const hasLongText = values.some(
    (v) =>
      typeof v === "string" &&
      (v.length > 120 || v.includes("\n") || v.includes("\r")),
  );
  if (hasLongText) {
    return { type: "Textarea" };
  }

  return { type: "Textbox" };
}

/**
 * Detects products, sums, and ordered differences between numeric columns.
 */
export function detectFormulas(
  columns: InferredColumn[],
  rows: unknown[][],
): void {
  const numericColumns = columns.flatMap((column, index) =>
    column.type === "Number" || column.type === "Currency"
      ? [{ column, index }]
      : [],
  );
  if (numericColumns.length < 3 || rows.length < 2) return;

  const readRow = (row: unknown[]) =>
    numericColumns.map(({ column, index }) =>
      column.type === "Currency"
        ? parseCurrencyValue(
            row[index],
            String(column.config?.currency || "COP"),
          )
        : parseNumberValue(row[index]),
    );
  const sample = rows.slice(0, 50).map(readRow);
  let remainingRows: (number | null)[][] | undefined;

  for (const [target, { column }] of numericColumns.entries()) {
    for (let a = 0; a < numericColumns.length; a++) {
      if (a === target) continue;
      for (let b = a + 1; b < numericColumns.length; b++) {
        if (b === target) continue;
        const candidates = [
          ["product", a, b],
          ["sum", a, b],
          ["difference", a, b],
          ["difference", b, a],
        ] as const;
        for (const [op, left, right] of candidates) {
          let completeRows = 0;
          const matches = (values: (number | null)[]) => {
            const first = values[left];
            const second = values[right];
            const calculated =
              first !== null && second !== null
                ? calculateFormulaValue(op, [first, second])
                : null;
            if (calculated !== values[target]) return false;
            if (calculated !== null) completeRows++;
            return true;
          };
          if (!sample.every(matches) || completeRows < 2) continue;
          remainingRows ??= rows.slice(sample.length).map(readRow);
          if (!remainingRows.every(matches)) continue;

          const formula = {
            op,
            fields: [
              numericColumns[left].column.key,
              numericColumns[right].column.key,
            ],
          };
          column.formula = formula;
          column.config = { ...column.config, formula };
          return;
        }
      }
    }
  }
}

/**
 * Detects foreign key relations to other known collections.
 */
export function detectRelations(
  columns: InferredColumn[],
  knownCollections: Array<{ name: string; label: string }> = [],
): void {
  if (!knownCollections.length) return;

  for (const column of columns) {
    const rawKey = column.key.toLowerCase();
    const rawHeader = column.originalHeader.toLowerCase();

    // Check for ID-like column names (cliente_id, id_cliente, codigo_agencia, etc.)
    const cleanCandidate = rawKey
      .replace(/(_id|id_|_codigo|_ref|_num)$/, "")
      .replace(/^id_/, "")
      .replace(/_/g, "");

    const matched = knownCollections.find((obj) => {
      const objClean = obj.name.toLowerCase().replace(/_/g, "");
      return (
        objClean === cleanCandidate ||
        `${objClean}s` === cleanCandidate ||
        objClean === `${cleanCandidate}s` ||
        obj.name.toLowerCase() === rawKey ||
        obj.label.toLowerCase() === rawHeader
      );
    });

    if (matched) {
      column.type = "Dropdown";
      column.relation = {
        targetObject: matched.name,
        label: matched.label,
      };
      column.config = {
        ...column.config,
        relation: matched.name,
        collectionRelation: "manual",
      };
    }
  }
}

/**
 * Groups fields into logical layout sections when there are many columns.
 */
export function generateFormSections(
  columns: InferredColumn[],
): { id: string; label: string }[] {
  const sectionsDef = [
    { id: "sec_general", label: "Información General" },
    { id: "sec_contacto", label: "Contacto" },
    { id: "sec_valores", label: "Valores y Finanzas" },
    { id: "sec_estado", label: "Estado y Fechas" },
    { id: "sec_detalles", label: "Detalles y Notas" },
  ];

  const sectionCounts: Record<string, number> = {
    sec_general: 0,
    sec_contacto: 0,
    sec_valores: 0,
    sec_estado: 0,
    sec_detalles: 0,
  };

  columns.forEach((col, idx) => {
    let targetSection = "sec_general";

    if (idx === 0) {
      targetSection = "sec_general";
    } else if (
      col.type === "Email" ||
      col.type === "Phone" ||
      col.type === "Url" ||
      col.type === "Address" ||
      /direccion|ciudad|pais|telefono|correo|web|sitio/.test(col.key)
    ) {
      targetSection = "sec_contacto";
    } else if (
      col.type === "Currency" ||
      (col.type === "Number" &&
        /precio|valor|costo|tarifa|importe|total|subtotal|monto|comision|cuota/.test(
          col.key,
        ))
    ) {
      targetSection = "sec_valores";
    } else if (
      col.type === "DateControl" ||
      col.type === "Toggle" ||
      (col.type === "Dropdown" &&
        /estado|etapa|fase|status|stage|prioridad/.test(col.key))
    ) {
      targetSection = "sec_estado";
    } else if (
      col.type === "Textarea" ||
      /nota|observacion|comentario|descripcion/.test(col.key)
    ) {
      targetSection = "sec_detalles";
    } else {
      targetSection = idx < 3 ? "sec_general" : "sec_detalles";
    }

    col.section = targetSection;
    col.config = {
      ...col.config,
      section: targetSection,
    };
    sectionCounts[targetSection]++;
  });

  return sectionsDef.filter((sec) => (sectionCounts[sec.id] ?? 0) > 0);
}

/**
 * Inspects parsed spreadsheet data and infers a complete Savia StudioObject configuration.
 */
export function inferSpreadsheetSchema(input: {
  fileName?: string;
  sheetName?: string;
  headers: string[];
  rows: unknown[][];
  knownCollections?: Array<{ name: string; label: string }>;
  enableSections?: boolean;
}): InferredSpreadsheetSchema {
  const {
    fileName = "",
    sheetName = "",
    headers,
    rows,
    knownCollections = [],
    enableSections = true,
  } = input;
  const isGenericSheet =
    !sheetName ||
    sheetName === "Sheet1" ||
    sheetName === "Hoja1" ||
    sheetName === "CSV";
  const baseLabel = !isGenericSheet ? sheetName : fileName;
  const { label: collectionLabel, name: collectionName } =
    deriveLabelFromFilename(baseLabel || "Colección");

  const existingKeys = new Set([
    ...reservedRecordFields,
    ...protectedAccessFields,
  ]);
  const columns: InferredColumn[] = [];
  const fields: Record<string, IFieldConfig> = {};
  const fieldOrder: string[] = [];

  const sampleRows = rows.slice(0, 100);

  headers.forEach((header, index) => {
    const key = normalizeHeaderToIdentifier(header, existingKeys);
    const colValues = sampleRows.map((r) => r[index]);
    const detected = detectColumnType(colValues, header);

    const sampleValues = Array.from(
      new Set(
        colValues
          .filter((v) => v !== null && v !== undefined && v !== "")
          .map((v) => String(v)),
      ),
    ).slice(0, 3);

    const column: InferredColumn = {
      key,
      originalHeader: header,
      label: header.trim() || key,
      type: detected.type,
      required: false,
      config: detected.config,
      options: detected.options,
      sampleValues,
    };

    columns.push(column);
  });

  // Detect relations first so they are not used as numeric operands.
  detectRelations(columns, knownCollections);
  detectFormulas(columns, rows);

  // Group fields into sections on wider spreadsheets.
  let activeSections: { id: string; label: string }[] | undefined;
  if (enableSections && columns.length > 6) {
    activeSections = generateFormSections(columns);
  }

  // Populate fields dictionary
  for (const column of columns) {
    const fieldConfig: IFieldConfig = {
      type: column.type,
      label: column.label,
      required: column.required,
      ...(column.options ? { options: column.options } : {}),
      ...(column.config ? { config: column.config } : {}),
    };

    fields[column.key] = fieldConfig;
    fieldOrder.push(column.key);
  }

  // Suggest pipeline Kanban if a stage/status dropdown exists
  let suggestedPipeline: { field: string; amountField?: string } | undefined;
  const stageCol = columns.find(
    (c) =>
      c.type === "Dropdown" &&
      !c.relation &&
      /estado|etapa|fase|status|stage/.test(c.key.toLowerCase()),
  );
  if (stageCol) {
    const amountCol = columns.find(
      (c) => c.type === "Currency" || c.type === "Number",
    );
    suggestedPipeline = {
      field: stageCol.key,
      ...(amountCol ? { amountField: amountCol.key } : {}),
    };
  }

  // Suggest Lucide icon based on name
  let suggestedIcon: ScreenNavigationIcon = "file-spreadsheet";
  const lowerName = (collectionName + " " + collectionLabel).toLowerCase();
  if (/contrato|incidente|contract|incident/.test(lowerName)) {
    suggestedIcon = "shield";
  } else if (
    /cliente|usuario|persona|contacto|lead|prospecto/.test(lowerName)
  ) {
    suggestedIcon = "users";
  } else if (/vehiculo|auto|coche|moto|flota/.test(lowerName)) {
    suggestedIcon = "car";
  } else if (/pago|recibo|factura|cobro|finanza/.test(lowerName)) {
    suggestedIcon = "banknote";
  } else if (/propiedad|inmueble|casa|hogar/.test(lowerName)) {
    suggestedIcon = "home";
  }

  const suggestedMenuSection: ScreenNavigationSection = "operation";

  const studio: StudioConfig = {
    screen: {
      hidden: false,
      section: suggestedMenuSection,
      icon: suggestedIcon,
      createMode: "drawer-long",
      editMode: "drawer-long",
    },
    columns: columns.length > 5 ? 2 : 1,
    ...(suggestedPipeline ? { pipeline: suggestedPipeline } : {}),
    ...(activeSections && activeSections.length > 0
      ? { sections: activeSections }
      : {}),
  };

  const config: IFormConfig & { studio?: StudioConfig } = {
    version: 2,
    fields,
    fieldOrder,
    studio,
  };

  return {
    collectionName,
    collectionLabel,
    description: `Creado desde ${fileName || "hoja de cálculo"}${
      sheetName ? ` (${sheetName})` : ""
    }`,
    columns,
    config,
    suggestedPipeline,
    suggestedMenuSection,
    suggestedIcon,
  };
}

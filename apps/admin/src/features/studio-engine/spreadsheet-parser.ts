import * as XLSX from "xlsx";
import { parseCsv } from "@savia/studio-shared/csv";

export type ParsedSpreadsheet = {
  fileName: string;
  sheetNames: string[];
  selectedSheet: string;
  headers: string[];
  rows: (string | number | boolean | Date | null)[][];
  totalRowsCount: number;
};

function excelHeaders(row: unknown[], width: number): string[] {
  const values = row.map((cell) => String(cell ?? "").trim());
  const originalNames = new Set(values.filter(Boolean));
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();

  return Array.from({ length: width }, (_, index) => {
    const original = values[index];
    const base = original || `Columna_${index + 1}`;
    let name = base;
    let suffix = nextSuffix.get(base) ?? 2;
    // Reserve original names so an earlier generated label cannot take one.
    while (used.has(name) || (name !== original && originalNames.has(name)))
      name = `${base} (${suffix++})`;
    used.add(name);
    nextSuffix.set(base, suffix);
    return name;
  });
}

/**
 * Parses an Excel (.xlsx, .xls) or CSV File in the browser.
 */
export async function parseSpreadsheetFile(
  file: File,
  targetSheetName?: string,
): Promise<ParsedSpreadsheet> {
  const fileName = file.name;
  const isCsv =
    fileName.toLowerCase().endsWith(".csv") ||
    file.type === "text/csv" ||
    file.type === "application/vnd.ms-excel";

  if (isCsv && !fileName.toLowerCase().endsWith(".xls")) {
    const text = await file.text();
    const { headers, rows } = parseCsv(text, 5000);
    return {
      fileName,
      sheetNames: ["CSV"],
      selectedSheet: "CSV",
      headers,
      rows,
      totalRowsCount: rows.length,
    };
  }

  // Excel (.xlsx, .xls, etc.)
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellNF: true,
  });

  const sheetNames = workbook.SheetNames;
  if (!sheetNames || sheetNames.length === 0) {
    throw new Error("El archivo Excel no contiene ninguna hoja válida.");
  }

  const selectedSheet =
    targetSheetName && sheetNames.includes(targetSheetName)
      ? targetSheetName
      : sheetNames[0];

  const worksheet = workbook.Sheets[selectedSheet];
  if (!worksheet) {
    throw new Error(`No se pudo leer la hoja "${selectedSheet}".`);
  }

  // Excel serial dates describe calendar values without a timezone.
  const dateOptions = { date1904: workbook.Workbook?.WBProps?.date1904 };
  for (const address of Object.keys(worksheet)) {
    if (address.startsWith("!")) continue;
    const cell: XLSX.CellObject = worksheet[address];
    if (
      cell.t !== "n" ||
      typeof cell.v !== "number" ||
      !cell.z ||
      !XLSX.SSF.is_date(cell.z)
    )
      continue;
    const parts = XLSX.SSF.parse_date_code(cell.v, dateOptions);
    if (!parts) continue;
    const date = new Date(
      Date.UTC(
        parts.y,
        parts.m - 1,
        parts.d,
        parts.H,
        parts.M,
        parts.S,
        Math.floor(parts.u * 1000),
      ),
    );
    if (date.getUTCDate() === parts.d) {
      cell.t = "d";
      cell.v = date;
    } else {
      cell.t = "s";
      cell.v = XLSX.SSF.format("yyyy-mm-dd", cell.v, dateOptions);
    }
  }

  const rawGrid = XLSX.utils.sheet_to_json(worksheet, {
    header: 1,
    blankrows: false,
    raw: true,
  }) as unknown[][];

  if (!rawGrid || rawGrid.length === 0) {
    throw new Error(`La hoja "${selectedSheet}" está vacía.`);
  }

  let width = 0;
  const populatedRows: unknown[][] = [];
  for (const row of rawGrid) {
    let end = row.length;
    while (end > 0 && String(row[end - 1] ?? "").trim() === "") end--;
    if (end === 0) continue;
    width = Math.max(width, end);
    populatedRows.push(row);
  }

  const [headerRow, ...dataRows] = populatedRows;
  if (!headerRow)
    throw new Error("No se encontraron encabezados de columna en la hoja.");
  const headers = excelHeaders(headerRow, width);

  const rows = dataRows.map((row) =>
    Array.from({ length: width }, (_, index) => {
      const cell = row[index];
      if (cell == null) return null;
      if (
        cell instanceof Date ||
        typeof cell === "number" ||
        typeof cell === "boolean"
      )
        return cell;
      return String(cell);
    }),
  );

  return {
    fileName,
    sheetNames,
    selectedSheet,
    headers,
    rows,
    totalRowsCount: rows.length,
  };
}

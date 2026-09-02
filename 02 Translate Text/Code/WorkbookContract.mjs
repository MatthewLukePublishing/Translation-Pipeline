export const CONTENT_EXPORT_HEADERS = Object.freeze([
  "ParagraphStyleRange id",
  "ParagraphStyleRange content",
  "Content tag",
  "Content content",
]);

export const EXCEL_ERROR_LITERALS = Object.freeze(new Set([
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#GETTING_DATA",
]));

export function normalizeWorkbookCell(value) {
  return value === null || value === undefined ? "" : String(value).replace(/\r\n/g, "\n");
}

export function firstPopulatedExtraCell(rows) {
  for (let row = 0; row < rows.length; row += 1) {
    const values = rows[row] || [];
    for (let column = CONTENT_EXPORT_HEADERS.length; column < values.length; column += 1) {
      if (String(values[column] ?? "").length > 0) {
        return { row, column, value: values[column] };
      }
    }
  }
  return undefined;
}

function columnIndexFromAddress(address) {
  const match = /^([A-Z]+)\d+$/i.exec(address);
  if (!match) return -1;
  let result = 0;
  for (const letter of match[1].toUpperCase()) result = result * 26 + letter.charCodeAt(0) - 64;
  return result - 1;
}

export function assertLiteralXlsxWorkbook(workbook, filePath, expectedWorksheet = "") {
  if (!workbook || !Array.isArray(workbook.SheetNames) || workbook.SheetNames.length !== 1) {
    throw new Error(`Workbook must contain exactly one worksheet: ${filePath}`);
  }
  const sheetName = expectedWorksheet || workbook.SheetNames[0];
  if (sheetName !== workbook.SheetNames[0] || !workbook.Sheets?.[sheetName]) {
    throw new Error(`Workbook worksheet does not match the expected sheet '${sheetName}': ${filePath}`);
  }

  const worksheet = workbook.Sheets[sheetName];
  for (const [address, cell] of Object.entries(worksheet)) {
    if (address.startsWith("!") || !cell) continue;
    const columnIndex = columnIndexFromAddress(address);
    if (columnIndex < 0) continue;
    if (cell.f !== undefined && cell.f !== null && String(cell.f).length > 0) {
      throw new Error(`Workbook formulas are not allowed (${sheetName}!${address}): ${filePath}`);
    }
    if (cell.t === "e") {
      throw new Error(`Workbook contains a typed Excel error (${sheetName}!${address}): ${filePath}`);
    }
    const value = cell.v === null || cell.v === undefined ? "" : String(cell.v);
    if (EXCEL_ERROR_LITERALS.has(value.trim().toUpperCase())) {
      throw new Error(`Workbook contains the Excel error literal '${value}' (${sheetName}!${address}): ${filePath}`);
    }
    if (value.length > 0 && cell.t !== "s" && cell.t !== "str") {
      throw new Error(`Workbook cells must be literal text (${sheetName}!${address}, type ${cell.t || "unknown"}): ${filePath}`);
    }
    if (columnIndex >= CONTENT_EXPORT_HEADERS.length && value.length > 0) {
      throw new Error(`Workbook contains data outside column D (${sheetName}!${address}): ${filePath}`);
    }
  }
  return { worksheet, sheetName };
}

export function assertContentExportWorkbook(rows, filePath) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error(`Workbook has no data rows: ${filePath}`);
  }
  const headers = CONTENT_EXPORT_HEADERS.map((_, index) => normalizeWorkbookCell(rows[0]?.[index]));
  if (headers.some((header, index) => header !== CONTENT_EXPORT_HEADERS[index])) {
    throw new Error(`Workbook headers do not match the four-column Step 2 contract: ${filePath}`);
  }
  const extra = firstPopulatedExtraCell(rows);
  if (extra) {
    throw new Error(`Workbook contains populated data outside the four-column contract at row ${extra.row + 1}, column ${extra.column + 1}: ${filePath}`);
  }
}

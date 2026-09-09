import textNormalization from "../../Code/TextNormalization.cjs";
import fs from "node:fs";
import crypto from "node:crypto";
import ExcelJS from "exceljs";
import { lineBreaks } from "../../02 Translate Text/Code/LineBreaks.mjs";

const { normalizeCellValue } = textNormalization;

export const PORTUGUESE_COLUMN = 5;

export async function readCaptionWorkbookSnapshot(workbookPath) {
  const bytes = fs.readFileSync(workbookPath);
  const inputWorkbookSha256 = crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  return { workbook, inputWorkbookSha256 };
}

export function assertCaptionLineBreaks(source, translated, id) {
  if (JSON.stringify(lineBreaks(source)) !== JSON.stringify(lineBreaks(translated))) {
    throw new Error(`Line breaks changed for ${id}.`);
  }
}

function captionRowId(rowNumber) {
  return `row_${String(rowNumber).padStart(6, "0")}`;
}

export function readCaptionWorksheetState(worksheet, expectedHeaders) {
  for (let column = 1; column <= expectedHeaders.length; column += 1) {
    const actual = normalizeCellValue(worksheet.getRow(1).getCell(column).value);
    if (actual !== expectedHeaders[column - 1]) {
      throw new Error(
        `Caption workbook header ${column} must be '${expectedHeaders[column - 1]}'; found '${actual}'.`
      );
    }
  }

  const sourceSnapshot = [];
  const pending = [];
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const values = [];
    for (let column = 1; column <= worksheet.columnCount; column += 1) {
      values.push(normalizeCellValue(worksheet.getRow(rowNumber).getCell(column).value));
    }
    sourceSnapshot.push(values);
    if (rowNumber === 1) continue;
    const english = values[1] || "";
    const portuguese = values[PORTUGUESE_COLUMN - 1] || "";
    if (english.trim() && !portuguese.trim()) {
      pending.push({
        id: captionRowId(rowNumber),
        rowNumber,
        image: values[0] || "",
        english,
        spanishReference: values[2] || "",
        frenchReference: values[3] || "",
      });
    }
  }
  return { sourceSnapshot, pending };
}

export function applyPortugueseTranslations(worksheet, pendingRows, translations) {
  if (!(translations instanceof Map)) throw new Error("Caption translations must be a Map keyed by row id.");
  for (const row of pendingRows) {
    if (!translations.has(row.id)) throw new Error(`Missing Portuguese translation for ${row.id}.`);
    const translated = translations.get(row.id);
    if (typeof translated !== "string" || !translated.trim()) {
      throw new Error(`Blank Portuguese translation for ${row.id}.`);
    }
    worksheet.getRow(row.rowNumber).getCell(PORTUGUESE_COLUMN).value = translated;
  }
}

export function assertOnlyPortugueseValuesChanged(worksheet, sourceSnapshot, translations) {
  for (let rowNumber = 1; rowNumber <= sourceSnapshot.length; rowNumber += 1) {
    const originalRow = sourceSnapshot[rowNumber - 1] || [];
    for (let column = 1; column <= originalRow.length; column += 1) {
      const actual = normalizeCellValue(worksheet.getRow(rowNumber).getCell(column).value);
      const rowId = captionRowId(rowNumber);
      const expected = column === PORTUGUESE_COLUMN && rowNumber > 1
        ? (translations.get(rowId) ?? originalRow[column - 1] ?? "")
        : (originalRow[column - 1] ?? "");
      if (actual !== expected) {
        throw new Error(`Caption workbook round trip changed row ${rowNumber}, column ${column}.`);
      }
    }
  }
}

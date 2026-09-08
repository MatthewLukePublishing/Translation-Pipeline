// SheetJS recommends its CommonJS build for Node. It initializes filesystem,
// stream and legacy-encoding support, unlike a bare ESM import of xlsx.mjs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const XLSX = require("xlsx");
export default XLSX;

// Canonicalize the already-authored literal matrix before a shared-string
// serialization. SheetJS double-decodes entities in direct t="str" cells;
// restoring exact authoring values also prevents loss of ICML entity spelling.
export function restoreLiteralCells(worksheet, rows) {
  for (let row = 0; row < rows.length; row++) {
    for (let column = 0; column < rows[row].length; column++) {
      const value = rows[row][column];
      if (typeof value !== "string") throw new Error("Literal workbook matrix must contain strings only.");
      const address = XLSX.utils.encode_cell({ r: row, c: column });
      if (value === "") { delete worksheet[address]; continue; }
      const cell = worksheet[address] || {};
      if (cell.f) throw new Error(`Unexpected formula in literal workbook at ${address}.`);
      cell.t = "s";
      cell.v = value;
      delete cell.w;
      delete cell.h;
      delete cell.r;
      worksheet[address] = cell;
    }
  }
}

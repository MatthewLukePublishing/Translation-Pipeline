"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const XLSX = require("xlsx");
const { LANGUAGES, validatePublication } = require("./PublishedGlossary.cjs");
const { commitFileSetWithJournalSync, recoverFileSetJournalSync } = require("../../../Code/TransactionalFileReplacement.cjs");

const SOURCE_URL = "https://docs.google.com/spreadsheets/d/1BT4y4_qjggRzJ0H8F5h82HACQzkHHvUwnROZIYRuL2M/edit";
const DEFAULT_OUTPUT = path.resolve(__dirname, "../../Published/Translation-Glossaries.json");

function snapshotFromWorkbook(workbook, bytes, exportedAt) {
  if ([...workbook.SheetNames].sort().join() !== "FPST,MFP") throw new Error("Expected exactly the MFP and FPST worksheets.");
  const result = { schemaVersion: 1, source: {
    url: SOURCE_URL, exportedAt, xlsxSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  }, books: {} };
  for (const book of ["MFP", "FPST"]) {
    const sheet = workbook.Sheets[book];
    const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
    if (range.s.r !== 0 || range.s.c !== 0 || range.e.r > 10000 || range.e.c > 30) throw new Error(`Unexpected ${book} sheet dimensions.`);
    for (const [address, cell] of Object.entries(sheet)) {
      if (address.startsWith("!")) continue;
      if (cell.f || cell.t === "e" || (cell.v != null && typeof cell.v !== "string")) {
        throw new Error(`Expected literal text at ${book}!${address}; formulas and errors are not imported.`);
      }
    }
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
    const headers = rows[0].map(value => String(value).trim());
    const expected = book === "MFP"
      ? ["English Acronyms", "English Definitions", ...["Spanish", "French", "German", "Portuguese"].flatMap(l => [`${l} Acronyms`, `${l} Definitions`, `${l} Combined Definitions`])]
      : ["Original English", ...LANGUAGES.flatMap(l => [l, `${l} Definition`])];
    const normalized = book === "MFP" ? headers : headers.map(header => header.replace(/ \([^()]+\)$/, ""));
    if (normalized.slice(0, expected.length).join("\0") !== expected.join("\0") || normalized.slice(expected.length).some(Boolean)) {
      throw new Error(`Unexpected ${book} headers; review the source layout before import.`);
    }
    let kind = "acronyms";
    let wordHeadingSeen = false;
    const entries = [];
    for (let index = 1; index < rows.length; index++) {
      // Only trim cell boundaries; retain punctuation, case and internal spacing.
      const row = rows[index].map(value => String(value).trim());
      if (row.every(value => !value)) continue;
      if (row.slice(expected.length).some(Boolean)) throw new Error(`Extra data in ${book} row ${index + 1}.`);
      if (book === "FPST" && row[0] === "Words") {
        if (wordHeadingSeen || row.slice(0, 9).join("\0") !== ["Words", "Termes", "", "Wörter", "", "Palavras", "", "Términos", ""].join("\0")) {
          throw new Error("Unrecognized or repeated FPST Words section heading.");
        }
        kind = "words"; wordHeadingSeen = true; continue;
      }
      const record = { row: index + 1, kind, english: row[0], translations: {} };
      if (book === "MFP") record.englishDefinition = row[1] || "";
      for (const language of LANGUAGES) {
        const column = expected.indexOf(book === "MFP" ? `${language} Acronyms` : language);
        const target = { term: row[column] || "", definition: row[column + 1] || "" };
        if (book === "MFP") target.combinedDefinition = row[column + 2] || "";
        record.translations[language] = target;
      }
      entries.push(record);
    }
    if (book === "FPST" && (!wordHeadingSeen || !entries.some(entry => entry.kind === "words"))) {
      throw new Error("FPST must contain its Acronyms and Words sections.");
    }
    result.books[book] = { worksheet: book, kind: book === "MFP" ? "acronyms" : "mixed", entries };
  }
  return validatePublication(result);
}

function importSnapshot(inputPath, outputPath = DEFAULT_OUTPUT, exportedAt = new Date().toISOString(), checkOnly = false) {
  const bytes = fs.readFileSync(inputPath);
  if (bytes.length > 10 * 1024 * 1024) throw new Error("Glossary export exceeds 10 MiB.");
  const data = snapshotFromWorkbook(XLSX.read(bytes, { type: "buffer", cellFormula: true, cellText: false }), bytes, exportedAt);
  if (!checkOnly) {
    const target = path.resolve(outputPath);
    if (!target.toLowerCase().endsWith(".json") || target.toLowerCase() === path.resolve(inputPath).toLowerCase()) {
      throw new Error("Snapshot output must be a separate JSON file.");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const journal = `${target}.transaction.json`;
    recoverFileSetJournalSync(journal);
    commitFileSetWithJournalSync(journal, [{ filePath: target, data: `${JSON.stringify(data, null, 2)}\n` }]);
  }
  return data;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const checkOnly = args.includes("--check");
    const positional = args.filter(arg => arg !== "--check");
    if (positional.length < 1 || positional.length > 2 || positional.some(arg => arg.startsWith("--"))) {
      throw new Error("Use Import_Published_Glossaries.cjs <export.xlsx> [output.json] [--check]. Download XLSX through an authorized Google Sheets session first.");
    }
    const snapshot = importSnapshot(positional[0], positional[1], undefined, checkOnly);
    console.log(`PUBLISHED_GLOSSARY_${checkOnly ? "CHECKED" : "IMPORTED"}|MFP=${snapshot.books.MFP.entries.length}|FPST=${snapshot.books.FPST.entries.length}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { SOURCE_URL, snapshotFromWorkbook, importSnapshot };

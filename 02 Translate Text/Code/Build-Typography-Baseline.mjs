// Convert the Publishing typography matrix into an explicit point-size/leading
// JSON baseline. Spreadsheet access uses the bundled artifact-tool.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import atomicFiles from "../../Code/AtomicFiles.cjs";

const { writeJsonAtomicSync } = atomicFiles;

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--input") result.input = argv[++index];
    else if (argv[index] === "--output") result.output = argv[++index];
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.input || !result.output) throw new Error("Use --input <Publishing.xlsx> --output <baseline.json>.");
  return result;
}

function normalize(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function parsePair(raw) {
  const value = normalize(raw);
  const match = value.match(/^\s*([0-9]+(?:\.[0-9]+)?)\s*pt\s*\/\s*([0-9]+(?:\.[0-9]+)?)\s*(?:pt)?(.*)$/i);
  if (!match) return null;
  const alternatives = [...String(match[3] || "").matchAll(/(?:or|,)\s*([0-9]+(?:\.[0-9]+)?)\s*pt/gi)]
    .map((item) => Number(item[1]));
  return {
    fontSizePt: Number(match[1]),
    leadingPt: Number(match[2]),
    ...(alternatives.length ? { leadingAlternativesPt: alternatives } : {}),
  };
}

const cli = parseArgs(process.argv.slice(2));
const inputPath = path.resolve(cli.input);
const outputPath = path.resolve(cli.output);
const artifactNodeModules = process.env.CODEX_ARTIFACT_NODE_MODULES;
if (!artifactNodeModules) throw new Error("CODEX_ARTIFACT_NODE_MODULES was not supplied.");
const requireFromRuntime = createRequire(path.join(artifactNodeModules, "package.json"));
const { FileBlob, SpreadsheetFile } = requireFromRuntime("@oai/artifact-tool");
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheet = workbook.worksheets.getItem("Indd Font Sizes");
const values = sheet.getUsedRange(true).values;
if (values.length < 4 || values[0].length < 24) throw new Error("Typography workbook does not match the expected matrix shape.");

const languageByColumn = new Map();
let currentLanguage = "";
for (let column = 4; column <= 22; column += 1) {
  const candidate = normalize(values[0]?.[column]);
  if (candidate) currentLanguage = candidate;
  if (currentLanguage) languageByColumn.set(column, currentLanguage);
}
const entries = [];
let trimSize = "";
let styleTree1 = "";
let styleTree2 = "";
for (let row = 3; row < values.length; row += 1) {
  trimSize = normalize(values[row]?.[0]) || trimSize;
  styleTree1 = normalize(values[row]?.[1]) || styleTree1;
  styleTree2 = normalize(values[row]?.[2]) || styleTree2;
  const paragraphStyleName = normalize(values[row]?.[3]);
  if (!paragraphStyleName) continue;
  for (let column = 4; column <= 22; column += 1) {
    const raw = normalize(values[row]?.[column]);
    if (!raw) continue;
    const parsed = parsePair(raw);
    if (!parsed) throw new Error(`Could not parse font size / leading at row ${row + 1}, column ${column + 1}: ${raw}`);
    const book = normalize(values[1]?.[column]) || (column === 4 ? "Default" : "");
    if (!book) throw new Error(`Typography entry has no book key at column ${column + 1}.`);
    entries.push({
      trimSize,
      styleTree1,
      styleTree2,
      paragraphStyleName,
      language: languageByColumn.get(column),
      book,
      raw,
      ...parsed,
      sourceCell: `${String.fromCharCode(65 + column)}${row + 1}`,
    });
  }
}

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceWorkbook: inputPath,
  sourceWorkbookSha256: crypto.createHash("sha256").update(fs.readFileSync(inputPath)).digest("hex").toUpperCase(),
  sourceSheet: "Indd Font Sizes",
  notation: {
    separator: "/",
    left: "font size in points",
    right: "leading in points",
  },
  entryCount: entries.length,
  entries,
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
writeJsonAtomicSync(outputPath, result, { trailingNewline: true });
console.log(`TYPOGRAPHY_BASELINE_CREATED|entries=${entries.length}|output=${outputPath}`);

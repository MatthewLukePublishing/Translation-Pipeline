const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");
const { commitFileSetWithJournalSync, recoverFileSetJournalSync } = require("../../../Code/TransactionalFileReplacement.cjs");
const { readJsonFile: readJson } = require("../../../Code/FileUtilities.cjs");
const { resolveGlossaryProgramPath } = require("./GlossaryProgramPath.cjs");
const { editorialPrompt } = require("../../../Code/TranslationEditorialRules.cjs");

const PROGRAM_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAP_PATH = path.join(PROGRAM_ROOT, "01 Translate Glossaries", "book_glossary_map.json");
const EXCEL_ERROR_LITERALS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA"]);

function parseArgs(argv) {
  const args = { check: false, family: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--check") args.check = true;
    else if (token === "--rules") {
      args.rules = String(argv[++index] || "").trim();
      if (!args.rules) throw new Error("--rules requires a target language.");
    }
    else if (token === "--family") {
      args.family = String(argv[++index] || "").trim();
      if (!args.family) throw new Error("--family requires a value.");
    } else {
      throw new Error(`Unknown argument: ${token}`);
    }
  }
  return args;
}

function assertWithinProgram(relativePath, label) {
  return resolveGlossaryProgramPath(PROGRAM_ROOT, relativePath, label);
}

function cellText(value, location) {
  const result = value == null ? "" : String(value);
  if (result !== result.trim()) throw new Error(`${location} contains leading or trailing whitespace.`);
  if (EXCEL_ERROR_LITERALS.has(result.toUpperCase())) throw new Error(`${location} contains Excel error literal '${result}'.`);
  return result;
}

function inspectWorkbook(workbook, workbookPath, expectedSheets) {
  const actualSheets = [...workbook.SheetNames].sort();
  const requiredSheets = [...expectedSheets].sort();
  if (JSON.stringify(actualSheets) !== JSON.stringify(requiredSheets)) {
    throw new Error(`Glossary workbook must contain exactly ${requiredSheets.join(" and ")}: ${workbookPath}`);
  }
  for (const sheetName of workbook.SheetNames) {
    for (const [address, cell] of Object.entries(workbook.Sheets[sheetName])) {
      if (address.startsWith("!") || !cell) continue;
      if (cell.f !== undefined && cell.f !== null && String(cell.f).length) {
        throw new Error(`Glossary formulas are not allowed (${sheetName}!${address}): ${workbookPath}`);
      }
      if (cell.t === "e") throw new Error(`Glossary contains a typed Excel error (${sheetName}!${address}): ${workbookPath}`);
      const value = cell.v == null ? "" : String(cell.v);
      if (value.length && cell.t !== "s" && cell.t !== "str") {
        throw new Error(`Glossary cells must be literal text (${sheetName}!${address}, type ${cell.t || "unknown"}): ${workbookPath}`);
      }
      if (EXCEL_ERROR_LITERALS.has(value.trim().toUpperCase())) {
        throw new Error(`Glossary contains Excel error literal '${value}' (${sheetName}!${address}): ${workbookPath}`);
      }
    }
  }
}

function readSheet(workbook, sheetName, columns) {
  const worksheet = workbook.Sheets[sheetName];
  if (!worksheet) throw new Error(`Missing worksheet "${sheetName}".`);
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });

  const actualHeaders = columns.map((_, index) => cellText(rows[0]?.[index], `${sheetName}!${XLSX.utils.encode_col(index)}1`));
  for (let index = 0; index < columns.length; index += 1) {
    if (actualHeaders[index] !== columns[index]) {
      throw new Error(
        `${sheetName} header ${index + 1} must be "${columns[index]}"; found "${actualHeaders[index]}".`,
      );
    }
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    for (let index = columns.length; index < (rows[rowIndex]?.length || 0); index += 1) {
      if (String(rows[rowIndex][index] ?? "").length) {
        throw new Error(`${sheetName} has unsupported extra data at row ${rowIndex + 1}, column ${index + 1}.`);
      }
    }
  }

  const entries = Object.create(null);
  const seen = new Map();
  for (let rowNumber = 2; rowNumber <= rows.length; rowNumber += 1) {
    const row = rows[rowNumber - 1] || [];
    const values = columns.map((_, index) => cellText(row[index], `${sheetName}!${XLSX.utils.encode_col(index)}${rowNumber}`));
    if (values.every((value) => !value)) continue;
    const english = values[0];
    if (!english) throw new Error(`${sheetName} row ${rowNumber} has data but no English key.`);
    if (["__proto__", "constructor", "prototype"].includes(english)) {
      throw new Error(`${sheetName} row ${rowNumber} uses unsafe English key '${english}'.`);
    }
    if (seen.has(english)) {
      throw new Error(`${sheetName} rows ${seen.get(english)} and ${rowNumber} duplicate "${english}".`);
    }
    seen.set(english, rowNumber);
    entries[english] = Object.fromEntries(columns.slice(1).map((field, index) => [field, values[index + 1]]));
  }
  return entries;
}

function caseFoldCollisions(acronyms, words) {
  const byFolded = new Map();
  for (const source of [...Object.keys(acronyms), ...Object.keys(words)]) {
    const folded = source.normalize("NFC").toLocaleLowerCase("en-US");
    if (!byFolded.has(folded)) byFolded.set(folded, new Set());
    byFolded.get(folded).add(source);
  }
  return [...byFolded.entries()]
    .filter(([, sources]) => sources.size > 1)
    .map(([folded, sources]) => ({ folded, sources: [...sources].sort() }))
    .sort((left, right) => left.folded.localeCompare(right.folded, "en"));
}

function assertAllowedCaseFoldCollisions(map, familyName, collisions) {
  const normalizeGroup = (sources) => [...sources].sort().join("\u0000");
  const allowed = new Set((map.allowedCaseFoldAmbiguities?.[familyName] || []).map(normalizeGroup));
  const actual = new Set(collisions.map((collision) => normalizeGroup(collision.sources)));
  for (const collision of collisions) {
    if (!allowed.has(normalizeGroup(collision.sources))) {
      throw new Error(`${familyName} has an undeclared case-fold ambiguity: ${collision.sources.join(" / ")}.`);
    }
  }
  for (const signature of allowed) {
    if (!actual.has(signature)) throw new Error(`${familyName} declares a stale case-fold ambiguity: ${signature.split("\u0000").join(" / ")}.`);
  }
}

function uniqueFamilies(config) {
  const byFamily = new Map();
  for (const [book, bookConfig] of Object.entries(config.books || {})) {
    if (!bookConfig.family) throw new Error(`Book ${book} has no glossary family.`);
    const signature = JSON.stringify({
      authoringWorkbook: bookConfig.authoringWorkbook,
      runtime: bookConfig.runtime,
    });
    const existing = byFamily.get(bookConfig.family);
    if (existing && existing.signature !== signature) {
      throw new Error(`Book mappings disagree for family ${bookConfig.family}.`);
    }
    byFamily.set(bookConfig.family, { signature, config: bookConfig });
  }
  return byFamily;
}

async function buildFamily(map, familyName, familyConfig, checkOnly) {
  const workbookPath = assertWithinProgram(familyConfig.authoringWorkbook, `${familyName} authoring workbook`);
  if (!fs.existsSync(workbookPath)) throw new Error(`Missing authoring workbook: ${workbookPath}`);
  const journalPath = `${workbookPath}.runtime-transaction.json`;
  if (checkOnly && fs.existsSync(journalPath)) throw new Error("Glossary check is read-only; recover the pending runtime transaction with a normal build first.");
  if (!checkOnly) recoverFileSetJournalSync(journalPath);

  const workbook = XLSX.readFile(workbookPath, { cellFormula: true, cellText: false, cellDates: false });
  inspectWorkbook(workbook, workbookPath, [map.sheets.acronyms, map.sheets.words]);
  const acronyms = readSheet(workbook, map.sheets.acronyms, map.columns);
  const words = readSheet(workbook, map.sheets.words, map.columns);
  const collisions = caseFoldCollisions(acronyms, words);
  assertAllowedCaseFoldCollisions(map, familyName, collisions);
  const outputs = [
    ["acronyms", acronyms],
    ["words", words],
  ];

  const replacements = [];
  for (const [kind, payload] of outputs) {
    const outputPath = assertWithinProgram(familyConfig.runtime[kind], `${familyName} ${kind} runtime`);
    const expected = `${JSON.stringify(payload, null, 2)}\n`;
    if (checkOnly) {
      if (!fs.existsSync(outputPath)) throw new Error(`Missing runtime glossary: ${outputPath}`);
      const actual = fs.readFileSync(outputPath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
      if (actual !== expected) {
        throw new Error(`${familyName} ${kind}.json is stale; rebuild it from Glossary.xlsx.`);
      }
    } else {
      if (path.resolve(outputPath).toLowerCase() === workbookPath.toLowerCase()) throw new Error("Runtime output cannot overwrite the authoring workbook.");
      replacements.push({ filePath: outputPath, data: expected, options: "utf8" });
    }
  }
  if (!checkOnly) commitFileSetWithJournalSync(journalPath, replacements);

  console.log(
    `${checkOnly ? "GLOSSARY_CURRENT" : "GLOSSARY_BUILT"}|family=${familyName}|acronyms=${Object.keys(acronyms).length}|words=${Object.keys(words).length}|caseFoldAmbiguities=${collisions.length}|workbook=${workbookPath}`,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.rules) {
    if (args.check || args.family) throw new Error("Use --rules separately from build/check options.");
    console.log(editorialPrompt(args.rules, "glossary"));
    console.log("Approved glossary entries remain authoritative. This guidance is for new or explicitly requested glossary revisions; the builder does not restyle approved terms.");
    return;
  }
  const map = readJson(MAP_PATH, "book/glossary map");
  if (map.schemaVersion !== 1 || map.glossaryContractVersion !== 2) {
    throw new Error(`Unsupported glossary map version in ${MAP_PATH}.`);
  }
  if (!Array.isArray(map.columns) || map.columns[0] !== "English") {
    throw new Error(`Invalid glossary columns in ${MAP_PATH}.`);
  }

  const families = uniqueFamilies(map);
  if (args.family && !families.has(args.family)) {
    throw new Error(`Unknown glossary family "${args.family}". Choices: ${[...families.keys()].join(", ")}`);
  }
  for (const [familyName, record] of families) {
    if (args.family && args.family !== familyName) continue;
    await buildFamily(map, familyName, record.config, args.check);
  }
}

if (require.main === module) main().catch((error) => {
  console.error(`GLOSSARY_BUILD_FAILED|${error.message}`);
  process.exitCode = 1;
});
module.exports = { buildFamily };

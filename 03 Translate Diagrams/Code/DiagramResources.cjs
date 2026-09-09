"use strict";

const fs = require("node:fs");
const path = require("node:path");
const fg = require("fast-glob");
const XLSX = require("xlsx");

const LANGUAGE_ALIASES = new Map([
  ["brazilian portuguese", "Portuguese"],
  ["portuguese (brazil)", "Portuguese"],
  ["portuguese - brazil", "Portuguese"],
]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalizedKey(value) {
  return clean(value).toLocaleLowerCase("en-US");
}

function namedEntry(object, requested, label) {
  const wanted = normalizedKey(requested);
  const matches = Object.entries(object || {}).filter(([name]) => normalizedKey(name) === wanted);
  if (matches.length !== 1) throw new Error(`${label} not found or ambiguous: ${requested}`);
  return { name: matches[0][0], value: matches[0][1] };
}

function normalizeTargetLanguage(value) {
  const language = clean(value);
  return LANGUAGE_ALIASES.get(normalizedKey(language)) || language;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${filePath} | ${error.message}`, { cause: error });
  }
}

function resolveDefaultProfile(map, bookConfig, targetLanguage) {
  const normalizedLanguage = normalizeTargetLanguage(targetLanguage);
  const configuredDefaults = Object.entries(bookConfig.defaultProfiles || {});
  const defaultMatch = configuredDefaults.find(([language]) => (
    normalizedKey(normalizeTargetLanguage(language)) === normalizedKey(normalizedLanguage)
  ));
  if (defaultMatch) return clean(defaultMatch[1]);

  const profileMatches = Object.entries(map.profiles || {}).filter(([, profile]) => (
    normalizedKey(normalizeTargetLanguage(profile?.language)) === normalizedKey(normalizedLanguage)
  ));
  if (profileMatches.length !== 1) {
    throw new Error(
      `Could not resolve one glossary profile for target language '${targetLanguage}'. ` +
      "Set AI_GLOSSARY_PROFILE explicitly."
    );
  }
  return profileMatches[0][0];
}

function assertExistingFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`Missing ${label}: ${filePath}`);
  }
  return filePath;
}

function resolveDiagramGlossaryResources({
  programRoot,
  book,
  targetLanguage,
  glossaryProfile = "",
  symbolsWorkbookPath = "",
}) {
  const resolvedProgramRoot = path.resolve(clean(programRoot));
  const mapPath = path.join(resolvedProgramRoot, "01 Translate Glossaries", "book_glossary_map.json");
  const map = readJson(mapPath, "book/glossary map");
  const bookEntry = namedEntry(map.books, book, "Book mapping");
  const selectedProfileName = clean(glossaryProfile) || resolveDefaultProfile(map, bookEntry.value, targetLanguage);
  const supportedProfile = (bookEntry.value.supportedProfiles || []).find(
    (name) => normalizedKey(name) === normalizedKey(selectedProfileName)
  );
  if (!supportedProfile) {
    throw new Error(
      `Glossary profile '${selectedProfileName}' is not supported for ${bookEntry.name}. ` +
      `Supported profiles: ${(bookEntry.value.supportedProfiles || []).join(", ")}`
    );
  }
  const profileEntry = namedEntry(map.profiles, supportedProfile, "Glossary profile");
  const normalizedLanguage = normalizeTargetLanguage(targetLanguage);
  if (normalizedKey(normalizeTargetLanguage(profileEntry.value.language)) !== normalizedKey(normalizedLanguage)) {
    throw new Error(
      `Glossary profile '${profileEntry.name}' is for ${profileEntry.value.language}, not ${targetLanguage}.`
    );
  }

  const runtime = bookEntry.value.runtime || {};
  const wordsJson = assertExistingFile(
    path.resolve(resolvedProgramRoot, clean(runtime.words)),
    `${bookEntry.name} word glossary JSON`,
  );
  const acronymsJson = assertExistingFile(
    path.resolve(resolvedProgramRoot, clean(runtime.acronyms)),
    `${bookEntry.name} acronym glossary JSON`,
  );
  const symbolsWorkbook = assertExistingFile(
    symbolsWorkbookPath || path.join(
      resolvedProgramRoot,
      "03 Translate Diagrams",
      "Reference",
      "New Acronyms Symbols.xlsx",
    ),
    "diagram acronym-symbol workbook",
  );

  const runtimePayloads = [
    [wordsJson, "word glossary"],
    [acronymsJson, "acronym glossary"],
  ].map(([filePath, label]) => {
    const payload = readJson(filePath, label);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error(`Invalid ${label} object: ${filePath}`);
    }
    return payload;
  });
  const runtimeEntries = runtimePayloads.flatMap((payload) => Object.values(payload));
  if (!runtimeEntries.length) {
    throw new Error(`The ${bookEntry.name} runtime glossaries contain no entries.`);
  }
  if (!runtimeEntries.some((entry) => (
    entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    Object.prototype.hasOwnProperty.call(entry, clean(profileEntry.value.termKey))
  ))) {
    throw new Error(
      `The ${bookEntry.name} runtime glossaries do not expose profile field '${profileEntry.value.termKey}'.`
    );
  }

  return {
    book: bookEntry.name,
    family: clean(bookEntry.value.family),
    targetLanguage: normalizedLanguage,
    glossaryProfile: profileEntry.name,
    glossaryTermKey: clean(profileEntry.value.termKey),
    glossaryDefinitionKey: clean(profileEntry.value.definitionKey),
    wordsJson,
    acronymsJson,
    symbolsWorkbook,
  };
}

function workbookCellText(cell) {
  if (!cell) return "";
  if (cell.f !== undefined && clean(cell.f)) {
    throw new Error("Diagram acronym-symbol workbook must contain literal values, not formulas.");
  }
  if (cell.t === "e") throw new Error("Diagram acronym-symbol workbook contains an Excel error cell.");
  return cell.v === undefined || cell.v === null ? "" : String(cell.v);
}

function buildAcronymSymbolsRuntime(workbookPath, targetLanguage = "") {
  const workbook = XLSX.readFile(workbookPath, {
    cellFormula: true,
    cellText: false,
    cellDates: false,
  });
  if (workbook.SheetNames.length !== 1) {
    throw new Error(`Diagram acronym-symbol workbook must contain exactly one worksheet: ${workbookPath}`);
  }
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1:A1");
  const valueAt = (row, column) => workbookCellText(
    worksheet[XLSX.utils.encode_cell({ r: row, c: column })]
  );
  if (clean(valueAt(0, 0)) !== "English") {
    throw new Error(`Diagram acronym-symbol workbook must begin with the English column: ${workbookPath}`);
  }

  const languageColumns = [];
  for (let column = 2; column <= range.e.c; column += 2) {
    const language = clean(valueAt(0, column));
    if (!language) throw new Error(`Blank language header in diagram acronym-symbol workbook column ${column + 1}.`);
    languageColumns.push({ column, language });
  }
  if (!languageColumns.length) throw new Error("Diagram acronym-symbol workbook has no target-language columns.");

  const payload = Object.create(null);
  for (let row = 1; row <= range.e.r; row += 1) {
    const english = clean(valueAt(row, 0));
    const englishDefinition = clean(valueAt(row, 1));
    if (!english) {
      const populated = Array.from({ length: range.e.c + 1 }, (_, column) => clean(valueAt(row, column)))
        .some(Boolean);
      if (populated) throw new Error(`Diagram acronym-symbol workbook row ${row + 1} has data without an English key.`);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(payload, english)) {
      throw new Error(`Duplicate English key in diagram acronym-symbol workbook: ${english}`);
    }
    const entry = { "English Definition": englishDefinition };
    for (const { column, language } of languageColumns) {
      entry[language] = clean(valueAt(row, column));
      entry[`${language} Definition`] = clean(valueAt(row, column + 1));
    }
    payload[english] = entry;
  }
  if (!Object.keys(payload).length) throw new Error("Diagram acronym-symbol workbook contains no data rows.");
  const normalizedLanguage = normalizeTargetLanguage(targetLanguage);
  if (normalizedLanguage && !Object.values(payload).some((entry) => (
    Object.prototype.hasOwnProperty.call(entry, normalizedLanguage)
  ))) {
    throw new Error(
      `Diagram acronym-symbol workbook has no '${normalizedLanguage}' target-language column.`
    );
  }
  return payload;
}

async function listAiFiles(dir) {
  const root = path.resolve(clean(dir));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`Diagram input folder does not exist: ${root}`);
  }
  const matches = await fg(["**/*.ai", "!**/*.codex-diagram-*.ai"], {
    cwd: root,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    caseSensitiveMatch: false,
  });
  return [...new Set(matches.map((filePath) => path.resolve(filePath)))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

module.exports = {
  buildAcronymSymbolsRuntime,
  listAiFiles,
  normalizeTargetLanguage,
  resolveDiagramGlossaryResources,
};

const path = require("path");
const { pathToFileURL } = require("url");
const XLSX = require("xlsx");
const AdmZip = require("adm-zip");
const { readJsonFile: readJson } = require("../../../Code/FileUtilities.cjs");
const { resolveGlossaryProgramPath } = require("./GlossaryProgramPath.cjs");

const PROGRAM_ROOT = path.resolve(__dirname, "..", "..", "..");
const MAP_PATH = path.join(PROGRAM_ROOT, "01 Translate Glossaries", "book_glossary_map.json");
const BOOK_RULES_PATH = path.join(PROGRAM_ROOT, "02 Translate Text", "Code", "BookTranslationRules.mjs");
const WORKBOOK_CONTRACT_PATH = path.join(PROGRAM_ROOT, "02 Translate Text", "Code", "WorkbookContract.mjs");
const CONTENT_IDS_PATH = path.join(PROGRAM_ROOT, "02 Translate Text", "Code", "ContentIds.mjs");
const EXCEL_ERROR_LITERALS = new Set(["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A", "#GETTING_DATA"]);

function resolveProgramPath(relativePath, label) {
  return resolveGlossaryProgramPath(PROGRAM_ROOT, relativePath, label, { mustExist: true });
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

async function validateOriginWorkbook(filePath, book, workbookContract, normalizeContentId) {
  const workbook = XLSX.readFile(filePath, { cellFormula: true, cellText: false, cellDates: false });
  const { worksheet } = workbookContract.assertLiteralXlsxWorkbook(workbook, filePath);
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
  workbookContract.assertContentExportWorkbook(rows, filePath);
  const content = new Map();
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const id = normalizeContentId(rows[rowIndex]?.[2]);
    if (!id) throw new Error(`${book} Origin workbook row ${rowIndex + 1} has a blank Content ID.`);
    if (content.has(id)) throw new Error(`${book} Origin workbook has duplicate normalized Content ID '${id}'.`);
    content.set(id, String(rows[rowIndex]?.[3] ?? ""));
  }
  return { rowCount: rows.length - 1, content };
}

function validateOriginArchive(filePath, book, origin, normalizeContentId) {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory && /\.icml$/i.test(entry.entryName));
  if (!entries.length || entries.length > 5000) throw new Error(`${book} Origin archive has an invalid ICML file count: ${entries.length}.`);
  const content = new Map();
  for (const entry of entries) {
    const xml = entry.getData().toString("utf8").replace(/^\uFEFF/, "");
    const pattern = /<Content\b([^>]*\bid\s*=\s*"([^"]+)"[^>]*?)(\/\>|>([\s\S]*?)<\/Content>)/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      const id = normalizeContentId(match[2]);
      if (!id) throw new Error(`${book} Origin archive contains a blank Content ID in ${entry.entryName}.`);
      if (content.has(id)) throw new Error(`${book} Origin archive contains duplicate Content ID '${id}'.`);
      content.set(id, match[3] === "/>" ? "" : match[4]);
    }
  }
  if (content.size !== origin.content.size) {
    throw new Error(`${book} Origin workbook/archive Content count differs: workbook=${origin.content.size}; archive=${content.size}.`);
  }
  for (const [id, workbookText] of origin.content) {
    if (!content.has(id)) throw new Error(`${book} Origin archive is missing workbook Content ID '${id}'.`);
    if (content.get(id) !== workbookText) throw new Error(`${book} Origin workbook/archive text differs for Content ID '${id}'.`);
  }
  return entries.length;
}

function validateRuntime(filePath, columns, family, kind) {
  const payload = readJson(filePath, `${family} ${kind} runtime`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${family} ${kind} runtime must be an English-keyed JSON object.`);
  }
  const required = columns.slice(1);
  const requiredSignature = JSON.stringify([...required].sort());
  for (const [english, entry] of Object.entries(payload)) {
    if (!english.trim()) throw new Error(`${family} ${kind} runtime contains a blank English key.`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${family} ${kind} entry "${english}" must be an object.`);
    }
    const actualSignature = JSON.stringify(Object.keys(entry).sort());
    if (actualSignature !== requiredSignature) {
      throw new Error(`${family} ${kind} entry "${english}" does not use the standard field set.`);
    }
    for (const value of Object.values(entry)) {
      if (typeof value !== "string") throw new Error(`${family} ${kind} entry "${english}" contains a non-string value.`);
      if (value !== value.trim()) throw new Error(`${family} ${kind} entry "${english}" contains leading or trailing whitespace.`);
      if (EXCEL_ERROR_LITERALS.has(value.toUpperCase())) throw new Error(`${family} ${kind} entry "${english}" contains Excel error literal '${value}'.`);
    }
  }
  return payload;
}

function caseFoldCollisions(acronyms, words) {
  const groups = new Map();
  for (const source of [...Object.keys(acronyms), ...Object.keys(words)]) {
    const folded = source.normalize("NFC").toLocaleLowerCase("en-US");
    if (!groups.has(folded)) groups.set(folded, new Set());
    groups.get(folded).add(source);
  }
  return [...groups.values()].filter((sources) => sources.size > 1).map((sources) => [...sources].sort());
}

function validateCaseFoldCollisions(map, familyName, acronyms, words) {
  const signature = (sources) => [...sources].sort().join("\u0000");
  const actual = new Set(caseFoldCollisions(acronyms, words).map(signature));
  const allowed = new Set((map.allowedCaseFoldAmbiguities?.[familyName] || []).map(signature));
  for (const item of actual) if (!allowed.has(item)) throw new Error(`${familyName} has undeclared case-fold ambiguity: ${item.split("\u0000").join(" / ")}.`);
  for (const item of allowed) if (!actual.has(item)) throw new Error(`${familyName} declares stale case-fold ambiguity: ${item.split("\u0000").join(" / ")}.`);
  return actual.size;
}

function profileCoverage(entries, profile) {
  let missingTerms = 0;
  let missingDefinitions = 0;
  for (const entry of entries) {
    if (!text(entry[profile.termKey])) missingTerms += 1;
    if (text(entry["English Definition"]) && !text(entry[profile.definitionKey])) missingDefinitions += 1;
  }
  return { missingTerms, missingDefinitions };
}

function assertGlossaryCompatibility(book, scope, rules, knownSources, knownTableSources, runtimeDefinitionRows) {
  for (const source of rules.glossarySourceTermExclusions) {
    if (!knownSources.has(source.toLocaleLowerCase("en-US"))) {
      throw new Error(`${book} ${scope} excludes unknown glossary source term "${source}".`);
    }
  }
  for (const source of rules.glossaryTableSourceTermExclusions) {
    if (!knownTableSources.has(source.toLocaleLowerCase("en-US"))) {
      throw new Error(`${book} ${scope} excludes unknown glossary table source term "${source}".`);
    }
  }
  const exclusionSet = new Set(rules.glossarySourceTermExclusions.map((source) => source.toLocaleLowerCase("en-US")));
  const tableExclusionSet = new Set(rules.glossaryTableSourceTermExclusions.map((source) => source.toLocaleLowerCase("en-US")));
  for (const row of runtimeDefinitionRows) {
    const protectedDefinition = rules.preserveSourcePatterns.some((rule) => (
      new RegExp(String(rule.pattern || ""), String(rule.flags || "gu")).test(row.definition)
    ));
    if (!protectedDefinition) continue;
    if (!exclusionSet.has(row.definition.toLocaleLowerCase("en-US"))) {
      throw new Error(`${book} ${scope} protects glossary definition "${row.definition}" but does not exclude it from glossary locking.`);
    }
    if (!tableExclusionSet.has(row.sourceTerm.toLocaleLowerCase("en-US"))) {
      throw new Error(`${book} ${scope} protects glossary definition "${row.definition}" but does not exclude table row "${row.sourceTerm}".`);
    }
  }
}

function validateBookInstructions(filePath, book, runtimeSources, runtimeTableSources, runtimeDefinitionRows, ruleTools) {
  const module = readJson(filePath, `${book} book translation instructions`);
  if (Number(module.schemaVersion) !== 2) throw new Error(`${book} book translation instructions must use schemaVersion 2.`);
  if (text(module.moduleId) !== book || text(module.book) !== book) {
    throw new Error(`${book} book translation instruction moduleId and book must both equal "${book}".`);
  }
  const knownSources = new Set(runtimeSources.map((source) => source.toLocaleLowerCase("en-US")));
  const knownTableSources = new Set(runtimeTableSources.map((source) => source.toLocaleLowerCase("en-US")));
  const baseRules = ruleTools.normalizeRuleSet(module.baseRules, `${book} baseRules`, true);
  assertGlossaryCompatibility(book, "baseRules", baseRules, knownSources, knownTableSources, runtimeDefinitionRows);
  if (module.languageExceptions !== undefined && (
    !module.languageExceptions || typeof module.languageExceptions !== "object" || Array.isArray(module.languageExceptions)
  )) {
    throw new Error(`${book} languageExceptions must be an object.`);
  }
  const languageExceptions = Object.entries(module.languageExceptions || {});
  for (const [language, value] of languageExceptions) {
    if (!language.trim()) throw new Error(`${book} has a blank language-exception name.`);
    const exceptionRules = ruleTools.normalizeRuleSet(value, `${book} languageExceptions.${language}`, false);
    assertGlossaryCompatibility(
      book,
      `languageExceptions.${language}`,
      ruleTools.mergeRuleSets(baseRules, exceptionRules),
      knownSources,
      knownTableSources,
      runtimeDefinitionRows,
    );
  }
  return languageExceptions.length;
}

async function main() {
  const [ruleTools, workbookContract, contentIds] = await Promise.all([
    import(pathToFileURL(BOOK_RULES_PATH).href),
    import(pathToFileURL(WORKBOOK_CONTRACT_PATH).href),
    import(pathToFileURL(CONTENT_IDS_PATH).href),
  ]);
  const map = readJson(MAP_PATH, "book/glossary map");
  if (Number(map.schemaVersion) !== 1 || Number(map.glossaryContractVersion) !== 2) {
    throw new Error(`Unsupported glossary contract version in ${MAP_PATH}.`);
  }
  const books = Object.entries(map.books || {});
  const requiredBooks = ["SUT", "SUR", "LRS", "ALRS", "FPST", "MFP"];
  if (JSON.stringify(books.map(([book]) => book).sort()) !== JSON.stringify(requiredBooks.sort())) {
    throw new Error(`The book/glossary map must contain exactly SUT, SUR, LRS, ALRS, FPST, and MFP.`);
  }

  const familyCache = new Map();
  const seenOrigins = new Set();
  for (const [book, config] of books) {
    const workbookPath = resolveProgramPath(config.authoringWorkbook, `${book} authoring workbook`);
    const originWorkbook = resolveProgramPath(config.originWorkbook, `${book} Origin workbook`);
    const originArchive = resolveProgramPath(config.originArchive, `${book} Origin ICML archive`);
    if (!path.basename(originWorkbook).toUpperCase().includes(` ${book}.XLSX`)) {
      throw new Error(`${book} is mapped to an incorrectly named Origin workbook: ${originWorkbook}`);
    }
    if (!path.basename(originArchive).toUpperCase().startsWith(`${book} `)) {
      throw new Error(`${book} is mapped to an incorrectly named Origin archive: ${originArchive}`);
    }
    if (seenOrigins.has(originWorkbook.toLowerCase())) throw new Error(`Origin workbook is mapped more than once: ${originWorkbook}`);
    seenOrigins.add(originWorkbook.toLowerCase());

    const origin = await validateOriginWorkbook(originWorkbook, book, workbookContract, contentIds.normalizeContentId);
    const originIcmlFiles = validateOriginArchive(originArchive, book, origin, contentIds.normalizeContentId);
    const acronymPath = resolveProgramPath(config.runtime.acronyms, `${book} acronym runtime`);
    const wordPath = resolveProgramPath(config.runtime.words, `${book} word runtime`);
    const familyKey = `${config.family}|${workbookPath}|${acronymPath}|${wordPath}`;
    let family = familyCache.get(familyKey);
    if (!family) {
      const acronyms = validateRuntime(acronymPath, map.columns, config.family, "acronyms");
      const words = validateRuntime(wordPath, map.columns, config.family, "words");
      const caseFoldAmbiguities = validateCaseFoldCollisions(map, config.family, acronyms, words);
      family = { acronyms, words, caseFoldAmbiguities };
      familyCache.set(familyKey, family);
    }

    for (const profileName of config.supportedProfiles || []) {
      const profile = map.profiles?.[profileName];
      if (!profile) throw new Error(`${book} references unknown profile "${profileName}".`);
      const entries = [...Object.values(family.acronyms), ...Object.values(family.words)];
      if (!entries.some((entry) => text(entry[profile.termKey]))) {
        throw new Error(`${book} profile "${profileName}" has no populated terms.`);
      }
      const coverage = profileCoverage(entries, profile);
      if (profile.coveragePolicy === "complete" && (coverage.missingTerms || coverage.missingDefinitions)) {
        throw new Error(`${book} profile "${profileName}" is incomplete: missingTerms=${coverage.missingTerms}; missingDefinitions=${coverage.missingDefinitions}.`);
      }
      console.log(`GLOSSARY_PROFILE_COVERAGE|book=${book}|profile=${profileName}|missingTerms=${coverage.missingTerms}|missingDefinitions=${coverage.missingDefinitions}|policy=${profile.coveragePolicy || "partial"}`);
    }
    for (const [language, profileName] of Object.entries(config.defaultProfiles || {})) {
      const profile = map.profiles?.[profileName];
      if (!profile || profile.language !== language || !(config.supportedProfiles || []).includes(profileName)) {
        throw new Error(`${book} has an invalid default ${language} profile "${profileName}".`);
      }
    }

    let bookInstructionLanguageExceptions = 0;
    if (config.translationInstructions) {
      const instructionPath = resolveProgramPath(config.translationInstructions, `${book} book translation instructions`);
      bookInstructionLanguageExceptions = validateBookInstructions(
        instructionPath,
        book,
        [
          ...Object.keys(family.acronyms),
          ...Object.keys(family.words),
          ...Object.values(family.acronyms).map((entry) => text(entry["English Definition"])).filter(Boolean),
          ...Object.values(family.words).map((entry) => text(entry["English Definition"])).filter(Boolean),
        ],
        [...Object.keys(family.acronyms), ...Object.keys(family.words)],
        [...Object.entries(family.acronyms), ...Object.entries(family.words)]
          .map(([sourceTerm, entry]) => ({ sourceTerm, definition: text(entry["English Definition"]) }))
          .filter((row) => row.definition),
        ruleTools,
      );
    }

    console.log(
      `BOOK_GLOSSARY_OK|book=${book}|family=${config.family}|originRows=${origin.rowCount}|originIcmlFiles=${originIcmlFiles}|acronyms=${Object.keys(family.acronyms).length}|words=${Object.keys(family.words).length}|caseFoldAmbiguities=${family.caseFoldAmbiguities}|bookInstructionLanguageExceptions=${bookInstructionLanguageExceptions}`,
    );
  }
  console.log(`GLOSSARY_WORKFLOW_OK|books=${books.length}|families=${familyCache.size}|contract=${map.glossaryContractVersion}`);
}

main().catch((error) => {
  console.error(`GLOSSARY_WORKFLOW_FAILED|${error.message}`);
  process.exitCode = 1;
});

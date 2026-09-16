"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { resolveGlossaryProgramPath } = require("./GlossaryProgramPath.cjs");

const LANGUAGES = ["French", "German", "Portuguese", "Spanish"];
const ERRORS = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)$/i;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function literal(value, label, { blank = true } = {}) {
  if (typeof value !== "string" || value !== value.trim() || ERRORS.test(value) || (!blank && !value)) {
    throw new Error(`Invalid literal text in ${label}.`);
  }
  return value;
}

function validatePublication(data) {
  if (data?.schemaVersion !== 1 || !data.source || !data.books || Array.isArray(data.books)) {
    throw new Error("Unsupported published glossary snapshot.");
  }
  if (!/^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit$/.test(data.source.url) ||
      !/^[a-f0-9]{64}$/.test(data.source.xlsxSha256) || !Number.isFinite(Date.parse(data.source.exportedAt))) {
    throw new Error("Published glossary requires its Google Sheet URL, export date, and XLSX SHA-256.");
  }
  for (const [book, sheet] of Object.entries(data.books)) {
    if (!["MFP", "FPST"].includes(book) || sheet?.worksheet !== book ||
        sheet.kind !== (book === "MFP" ? "acronyms" : "mixed") || !Array.isArray(sheet.entries) ||
        sheet.entries.length < 1 || sheet.entries.length > 10000) {
      throw new Error(`Invalid published glossary book: ${book}.`);
    }
    const seen = new Set();
    const rows = new Set();
    for (const entry of sheet.entries) {
      const source = literal(entry.english, `${book} source`, { blank: false });
      const signature = JSON.stringify([source, entry.translations]);
      if (UNSAFE_KEYS.has(source) || seen.has(signature) || !["acronyms", "words"].includes(entry.kind) ||
          (book === "MFP" && entry.kind !== "acronyms") || !Number.isSafeInteger(entry.row) ||
          entry.row < 2 || rows.has(entry.row)) throw new Error(`Duplicate or unsafe ${book} source row.`);
      seen.add(signature); rows.add(entry.row);
      if (entry.englishDefinition !== undefined) literal(entry.englishDefinition, `${book} English definition`);
      if (!entry.translations || Array.isArray(entry.translations) ||
          Object.keys(entry.translations).sort().join() !== [...LANGUAGES].sort().join()) {
        throw new Error(`Invalid target languages in ${book} row ${entry.row}.`);
      }
      for (const [language, target] of Object.entries(entry.translations)) {
        literal(target?.term, `${book} ${language} term`);
        literal(target?.definition, `${book} ${language} definition`);
        if (target.combinedDefinition !== undefined) literal(target.combinedDefinition, `${book} ${language} combined definition`);
      }
    }
  }
  if (Object.keys(data.books).sort().join() !== "FPST,MFP") throw new Error("Snapshot must contain MFP and FPST.");
  return data;
}

function readPublishedSource(programRoot, config) {
  if (!config?.path || !config.book) throw new Error("publishedSource requires path and book.");
  const filePath = resolveGlossaryProgramPath(programRoot, config.path, "Published glossary snapshot", { mustExist: true });
  const bytes = fs.readFileSync(filePath);
  const data = validatePublication(JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, "")));
  const sheet = data.books[config.book];
  if (!sheet) throw new Error(`Published glossary does not contain book '${config.book}'.`);
  return { data, sheet, filePath, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function applyPublishedGlossary({ acronyms, words, columns, source, config }) {
  const bindings = config.languageFields || Object.fromEntries(LANGUAGES.map(language => [language, language]));
  const fields = new Set(columns.slice(1));
  const usedTargets = new Set();
  for (const [language, field] of Object.entries(bindings)) {
    if (!LANGUAGES.includes(language) || !fields.has(field) || !fields.has(`${field} Definition`) || usedTargets.has(field)) {
      throw new Error(`Invalid published glossary language binding: ${language}.`);
    }
    usedTargets.add(field);
  }
  if (!usedTargets.size) throw new Error("Published glossary has no language bindings.");
  const contextual = {
    schemaVersion: 1, book: config.book,
    source: { ...source.data.source, snapshotSha256: source.sha256 }, profiles: {},
  };
  const groups = new Map();
  const allBaseKeys = [...Object.keys(acronyms), ...Object.keys(words)];
  for (const record of source.sheet.entries) {
    // Retain an existing unique case-only source spelling. Never conflate two
    // distinct spellings when the base glossary already distinguishes them.
    const folded = record.english.normalize("NFC").toLocaleLowerCase("en-US");
    const matches = allBaseKeys.filter(key => key.normalize("NFC").toLocaleLowerCase("en-US") === folded);
    const key = allBaseKeys.includes(record.english) ? record.english : matches.length === 1 ? matches[0] : record.english;
    if (!allBaseKeys.includes(record.english) && matches.length > 1) throw new Error(`Ambiguous base glossary spelling: ${record.english}.`);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  for (const [key, records] of groups) {
    const record = records[0];
    const hasAcronym = Object.hasOwn(acronyms, key);
    const hasWord = Object.hasOwn(words, key);
    if (hasAcronym && hasWord) throw new Error(`Published glossary source occurs in both base sheets: ${key}.`);
    if (records.some(item => item.kind !== record.kind) || (hasAcronym && record.kind !== "acronyms") || (hasWord && record.kind !== "words")) {
      throw new Error(`Conflicting acronym/word classification: ${key}.`);
    }
    const destination = record.kind === "acronyms" ? acronyms : words;
    const entry = destination[key] ||= Object.fromEntries(columns.slice(1).map(field => [field, ""]));
    if (records.length === 1 && record.englishDefinition && fields.has("English Definition")) entry["English Definition"] = record.englishDefinition;
    for (const [language, field] of Object.entries(bindings)) {
      if (records.length > 1) {
        // The same source has multiple senses (e.g. camera viewpoint vs device).
        // Neither last-row-wins nor an unconditional glossary lock is safe.
        entry[field] = "";
        entry[`${field} Definition`] = "";
        (contextual.profiles[field] ||= []).push({ source: key, alternatives: records.map(item => ({
          target: item.translations[language].term, definition: item.translations[language].definition,
          sourceRow: item.row,
        })) });
        continue;
      }
      const target = record.translations[language];
      // Blanks are missing recommendations, not deletion instructions. Combined
      // bilingual display definitions are retained in the snapshot, never prose locks.
      if (target.term) entry[field] = target.term;
      if (target.definition) entry[`${field} Definition`] = target.definition;
    }
  }
  return { acronyms, words, contextual };
}

function readContextualGlossary(filePath, field) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  if (payload?.schemaVersion !== 1 || !payload.profiles || !/^[a-f0-9]{64}$/.test(payload.source?.snapshotSha256)) {
    throw new Error("Invalid contextual glossary provenance.");
  }
  const entries = payload.profiles[field] || [];
  if (!Array.isArray(entries) || entries.length > 10000) throw new Error("Invalid contextual glossary entries.");
  for (const entry of entries) {
    literal(entry.source, "contextual source", { blank: false });
    if (!Array.isArray(entry.alternatives) || entry.alternatives.length < 2) throw new Error("Contextual glossary requires multiple senses.");
    for (const choice of entry.alternatives) {
      literal(choice.target, "contextual target"); literal(choice.definition, "contextual definition");
    }
  }
  return entries;
}

module.exports = { LANGUAGES, literal, validatePublication, readPublishedSource, applyPublishedGlossary, readContextualGlossary };

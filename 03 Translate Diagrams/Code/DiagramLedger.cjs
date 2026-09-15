"use strict";

/**
 * DiagramLedger.cjs
 *
 * Reads and guards a diagram text ledger, so Stage 3 can translate from the
 * recorded text instead of exporting it from Illustrator again.
 *
 * The ledger is authoritative for source text. A diagram may only be processed
 * when its bytes still match the ledger, so a revised or already translated
 * diagram stops the run instead of being silently rewritten.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomicSync } = require("../../Code/AtomicFiles.cjs");

const LEDGER_SCHEMA_VERSION = "diagram-text-ledger-2";
const TRANSLATABLE_KINDS = new Set(["prose", "sourceCode"]);

class DiagramLedgerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DiagramLedgerError";
    this.details = details;
  }
}

function normalizeFileName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_\s]+/g, " ")
    .trim();
}

function hashFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function defaultLedgerPath(programRoot, book) {
  return path.join(programRoot, "03 Translate Diagrams", "Ledgers", `${String(book).toUpperCase()}-Diagram-Text-Ledger.json`);
}

function loadLedger(filePath, { book = "" } = {}) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new DiagramLedgerError(`Diagram ledger does not exist: ${resolved}`, { filePath: resolved });
  }
  const bytes = fs.readFileSync(resolved);
  let payload;
  try {
    payload = JSON.parse(bytes.toString("utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new DiagramLedgerError(`Could not read diagram ledger: ${resolved} | ${error.message}`, { filePath: resolved });
  }
  if (payload.schemaVersion !== LEDGER_SCHEMA_VERSION) {
    throw new DiagramLedgerError(
      `Unsupported diagram ledger schema: ${payload.schemaVersion}; expected ${LEDGER_SCHEMA_VERSION}.`,
      { filePath: resolved },
    );
  }
  if (book && String(payload.book).toLowerCase() !== String(book).toLowerCase()) {
    throw new DiagramLedgerError(
      `Diagram ledger ${resolved} is for ${payload.book}, not ${book}.`,
      { filePath: resolved },
    );
  }
  if (!Array.isArray(payload.diagrams) || !payload.diagrams.length) {
    throw new DiagramLedgerError(`Diagram ledger has no diagrams: ${resolved}`, { filePath: resolved });
  }

  const seenIds = new Set();
  for (const diagram of payload.diagrams) {
    if (!diagram.file || typeof diagram.sha256 !== "string" || diagram.sha256.length !== 64) {
      throw new DiagramLedgerError(`Diagram ledger entry is missing its file name or hash: ${diagram.file || "(unnamed)"}`, { filePath: resolved });
    }
    if (!Array.isArray(diagram.textUnits)) {
      throw new DiagramLedgerError(`Diagram ledger entry has no textUnits array: ${diagram.file}`, { filePath: resolved });
    }
    for (const unit of diagram.textUnits) {
      if (!unit.id || !String(unit.plain ?? "").length) {
        throw new DiagramLedgerError(`Diagram ledger unit is missing an id or text: ${diagram.file}`, { filePath: resolved });
      }
      if (seenIds.has(unit.id)) {
        throw new DiagramLedgerError(`Diagram ledger repeats unit id ${unit.id}.`, { filePath: resolved });
      }
      seenIds.add(unit.id);
      if (!TRANSLATABLE_KINDS.has(unit.kind)) {
        throw new DiagramLedgerError(
          `Diagram ledger unit ${unit.id} has unsupported kind '${unit.kind}' (font ${unit.font || "unknown"}). ` +
          "Classify the font and regenerate the ledger before translating this diagram.",
          { filePath: resolved, unitId: unit.id },
        );
      }
    }
  }

  return {
    filePath: resolved,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    book: payload.book,
    sourceLanguage: payload.sourceLanguage,
    diagrams: payload.diagrams,
    source: payload,
  };
}

function indexByHash(ledger) {
  const index = new Map();
  for (const diagram of ledger.diagrams) {
    const bucket = index.get(diagram.sha256) || [];
    bucket.push(diagram);
    index.set(diagram.sha256, bucket);
  }
  return index;
}

function matchDiagram(ledger, filePath, index = indexByHash(ledger)) {
  const target = path.resolve(filePath);
  const sha256 = hashFile(target);
  const candidates = index.get(sha256) || [];
  if (!candidates.length) {
    throw new DiagramLedgerError(
      `No diagram ledger entry matches ${path.basename(target)}. ` +
      "The diagram was revised, already translated, or belongs to another edition; " +
      "start from the recorded source copy or regenerate the ledger.",
      { filePath: target, sha256 },
    );
  }
  if (candidates.length === 1) {
    return { entry: candidates[0], sha256, matchedBy: "sha256" };
  }
  const wanted = normalizeFileName(path.basename(target));
  const named = candidates.filter((entry) => normalizeFileName(entry.file) === wanted);
  if (named.length === 1) {
    return { entry: named[0], sha256, matchedBy: "sha256+name" };
  }
  throw new DiagramLedgerError(
    `${candidates.length} diagram ledger entries share the hash of ${path.basename(target)} and the name does not disambiguate them.`,
    { filePath: target, sha256 },
  );
}

function unitsForWorker(entry) {
  return entry.textUnits.map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    font: unit.font || "",
    plain: unit.plain,
  }));
}

function validateMatchReport(entry, payload) {
  const runs = Array.isArray(payload?.runs) ? payload.runs : [];
  const sourceCodeRuns = Array.isArray(payload?.sourceCodeRuns) ? payload.sourceCodeRuns : [];
  const expected = entry.textUnits;
  const expectedProse = expected.filter((unit) => unit.kind === "prose");
  const expectedCode = expected.filter((unit) => unit.kind === "sourceCode");

  if (runs.length !== expectedProse.length || sourceCodeRuns.length !== expectedCode.length) {
    throw new DiagramLedgerError(
      `${entry.file}: Illustrator matched ${runs.length} prose and ${sourceCodeRuns.length} code text items ` +
      `but the ledger records ${expectedProse.length} and ${expectedCode.length}.`,
      { file: entry.file },
    );
  }

  runs.forEach((run, index) => {
    const unit = expectedProse[index];
    if (String(run.id) !== String(unit.id)) {
      throw new DiagramLedgerError(
        `${entry.file}: Illustrator matched text out of ledger order at unit ${unit.id} (found ${run.id}).`,
        { file: entry.file, unitId: unit.id },
      );
    }
    if (String(run.originalText ?? "").trim() !== String(unit.plain ?? "").trim()) {
      throw new DiagramLedgerError(
        `${entry.file}: unit ${unit.id} no longer matches the ledger text.`,
        { file: entry.file, unitId: unit.id },
      );
    }
  });

  sourceCodeRuns.forEach((run, index) => {
    const unit = expectedCode[index];
    if (String(run.id) !== String(unit.id)) {
      throw new DiagramLedgerError(
        `${entry.file}: Illustrator matched code text out of ledger order at unit ${unit.id} (found ${run.id}).`,
        { file: entry.file, unitId: unit.id },
      );
    }
    if (String(run.text ?? "").trim() !== String(unit.plain ?? "").trim()) {
      throw new DiagramLedgerError(
        `${entry.file}: code unit ${unit.id} no longer matches the ledger text.`,
        { file: entry.file, unitId: unit.id },
      );
    }
  });

  return { proseCount: runs.length, sourceCodeCount: sourceCodeRuns.length };
}

function translationsForLanguage(entry, language) {
  const wanted = String(language);
  const byId = new Map();
  for (const unit of entry.textUnits) {
    const value = unit.translations?.[wanted];
    if (typeof value === "string" && value.length) byId.set(String(unit.id), value);
  }
  return byId;
}

function pendingUnits(entry, language) {
  const known = translationsForLanguage(entry, language);
  return entry.textUnits.filter((unit) => unit.kind === "prose" && !known.has(String(unit.id)));
}

function recordTranslations(entry, language, translations) {
  const wanted = String(language);
  const byId = new Map();
  for (const item of translations || []) {
    if (item && item.id !== undefined && typeof item.translated === "string" && item.translated.length) {
      byId.set(String(item.id), item.translated);
    }
  }
  let recorded = 0;
  for (const unit of entry.textUnits) {
    const value = byId.get(String(unit.id));
    if (value === undefined) continue;
    if (!unit.translations || typeof unit.translations !== "object") unit.translations = {};
    if (unit.translations[wanted] !== value) {
      unit.translations[wanted] = value;
      recorded += 1;
    }
  }
  return recorded;
}

function serializeLedger(source) {
  const head = { ...source };
  delete head.diagrams;
  head.generatedUtc = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  head.diagramCount = source.diagrams.length;
  head.textUnitCount = source.diagrams.reduce((total, diagram) => total + diagram.textUnits.length, 0);

  const lines = ["{"];
  for (const [key, value] of Object.entries(head)) {
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "diagrams": [');
  source.diagrams.forEach((diagram, diagramIndex) => {
    const meta = { ...diagram };
    delete meta.textUnits;
    lines.push("    {");
    for (const [key, value] of Object.entries(meta)) {
      lines.push(`      ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
    }
    lines.push('      "textUnits": [');
    diagram.textUnits.forEach((unit, unitIndex) => {
      const comma = unitIndex < diagram.textUnits.length - 1 ? "," : "";
      lines.push(`        ${JSON.stringify(unit)}${comma}`);
    });
    lines.push("      ]");
    lines.push(`    }${diagramIndex < source.diagrams.length - 1 ? "," : ""}`);
  });
  lines.push("  ]");
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function writeLedger(ledger, source, { language = "" } = {}) {
  const current = crypto.createHash("sha256").update(fs.readFileSync(ledger.filePath)).digest("hex");
  if (current !== ledger.sha256) {
    throw new DiagramLedgerError(
      `Diagram ledger changed during this run; refusing to overwrite it: ${ledger.filePath}`,
      { filePath: ledger.filePath },
    );
  }
  const text = serializeLedger(source);
  writeFileAtomicSync(ledger.filePath, text);
  ledger.sha256 = crypto.createHash("sha256").update(fs.readFileSync(ledger.filePath)).digest("hex");
  return { filePath: ledger.filePath, language, bytes: Buffer.byteLength(text) };
}

module.exports = {
  DiagramLedgerError,
  LEDGER_SCHEMA_VERSION,
  defaultLedgerPath,
  hashFile,
  indexByHash,
  loadLedger,
  matchDiagram,
  normalizeFileName,
  pendingUnits,
  recordTranslations,
  serializeLedger,
  translationsForLanguage,
  unitsForWorker,
  validateMatchReport,
  writeLedger,
};

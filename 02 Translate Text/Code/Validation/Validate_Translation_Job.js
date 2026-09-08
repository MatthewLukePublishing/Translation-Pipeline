import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "node:url";
import XLSX from "../../../Code/SheetJsNode.mjs";
import fileUtilities from "../../../Code/FileUtilities.cjs";
import textNormalization from "../../../Code/TextNormalization.cjs";
import editorialRules from "../../../Code/TranslationEditorialRules.cjs";
import transactionalFiles from "../../../Code/TransactionalFileReplacement.cjs";
import { fnv1a32Utf16 } from "../ContentFingerprint.mjs";
import { normalizeContentId } from "../ContentIds.mjs";
import { buildContentGroups, compositeFromRows } from "../ContentGroups.mjs";
import {
  configuredPattern,
  countExactOccurrences,
  loadBookTranslationInstructionSnapshot,
} from "../BookTranslationRules.mjs";
import { containsGlossaryTarget } from "../GlossaryPatterns.mjs";
import { renderGlossaryTableRow } from "../GlossaryTable.mjs";
import { compileGlossaryEntries, resolveGlossaryEntriesForText } from "../GlossaryResolution.mjs";
import { isStrictlyInside, pathsEqual } from "../PathSafety.mjs";
import { loadProtectedSourceManifest } from "../ProtectedSourceManifest.mjs";
import { CONTENT_EXPORT_HEADERS, assertLiteralXlsxWorkbook, firstPopulatedExtraCell } from "../WorkbookContract.mjs";
import { createIssueCollector } from "./IssueCollector.mjs";
import {loadPanelManagedContent} from '../PanelManagedReferences.mjs';

const { readJsonFileRequired: readJson } = fileUtilities;
const { normalizeCellValue } = textNormalization;
const { commitFileSetWithJournalSync, recoverFileSetJournalSync } = transactionalFiles;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(SCRIPT_DIR, "..", "..");
const ACTIVE_JOB_CONFIG_PATH = path.join(WORKFLOW_DIR, "Active Job.json");
const MAX_REPORTED_ISSUES = 2000;
const MAX_TEXT_REPORT_DETAILS = 250;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--job") throw new Error(`Unknown argument: ${argv[i]}`);
    const value = argv[++i];
    if (!value) throw new Error("Missing value for --job");
    out.job = value;
  }
  return out;
}

async function readWorkbook(filePath) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing workbook: ${filePath}`);
  const workbook = XLSX.readFile(filePath, { cellFormula: true, cellText: false, cellDates: false });
  const { worksheet, sheetName } = assertLiteralXlsxWorkbook(workbook, filePath);
  const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
  const extra = firstPopulatedExtraCell(rawRows);
  if (extra) {
    throw new Error(
      `Workbook contains populated data outside the four-column contract at row ${extra.row + 1}, column ${extra.column + 1}: ${filePath}`
    );
  }
  const data = rawRows.map((rawRow) => {
    const row = Array.from({ length: Math.max(4, rawRow.length) }, (_, columnIndex) =>
      normalizeCellValue(rawRow[columnIndex])
    );
    return row.slice(0, 4);
  });

  return { workbook, worksheet, data };
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function importPayloadFingerprint(rows) {
  return fnv1a32Utf16(importPayloadText(rows));
}

function importPayloadText(rows) {
  return rows.slice(1)
    .map((row) => `${String(row[2] || "")}\u001F${String(row[3] || "")}\u001E`)
    .join("");
}

function importPayloadSha256(rows) {
  return crypto.createHash("sha256").update(importPayloadText(rows), "utf8").digest("hex").toUpperCase();
}

function readProtectedSourceIds(jobPath, config) {
  const configuredPath = String(config.protectedSourceContentManifest || "").trim();
  if (!configuredPath) return new Set();
  return loadProtectedSourceManifest(jobPath, configuredPath, readJson).contentIds;
}

function readBookTranslationInstructions(jobPath, config) {
  const configured = config.bookTranslationInstructions;
  if (!configured) {
    return {
      applied: false,
      moduleId: "",
      sha256: "",
      languageException: "",
      glossarySourceTermExclusions: [],
      glossaryTableSourceTermExclusions: [],
      preserveSourcePatterns: [],
      forbiddenTargetPatterns: [],
    };
  }
  const { actualSha256, resolved } = loadBookTranslationInstructionSnapshot({
    jobPath,
    configured,
    config,
    readJson,
    sha256File: sha256,
  });
  return {
    applied: true,
    moduleId: resolved.moduleId,
    sha256: actualSha256,
    languageException: resolved.languageException,
    ...resolved.rules,
  };
}

function maskBookProtectedSourcePhrases(value, bookInstructions) {
  let masked = String(value || "");
  if (!bookInstructions.applied) return masked;
  for (const rule of bookInstructions.preserveSourcePatterns) {
    masked = masked.replace(configuredPattern(rule), (match) => " ".repeat(match.length));
  }
  return masked;
}

function applicableGlossaryChecks(text, checks) {
  return resolveGlossaryEntriesForText(text, checks).map(({ entry }) => entry);
}

function extractProcessingInstructions(text) {
  return String(text || "").match(/<\?[\s\S]*?\?>/g) || [];
}

function extractMarkupTags(text) {
  return String(text || "").match(/<\/?[A-Za-z][^>]*>/g) || [];
}

function extractLineBreaks(text) {
  return String(text || "").match(/\r\n|[\r\n\u2028\u2029]/g) || [];
}

function boundaryWhitespace(text) {
  const value = String(text || "");
  return {
    leading: value.match(/^[ \t\r\n]*/)?.[0] || "",
    trailing: value.match(/[ \t\r\n]*$/)?.[0] || "",
  };
}

function visibleLetters(text) {
  return String(text || "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<Br\b[^>]*\/>/gi, " ")
    .replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/g, " ")
    .replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
}

function validateHeaders(rows, label, addIssue) {
  if (rows.length < 2) {
    addIssue("error", "WORKBOOK_EMPTY", `${label} must contain a header and at least one data row.`);
    return;
  }
  for (let c = 0; c < CONTENT_EXPORT_HEADERS.length; c++) {
    if (String(rows[0]?.[c] ?? "").trim() !== CONTENT_EXPORT_HEADERS[c]) {
      addIssue(
        "error",
        "HEADER_CHANGED",
        `${label} header ${c + 1} must be "${CONTENT_EXPORT_HEADERS[c]}"; found "${rows[0]?.[c] ?? ""}".`,
        { row: 1, column: c + 1 }
      );
    }
  }
}

function collectGlossaryChecks(payload, kind, termKey, definitionKey) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const checks = [];
  for (const [source, rawEntry] of Object.entries(payload)) {
    if (!source || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const definitionSource = String(
      rawEntry["English Definition"] ?? rawEntry[""] ?? rawEntry.English ?? rawEntry.english ?? ""
    ).trim();
    const definitionTarget = String(rawEntry[definitionKey] ?? "").trim();
    const termTarget = String(
      rawEntry[termKey] ?? rawEntry[termKey.toLowerCase()] ?? rawEntry.translation ?? rawEntry.target ?? ""
    ).trim();
    const target = termTarget || (kind === "acronym" ? definitionTarget : "");
    if (target) checks.push({ source, target, kind, type: "term" });

    if (kind === "acronym") {
      if (definitionSource && definitionTarget) {
        checks.push({
          source: definitionSource,
          target: definitionTarget,
          kind: "definition",
          sourceTerm: source,
          type: "phrase",
        });
      }
    }
  }
  return checks;
}

function collectGlossaryTableChecks(payload, termKey, definitionKey, exclusions = new Set()) {
  const checks = new Map();
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return checks;
  for (const [sourceTerm, rawEntry] of Object.entries(payload)) {
    if (exclusions.has(sourceTerm.toLocaleLowerCase("en-US"))) continue;
    if (!sourceTerm || !rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const sourceDefinition = String(rawEntry["English Definition"] ?? "").trim();
    const targetTerm = String(rawEntry[termKey] ?? "").trim();
    const targetDefinition = String(rawEntry[definitionKey] ?? "").trim();
    if (!sourceDefinition || (!targetTerm && !targetDefinition)) continue;
    checks.set(`${sourceTerm}\u0000${sourceDefinition}`, { targetTerm, targetDefinition });
  }
  return checks;
}

function makeTextReport(report) {
  const lines = [
    "TRANSLATION JOB QA REPORT",
    "=========================",
    "",
    `Job: ${report.jobId}`,
    `Book: ${report.book}`,
    `Target language: ${report.targetLanguage}`,
    `Glossary profile: ${report.glossaryProfile}`,
    `Status: ${report.status.toUpperCase()}`,
    `Errors: ${report.summary.errors}`,
    `Warnings: ${report.summary.warnings}`,
    `Rows checked: ${report.summary.rowsChecked}`,
    `Content IDs checked: ${report.summary.contentIdsChecked}`,
    `Glossary checks applied: ${report.summary.glossaryChecksApplied}`,
    `Book-instruction checks applied: ${report.summary.bookInstructionChecksApplied}`,
    "",
    "DETAILS",
    "-------",
  ];

  if (!report.issues.length) {
    lines.push("None");
  } else {
    for (const issue of report.issues.slice(0, MAX_TEXT_REPORT_DETAILS)) {
      const location = [
        issue.row ? `row ${issue.row}` : "",
        issue.column ? `column ${issue.column}` : "",
        issue.contentId ? `ID ${issue.contentId}` : "",
      ].filter(Boolean).join(", ");
      lines.push(`[${issue.severity.toUpperCase()}] ${issue.code}${location ? ` (${location})` : ""}: ${issue.message}`);
    }
    if (report.issues.length > MAX_TEXT_REPORT_DETAILS) {
      lines.push(`Additional issues omitted from text report: ${report.issues.length - MAX_TEXT_REPORT_DETAILS}`);
    }
  }

  lines.push("", `JSON report: ${report.paths.jsonReport}`, `Input: ${report.paths.inputWorkbook}`, `Output: ${report.paths.outputWorkbook}`, "");
  return lines.join("\n");
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  let jobPath = String(cli.job || process.env.TRANSLATION_JOB_DIR || "").trim();
  if (!jobPath) {
    const active = readJson(ACTIVE_JOB_CONFIG_PATH, "active-job configuration");
    jobPath = String(active.jobPath || "").trim();
  }
  if (!jobPath) throw new Error("No translation job selected.");
  jobPath = path.resolve(jobPath);

  const configPath = path.join(jobPath, "job_config.json");
  const manifestPath = path.join(jobPath, "job_manifest.json");
  const qaTransactionJournal = path.join(jobPath, "state", "qa_transaction.json");
  const qaRecovery = recoverFileSetJournalSync(qaTransactionJournal);
  if (qaRecovery.recovered) console.log(`QA_TRANSACTION_RECOVERED|phase=${qaRecovery.phase}`);
  const config = readJson(configPath, "job configuration");
  const manifest = readJson(manifestPath, "job manifest");
  if (!pathsEqual(String(config.jobPath || jobPath), jobPath)) {
    throw new Error(`Job configuration path mismatch: ${configPath}`);
  }
  if (String(config.jobId || "") !== String(manifest.jobId || "")) {
    throw new Error(`Job configuration and manifest IDs disagree: ${manifestPath}`);
  }
  const manifestStatusBeforeQa = String(manifest.status || "");
  let importStillCurrent = manifestStatusBeforeQa === "imported";
  if (!["translated", "ready_for_import", "qa_failed", "imported"].includes(manifestStatusBeforeQa)) {
    throw new Error(
      `Job manifest status must be translated, ready_for_import, qa_failed, or imported before QA; found "${manifest.status || "(blank)"}".`
    );
  }

  const inputPath = path.join(jobPath, "input", "content_export.xlsx");
  const outputPath = path.join(jobPath, "output", "content_import.xlsx");
  const reportsDir = path.join(jobPath, "reports");
  const jsonReportPath = path.join(reportsDir, "qa_report.json");
  const textReportPath = path.join(reportsDir, "qa_report.txt");
  const acronymPath = path.join(jobPath, "glossary", "acronyms.json");
  const wordsPath = path.join(jobPath, "glossary", "words.json");
  fs.mkdirSync(reportsDir, { recursive: true });

  if (manifestStatusBeforeQa === "imported") {
    const expectedImportedWorkbookHash = String(
      manifest.import?.workbookSha256 || manifest.qa?.hashes?.outputWorkbookSha256 || ""
    ).toUpperCase();
    const actualImportedWorkbookHash = sha256(outputPath);
    if (!expectedImportedWorkbookHash || actualImportedWorkbookHash !== expectedImportedWorkbookHash) {
      importStillCurrent = false;
    }
  }

  const source = await readWorkbook(inputPath);
  const output = await readWorkbook(outputPath);
  if (manifestStatusBeforeQa === "imported") {
    const expectedImportedPayload = String(
      manifest.import?.payloadSha256 || manifest.qa?.hashes?.importPayloadSha256 || ""
    ).toUpperCase();
    const actualImportedPayload = importPayloadSha256(output.data);
    if (expectedImportedPayload && actualImportedPayload !== expectedImportedPayload) {
      importStillCurrent = false;
    }
  }
  const protectedSourceIds = readProtectedSourceIds(jobPath, config);
  const panelManaged = loadPanelManagedContent(config, manifest);
  const bookInstructions = readBookTranslationInstructions(jobPath, config);
  const excludedGlossarySources = new Set(
    bookInstructions.glossarySourceTermExclusions.map((sourceTerm) => sourceTerm.toLocaleLowerCase("en-US"))
  );
  const excludedGlossaryTableSources = new Set(
    [...bookInstructions.glossarySourceTermExclusions, ...bookInstructions.glossaryTableSourceTermExclusions]
      .map((sourceTerm) => sourceTerm.toLocaleLowerCase("en-US"))
  );
  let protectedContentIdsChecked = 0;
  let bookInstructionChecksApplied = 0;
  let translationEligibleSegments = 0;
  let unchangedTranslationSegments = 0;
  const issueCollector = createIssueCollector(MAX_REPORTED_ISSUES);
  const { issues, addIssue } = issueCollector;

  validateHeaders(source.data, "Input workbook", addIssue);
  validateHeaders(output.data, "Output workbook", addIssue);

  if (source.data.length !== output.data.length) {
    addIssue(
      "error",
      "ROW_COUNT_CHANGED",
      `Row count changed from ${source.data.length} to ${output.data.length}.`
    );
  }

  const rowsToCheck = Math.min(source.data.length, output.data.length);
  const seenIds = new Map();
  for (let r = 1; r < rowsToCheck; r++) {
    const sourceRow = source.data[r] || [];
    const outputRow = output.data[r] || [];
    const contentId = String(sourceRow[2] ?? "").trim();
    const normalizedContentId = normalizeContentId(contentId);

    if (!contentId) {
      addIssue("error", "MISSING_CONTENT_ID", "Input row has no Content tag ID.", { row: r + 1, column: 3 });
    } else if (seenIds.has(normalizedContentId)) {
      addIssue(
        "error",
        "DUPLICATE_CONTENT_ID",
        `Content tag ID duplicates row ${seenIds.get(normalizedContentId)}.`,
        { row: r + 1, column: 3, contentId }
      );
    } else {
      seenIds.set(normalizedContentId, r + 1);
    }

    for (const c of [0, 2]) {
      if (String(sourceRow[c] ?? "") !== String(outputRow[c] ?? "")) {
        addIssue(
          "error",
          "PROTECTED_FIELD_CHANGED",
          `Protected value changed from "${sourceRow[c] ?? ""}" to "${outputRow[c] ?? ""}".`,
          { row: r + 1, column: c + 1, contentId }
        );
      }
    }

    const sourceSegment = String(sourceRow[3] ?? "");
    const outputSegment = String(outputRow[3] ?? "");
    const protectedSource = protectedSourceIds.has(normalizedContentId);
    const panelReference = panelManaged.has(normalizedContentId);
    if (panelReference && outputSegment !== panelManaged.get(normalizedContentId)) {
      addIssue("error", "PANEL_REFERENCE_CACHE_CHANGED", "Generated cross-reference text may change only through the InDesign panel encoder.", {row:r+1,column:4,contentId});
    }
    if (protectedSource) {
      protectedContentIdsChecked++;
      if (sourceSegment !== outputSegment) {
        addIssue("error", "PROTECTED_SOURCE_TEXT_CHANGED", "Source-language-only content must remain verbatim.", {
          row: r + 1,
          column: 4,
          contentId,
        });
      }
    }
    if (sourceSegment.trim() && !outputSegment.trim()) {
      addIssue("error", "BLANK_TRANSLATION", "Nonblank source segment has a blank translation.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }

    const sourcePis = extractProcessingInstructions(sourceSegment);
    const outputPis = extractProcessingInstructions(outputSegment);
    if (JSON.stringify(sourcePis) !== JSON.stringify(outputPis)) {
      addIssue("error", "PROCESSING_INSTRUCTION_CHANGED", "Processing instructions were added, removed, reordered, or changed.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }
    if (JSON.stringify(extractMarkupTags(sourceSegment)) !== JSON.stringify(extractMarkupTags(outputSegment))) {
      addIssue("error", "MARKUP_CHANGED", "Markup elements were added, removed, reordered, or changed.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }
    if (JSON.stringify(extractLineBreaks(sourceSegment)) !== JSON.stringify(extractLineBreaks(outputSegment))) {
      addIssue("error", "LINE_BREAK_CHANGED", "Line breaks were added, removed, reordered, or changed.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }
    if (JSON.stringify(boundaryWhitespace(sourceSegment)) !== JSON.stringify(boundaryWhitespace(outputSegment))) {
      addIssue("error", "BOUNDARY_WHITESPACE_CHANGED", "Leading or trailing whitespace changed.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }
    if (/&amp;(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/i.test(outputSegment)) {
      addIssue("error", "DOUBLE_ESCAPED_ENTITY", "The translation contains a double-escaped XML entity.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }

    const languageCheckSource = maskBookProtectedSourcePhrases(sourceSegment, bookInstructions);
    const translationEligible = !protectedSource && !panelReference && visibleLetters(languageCheckSource).length >= 4;
    if (translationEligible) translationEligibleSegments++;
    if (translationEligible && sourceSegment.trim() === outputSegment.trim()) {
      unchangedTranslationSegments++;
      addIssue("warning", "UNCHANGED_SOURCE_TEXT", "Source and translated segment are identical.", {
        row: r + 1,
        column: 4,
        contentId,
      });
    }

    if (!protectedSource && !panelReference && bookInstructions.applied) {
      for (const rule of bookInstructions.forbiddenTargetPatterns) {
        bookInstructionChecksApplied++;
        const match = configuredPattern(rule).exec(outputSegment);
        if (match) {
          addIssue(
            "error",
            "BOOK_INSTRUCTION_FORBIDDEN_TARGET",
            rule.message || `Book rule '${rule.id}' forbids target text "${match[0]}".`,
            { row: r + 1, column: 4, contentId, ruleId: rule.id, match: match[0] }
          );
        }
      }
      for (const rule of bookInstructions.preserveSourcePatterns) {
        const matches = [...sourceSegment.matchAll(configuredPattern(rule))].map((match) => match[0]);
        for (const phrase of new Set(matches)) {
          bookInstructionChecksApplied++;
          const expected = matches.filter((candidate) => candidate === phrase).length;
          const actual = countExactOccurrences(outputSegment, phrase);
          if (actual !== expected) {
            addIssue(
              "error",
              "BOOK_SOURCE_NAME_CHANGED",
              `Book rule '${rule.id}' requires exactly ${expected} occurrence(s) of "${phrase}"; found ${actual}.`,
              { row: r + 1, column: 4, contentId, ruleId: rule.id, sourcePhrase: phrase, expected, actual }
            );
          }
        }
      }
    }
  }

  const unchangedRatio = translationEligibleSegments
    ? unchangedTranslationSegments / translationEligibleSegments
    : 0;
  if (unchangedTranslationSegments >= 10 && unchangedRatio >= 0.2) {
    addIssue(
      "error",
      "TRANSLATION_COVERAGE_LOW",
      `${unchangedTranslationSegments} of ${translationEligibleSegments} translatable segments ` +
      `(${(unchangedRatio * 100).toFixed(1)}%) are unchanged from the source language.`
    );
  }

  if (manifest.workbook && Number(manifest.workbook.dataRowCount) !== Math.max(0, source.data.length - 1)) {
    addIssue(
      "error",
      "EXPORT_ROW_COUNT_MISMATCH",
      `Input workbook has ${Math.max(0, source.data.length - 1)} data rows; export manifest expects ${manifest.workbook.dataRowCount}.`
    );
  }
  if (manifest.workbook && Number(manifest.workbook.contentIdCount) !== seenIds.size) {
    addIssue(
      "error",
      "EXPORT_CONTENT_ID_COUNT_MISMATCH",
      `Input workbook has ${seenIds.size} unique Content IDs; export manifest expects ${manifest.workbook.contentIdCount}.`
    );
  }

  for (const group of buildContentGroups(source.data.slice(0, rowsToCheck))) {
    const combined = compositeFromRows(output.data, group);
    if (String(output.data[group.startRow]?.[1] ?? "") !== combined) {
      addIssue("error", "COMPOSITE_MISMATCH", "Translated ParagraphStyleRange content does not equal its translated Content segments.", {
        row: group.startRow + 1,
        column: 2,
        contentId: String(source.data[group.startRow]?.[2] ?? ""),
      });
    }
  }

  const termKey = String(config.glossaryTermKey || config.targetLanguage || "").trim();
  const definitionKey = String(config.glossaryDefinitionKey || `${termKey} Definition`).trim();
  const glossaryChecks = [];
  const glossaryTableChecks = new Map();
  if (fs.existsSync(acronymPath)) {
    const acronymPayload = readJson(acronymPath, "acronym glossary");
    glossaryChecks.push(...collectGlossaryChecks(acronymPayload, "acronym", termKey, definitionKey));
    for (const [key, value] of collectGlossaryTableChecks(acronymPayload, termKey, definitionKey, excludedGlossaryTableSources)) glossaryTableChecks.set(key, value);
  }
  if (fs.existsSync(wordsPath)) {
    const wordsPayload = readJson(wordsPath, "word glossary");
    glossaryChecks.push(...collectGlossaryChecks(wordsPayload, "word", termKey, definitionKey));
    for (const [key, value] of collectGlossaryTableChecks(wordsPayload, termKey, definitionKey, excludedGlossaryTableSources)) glossaryTableChecks.set(key, value);
  }
  glossaryChecks.sort((left, right) => right.source.length - left.source.length);
  const effectiveGlossaryChecks = compileGlossaryEntries(
    glossaryChecks.filter((check) => !excludedGlossarySources.has(check.source.toLocaleLowerCase("en-US")))
  );

  const editorialPolicy = editorialRules.resolveEditorialRules(config.targetLanguage, "text");
  if (config.editorialRules && config.editorialRules.sha256 !== editorialPolicy.sha256) {
    addIssue("error", "EDITORIAL_POLICY_CHANGED", "The editorial policy changed after this review was prepared; prepare a new review before import.");
  }
  if (config.editorialRules && manifest.subscriptionTranslation?.editorialRules?.sha256 !== editorialPolicy.sha256) {
    addIssue("error", "EDITORIAL_REVIEW_INCOMPLETE", "The output has no completed translation review under the current editorial policy.");
  }
  for (let r = 1; r < rowsToCheck; r++) {
    const contentId = String(source.data[r]?.[2] ?? "");
    if (protectedSourceIds.has(normalizeContentId(contentId)) || panelManaged.has(normalizeContentId(contentId))) continue;
    const sourceText = String(source.data[r]?.[3] ?? "");
    const protectedStrings = [
      ...bookInstructions.preserveSourcePatterns.flatMap(rule => [...sourceText.matchAll(configuredPattern(rule))].map(match => match[0])),
      ...effectiveGlossaryChecks.map(check => check.target),
    ].filter(Boolean);
    for (const issue of editorialRules.auditEditorialText(output.data[r]?.[3], config.targetLanguage, { protectedStrings, languageRules: editorialPolicy.language })) {
      addIssue(issue.severity, issue.code, issue.message, { row: r + 1, column: 4, contentId });
    }
  }

  let glossaryChecksApplied = 0;
  for (let r = 1; r < rowsToCheck; r++) {
    const sourceSegment = String(source.data[r]?.[3] ?? "");
    const outputSegment = String(output.data[r]?.[3] ?? "");
    const contentId = String(source.data[r]?.[2] ?? "");
    if (protectedSourceIds.has(normalizeContentId(contentId)) || panelManaged.has(normalizeContentId(contentId))) continue;
    const tab = sourceSegment.indexOf("\t");
    if (tab >= 0 && sourceSegment.indexOf("\t", tab + 1) < 0) {
      const tableKey = `${sourceSegment.slice(0, tab).trim()}\u0000${sourceSegment.slice(tab + 1).trim()}`;
      const tableRecommendation = glossaryTableChecks.get(tableKey);
      if (tableRecommendation !== undefined) {
        const expectedTableRow = renderGlossaryTableRow(sourceSegment, tableRecommendation);
        glossaryChecksApplied += 2;
        if (outputSegment !== expectedTableRow) {
          addIssue(
            "error",
            "GLOSSARY_TABLE_ROW_MISMATCH",
            `Expected exact glossary table row "${expectedTableRow}".`,
            { row: r + 1, column: 4, contentId }
          );
        }
        continue;
      }
    }
    const glossaryEligibleSource = maskBookProtectedSourcePhrases(sourceSegment, bookInstructions);
    for (const check of applicableGlossaryChecks(glossaryEligibleSource, effectiveGlossaryChecks)) {
      glossaryChecksApplied++;
      const targetPresent = containsGlossaryTarget(outputSegment, check, config.targetLanguage);
      if (!targetPresent) {
        addIssue(
          "error",
          "GLOSSARY_TARGET_MISSING",
          `Expected glossary ${check.kind} "${check.target}" for source "${check.source}".`,
          { row: r + 1, column: 4, contentId }
        );
      }
    }
  }

  const { errors, warnings, omitted: omittedIssueDetails } = issueCollector.counts;
  const status = errors ? "failed" : "passed";
  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    jobId: String(config.jobId || path.basename(jobPath)),
    book: String(config.book || ""),
    targetLanguage: String(config.targetLanguage || ""),
    glossaryProfile: String(config.glossaryProfile || ""),
    status,
    editorialRules: { version: editorialPolicy.version, sha256: editorialPolicy.sha256, language: editorialPolicy.language.language },
    summary: {
      errors,
      warnings,
      rowsChecked: Math.max(0, rowsToCheck - 1),
      contentIdsChecked: seenIds.size,
      protectedContentIdsChecked,
      glossaryChecksApplied,
      bookInstructionChecksApplied,
      translationEligibleSegments,
      unchangedTranslationSegments,
      unchangedTranslationPercent: Number((unchangedRatio * 100).toFixed(2)),
      omittedIssueDetails,
    },
    paths: {
      job: jobPath,
      inputWorkbook: inputPath,
      outputWorkbook: outputPath,
      jsonReport: jsonReportPath,
      textReport: textReportPath,
    },
    hashes: {
      inputWorkbookSha256: sha256(inputPath),
      outputWorkbookSha256: sha256(outputPath),
      importPayloadFNV1A32UTF16: importPayloadFingerprint(output.data),
      importPayloadSha256: importPayloadSha256(output.data),
      acronymGlossarySha256: fs.existsSync(acronymPath) ? sha256(acronymPath) : "",
      wordsGlossarySha256: fs.existsSync(wordsPath) ? sha256(wordsPath) : "",
      bookTranslationInstructionsSha256: bookInstructions.sha256,
    },
    issues,
    bookTranslationInstructions: {
      applied: bookInstructions.applied,
      moduleId: bookInstructions.moduleId,
      languageException: bookInstructions.languageException,
      excludedGlossarySourceTerms: bookInstructions.glossarySourceTermExclusions,
      excludedGlossaryTableSourceTerms: bookInstructions.glossaryTableSourceTermExclusions,
    },
  };

  if (manifestStatusBeforeQa === "imported" && !importStillCurrent) {
    // Retain only the most recent superseded evidence, not an unbounded history.
    // Publication is atomic with QA below, so a changed workbook cannot inherit
    // imported/finalized status, even when its new text passes all checks.
    manifest.invalidatedImport = {
      invalidatedAt: report.generatedAt,
      reason: "Workbook bytes or payload changed; re-import and finalization required.",
      import: manifest.import || null,
      layoutFinalization: manifest.layoutFinalization || null,
    };
    delete manifest.import;
    delete manifest.layoutFinalization;
  }
  manifest.status = status !== "passed" ? "qa_failed"
    : (importStillCurrent ? "imported" : "ready_for_import");
  manifest.updatedAt = new Date().toISOString();
  manifest.qa = {
    status,
    editorialRules: report.editorialRules,
    completedAt: report.generatedAt,
    summary: report.summary,
    hashes: report.hashes,
    jsonReport: jsonReportPath,
    textReport: textReportPath,
  };
  const transaction = commitFileSetWithJournalSync(qaTransactionJournal, [
    { filePath: jsonReportPath, data: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8") },
    { filePath: textReportPath, data: Buffer.from(`${makeTextReport(report)}\n`, "utf8") },
    { filePath: manifestPath, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
  ]);

  console.log(`QA ${status.toUpperCase()}: ${errors} error(s), ${warnings} warning(s)`);
  console.log(`Report: ${textReportPath}`);
  console.log(`QA_TRANSACTION_OK|id=${transaction.transactionId}|files=${transaction.filesCommitted}`);
  if (errors) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

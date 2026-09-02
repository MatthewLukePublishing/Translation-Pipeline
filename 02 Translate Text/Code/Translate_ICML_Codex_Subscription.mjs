// Translate a standard Step 2 XLSX job through the ChatGPT-authenticated Codex CLI.
// This provider never loads or passes an OpenAI API key.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import XLSX from "xlsx";
import atomicFiles from "../../Code/AtomicFiles.cjs";
import fileUtilities from "../../Code/FileUtilities.cjs";
import transactionalFiles from "../../Code/TransactionalFileReplacement.cjs";
import {
  configuredPattern,
  countExactOccurrences,
  loadBookTranslationInstructionSnapshot,
} from "./BookTranslationRules.mjs";
import { normalizeContentId } from "./ContentIds.mjs";
import { buildContentGroups } from "./ContentGroups.mjs";
import { glossaryPattern } from "./GlossaryPatterns.mjs";
import { applyLanguagePostprocessors } from "./LanguagePostprocessors.mjs";
import {
  compileGlossaryEntries,
  glossaryEntryApplies,
  resolveGlossaryEntriesForText,
} from "./GlossaryResolution.mjs";
import { resolveLatestSubscriptionModel } from "./Resolve-LatestSubscriptionModel.mjs";
import { isStrictlyInside, pathsEqual } from "./PathSafety.mjs";
import { loadProtectedSourceManifest } from "./ProtectedSourceManifest.mjs";
import {
  assertContentExportWorkbook,
  assertLiteralXlsxWorkbook,
  normalizeWorkbookCell as normalizeCell,
} from "./WorkbookContract.mjs";

const { writeJsonAtomicSync } = atomicFiles;
const { readJsonFileRequired: readJson } = fileUtilities;
const { commitFileSetWithJournalSync, recoverFileSetJournalSync } = transactionalFiles;

const COL_B = 1;
const COL_D = 3;
const DEFAULT_BATCH_MAX_CHARS = 24000;
const DEFAULT_BATCH_MAX_GROUPS = 100;
const DEFAULT_BATCH_MAX_SEGMENTS = 300;
const DEFAULT_QUERY_TIMEOUT_MS = 60 * 60 * 1000;
let restoredBookSourceLocks = 0;
let standardizedGlossaryTableRows = 0;

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--job") result.job = argv[++i];
    else if (key === "--max-batches") result.maxBatches = Number(argv[++i]);
    else if (key === "--check") result.check = true;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!result.job) throw new Error("Use --job <translation-job-folder>.");
  if (result.maxBatches !== undefined && (!Number.isInteger(result.maxBatches) || result.maxBatches < 1)) {
    throw new Error("--max-batches must be a positive integer.");
  }
  return result;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomicSync(filePath, value, { trailingNewline: true });
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function sha256Json(value) {
  return sha256Buffer(Buffer.from(JSON.stringify(value), "utf8"));
}

function positiveIntegerSetting(value, fallback, label, minimum = 1) {
  const resolved = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}; received ${value}.`);
  }
  return resolved;
}

function sanitizeXmlText(value, location) {
  const source = normalizeCell(value);
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    const invalidControl = code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code);
    if (invalidControl || code === 0xfffe || code === 0xffff) {
      throw new Error(`Invalid XML character U+${code.toString(16).toUpperCase().padStart(4, "0")} in ${location}.`);
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = source.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
      } else {
        throw new Error(`Unpaired high surrogate in ${location}.`);
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`Unpaired low surrogate in ${location}.`);
    }
  }
  return source;
}

function matchingInventory(value, pattern) {
  return String(value ?? "").match(pattern) || [];
}

function assertSegmentStructure(source, translated, location) {
  const invariants = [
    ["processing instructions", /<\?[\s\S]*?\?>/g],
    ["markup tags", /<\/?[A-Za-z][^>]*>/g],
    ["line breaks", /\r\n|\r|\n/g],
  ];
  for (const [label, pattern] of invariants) {
    const before = matchingInventory(source, pattern);
    const after = matchingInventory(translated, pattern);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`${label} changed in ${location}.`);
    }
  }
  const leadingSource = String(source ?? "").match(/^[ \t\r\n]*/)?.[0] || "";
  const trailingSource = String(source ?? "").match(/[ \t\r\n]*$/)?.[0] || "";
  const leadingTarget = String(translated ?? "").match(/^[ \t\r\n]*/)?.[0] || "";
  const trailingTarget = String(translated ?? "").match(/[ \t\r\n]*$/)?.[0] || "";
  if (leadingSource !== leadingTarget || trailingSource !== trailingTarget) {
    throw new Error(`Leading or trailing whitespace changed in ${location}.`);
  }
}

function assertWorkbook(values, filePath) {
  assertContentExportWorkbook(values, filePath);
  const ids = new Set();
  for (let row = 1; row < values.length; row += 1) {
    const id = normalizeContentId(values[row]?.[2]);
    if (!id) throw new Error(`Workbook row ${row + 1} has a blank Content tag.`);
    if (ids.has(id)) throw new Error(`Duplicate Content tag '${id}' at workbook row ${row + 1}.`);
    ids.add(id);
  }
  return { rowCount: values.length, contentIdCount: ids.size };
}

function buildGroups(values) {
  return buildContentGroups(values);
}

function readProtectedSourceManifest(jobDir, config) {
  const configuredPath = String(config.protectedSourceContentManifest || "").trim();
  if (!configuredPath) return { contentIds: new Set(), contentIdCount: 0, sourceSetSha256: "", selectors: [] };
  const { contentIds, manifest } = loadProtectedSourceManifest(jobDir, configuredPath, readJson);
  return {
    contentIds,
    contentIdCount: contentIds.size,
    sourceSetSha256: String(manifest.sourceSetSha256 || ""),
    selectors: Array.isArray(manifest.selectors) ? manifest.selectors : [],
  };
}

function readBookTranslationInstructions(jobDir, config) {
  const configured = config.bookTranslationInstructions;
  if (!configured) {
    return {
      applied: false,
      moduleId: "",
      sha256: "",
      languageException: "",
      promptInstructions: [],
      preferredExamples: [],
      glossarySourceTermExclusions: [],
      glossaryTableSourceTermExclusions: [],
      preserveSourcePatterns: [],
      forbiddenTargetPatterns: [],
    };
  }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) {
    throw new Error("bookTranslationInstructions must be an object.");
  }
  const { actualSha256, resolved } = loadBookTranslationInstructionSnapshot({
    jobPath: jobDir,
    configured,
    config,
    readJson,
    sha256File,
  });
  return {
    applied: true,
    moduleId: resolved.moduleId,
    sha256: actualSha256,
    targetLanguage: String(config.targetLanguage || ""),
    languageException: resolved.languageException,
    ...resolved.rules,
  };
}

function violatesBookInstructions(source, target, instructions) {
  if (!instructions.applied) return false;
  if (instructions.forbiddenTargetPatterns.some((rule) => configuredPattern(rule).test(target))) return true;
  for (const rule of instructions.preserveSourcePatterns) {
    const matches = [...String(source || "").matchAll(configuredPattern(rule))].map((match) => match[0]);
    for (const phrase of new Set(matches)) {
      const expected = matches.filter((candidate) => candidate === phrase).length;
      if (countExactOccurrences(target, phrase) < expected) return true;
    }
  }
  return false;
}

function assertBookInstructionOutput(sourceValues, outputValues, protectedIds, instructions) {
  if (!instructions.applied) return;
  for (let row = 1; row < sourceValues.length; row += 1) {
    if (protectedIds.has(normalizeContentId(sourceValues[row]?.[2]))) continue;
    const source = normalizeCell(sourceValues[row]?.[COL_D]);
    const target = normalizeCell(outputValues[row]?.[COL_D]);
    for (const rule of instructions.forbiddenTargetPatterns) {
      const match = configuredPattern(rule).exec(target);
      if (match) throw new Error(`Book instruction '${rule.id}' failed at workbook row ${row + 1}: ${rule.message || `forbidden target '${match[0]}'`}`);
    }
    for (const rule of instructions.preserveSourcePatterns) {
      const matches = [...source.matchAll(configuredPattern(rule))].map((match) => match[0]);
      for (const phrase of new Set(matches)) {
        const expected = matches.filter((candidate) => candidate === phrase).length;
        if (countExactOccurrences(target, phrase) < expected) {
          throw new Error(`Book instruction '${rule.id}' failed at workbook row ${row + 1}: preserve '${phrase}' exactly.`);
        }
      }
    }
  }
}

function partitionProtectedGroups(groups, sourceValues, protectedIds) {
  if (!protectedIds.size) return { translatable: groups, protectedGroups: [], protectedSegments: 0 };
  const translatable = [];
  const protectedGroups = [];
  let protectedSegments = 0;
  for (const group of groups) {
    const flags = group.allRowIndexes.map((rowIndex) => protectedIds.has(normalizeContentId(sourceValues[rowIndex]?.[2])));
    const protectedRows = flags.filter(Boolean).length;
    if (protectedRows && protectedRows !== flags.length) {
      throw new Error(`Protected source boundary splits ${group.groupId}; move the configured boundary to a ParagraphStyleRange boundary.`);
    }
    if (protectedRows) {
      protectedGroups.push({ groupId: group.groupId, segments: [...group.sourceSegments] });
      protectedSegments += group.sourceSegments.length;
    } else {
      translatable.push(group);
    }
  }
  return { translatable, protectedGroups, protectedSegments };
}

function normalizeGlossaryPayload(payload, termKey, definitionKey) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const entries = [];
  for (const [source, raw] of Object.entries(payload)) {
    if (!source.trim() || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const preferredTerm = normalizeCell(raw[termKey]).trim();
    const definition = normalizeCell(raw[definitionKey]).trim();
    const target = preferredTerm || definition;
    if (!target) continue;
    entries.push({ source, target, definition, targetWasDefinition: !preferredTerm, kind: "term" });
    const englishDefinition = normalizeCell(raw["English Definition"]).trim();
    if (englishDefinition && definition) {
      entries.push({
        source: englishDefinition,
        target: definition,
        definition,
        targetWasDefinition: true,
        kind: "definition",
      });
    }
  }
  entries.sort((left, right) => right.source.length - left.source.length);
  return entries;
}

function readGlossary(jobDir, config, termKey = undefined, definitionKey = undefined, exclusions = []) {
  const rows = [];
  for (const name of ["words.json", "acronyms.json"]) {
    const filePath = path.join(jobDir, "glossary", name);
    if (!fs.existsSync(filePath)) continue;
    rows.push(...normalizeGlossaryPayload(
      readJson(filePath, `${name} glossary snapshot`),
      String(termKey || config.glossaryTermKey || config.targetLanguage || ""),
      String(definitionKey || config.glossaryDefinitionKey || `${config.targetLanguage || ""} Definition`),
    ));
  }
  const seen = new Set();
  const excluded = new Set(exclusions.map((source) => source.toLocaleLowerCase("en-US")));
  return compileGlossaryEntries(rows.filter((entry) => {
    const exclusionKey = entry.source.toLocaleLowerCase("en-US");
    const exactKey = `${entry.source}\u0000${entry.target}`;
    if (excluded.has(exclusionKey)) return false;
    if (seen.has(exactKey)) return false;
    seen.add(exactKey);
    return true;
  }));
}

function readGlossaryTableMap(jobDir, config, exclusions = []) {
  const rows = new Map();
  const excluded = new Set(exclusions.map((source) => source.toLocaleLowerCase("en-US")));
  for (const name of ["words.json", "acronyms.json"]) {
    const filePath = path.join(jobDir, "glossary", name);
    if (!fs.existsSync(filePath)) continue;
    const payload = readJson(filePath, `${name} glossary snapshot`);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    for (const [sourceTerm, raw] of Object.entries(payload)) {
      if (excluded.has(sourceTerm.toLocaleLowerCase("en-US"))) continue;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const englishDefinition = normalizeCell(raw["English Definition"]).trim();
      const targetTerm = normalizeCell(raw[config.glossaryTermKey]).trim();
      const targetDefinition = normalizeCell(raw[config.glossaryDefinitionKey]).trim();
      if (!sourceTerm.trim() || !englishDefinition || (!targetTerm && !targetDefinition)) continue;
      rows.set(`${sourceTerm}\u0000${englishDefinition}`, { targetTerm, targetDefinition });
    }
  }
  return rows;
}

function applyGlossaryTableContract(sourceValues, outputValues, glossaryTableMap) {
  for (let row = 1; row < sourceValues.length; row += 1) {
    const sourceSegment = normalizeCell(sourceValues[row]?.[COL_D]);
    const tab = sourceSegment.indexOf("\t");
    if (tab < 0 || sourceSegment.indexOf("\t", tab + 1) >= 0) continue;
    const sourceTerm = sourceSegment.slice(0, tab).trim();
    const englishDefinition = sourceSegment.slice(tab + 1).trim();
    const selected = glossaryTableMap.get(`${sourceTerm}\u0000${englishDefinition}`);
    if (!selected) continue;
    outputValues[row][COL_D] = `${selected.targetTerm}\t${selected.targetDefinition}`;
    standardizedGlossaryTableRows += 1;
  }
}

function textContainsGlossarySource(text, source) {
  const pattern = glossaryPattern(source);
  pattern.lastIndex = 0;
  return pattern.test(text);
}

function assertBaselineWorkbook(sourceValues, baselineValues, baselinePath) {
  assertWorkbook(baselineValues, baselinePath);
  if (baselineValues.length !== sourceValues.length) {
    throw new Error(`Baseline workbook row count differs from the source workbook: ${baselinePath}`);
  }
  for (let row = 0; row < sourceValues.length; row += 1) {
    if (baselineValues[row][0] !== sourceValues[row][0] || baselineValues[row][2] !== sourceValues[row][2]) {
      throw new Error(`Baseline workbook protected identifiers differ at row ${row + 1}: ${baselinePath}`);
    }
  }
}

function baselineSegmentsForGroup(group, baselineValues) {
  return group.rowIndexes.map((rowIndex) => normalizeCell(baselineValues[rowIndex]?.[COL_D]));
}

function selectGroupsForBaselineMode(groups, glossary, previousGlossary, baselineValues, mode, bookInstructions) {
  let candidateEntries;
  if (mode === "definition_contract_upgrade") {
    candidateEntries = glossary.filter((entry) => entry.kind === "definition");
  } else if (mode === "profile_delta") {
    const priorTargets = new Map(previousGlossary.map((entry) => [entry.source.toLocaleLowerCase("en-US"), entry.target]));
    candidateEntries = glossary.filter((entry) => (
      priorTargets.get(entry.source.toLocaleLowerCase("en-US")) !== entry.target
    ));
  } else {
    throw new Error(`Unsupported baseline translation mode '${mode}'.`);
  }

  const selected = [];
  const reused = [];
  let bookInstructionCandidateGroupCount = 0;
  for (const group of groups) {
    const sourceText = group.sourceSegments.join("");
    const baselineSegments = baselineSegmentsForGroup(group, baselineValues);
    const baselineText = baselineSegments.join("");
    const glossaryRequiresQuery = candidateEntries.some((entry) => (
      glossaryEntryApplies(sourceText, entry) && !glossaryPattern(entry.target).test(baselineText)
    ));
    const bookRequiresQuery = group.sourceSegments.some((sourceSegment, index) => (
      violatesBookInstructions(sourceSegment, baselineSegments[index], bookInstructions)
    ));
    if (bookRequiresQuery) bookInstructionCandidateGroupCount += 1;
    const requiresQuery = glossaryRequiresQuery || bookRequiresQuery;
    if (requiresQuery) selected.push({ ...group, baselineSegments });
    else reused.push({ groupId: group.groupId, segments: baselineSegments });
  }
  return { selected, reused, candidateEntryCount: candidateEntries.length, bookInstructionCandidateGroupCount };
}

function prepareGroup(group, glossaryEntries, bookInstructions) {
  const locks = [];
  const bookSourceLocks = [];
  let lockCounter = 0;
  let bookLockCounter = 0;
  const preparedSegments = group.sourceSegments.map((sourceSegment, segmentIndex) => {
    let prepared = sourceSegment;
    for (const rule of bookInstructions.preserveSourcePatterns) {
      const pattern = configuredPattern(rule);
      prepared = prepared.replace(pattern, (source) => {
        const token = `⟦B_${group.groupId}_${String(bookLockCounter + 1).padStart(4, "0")}⟧`;
        bookLockCounter += 1;
        bookSourceLocks.push({ token, source, ruleId: rule.id, segmentIndex });
        return token;
      });
    }
    for (const { entry, matchMode } of resolveGlossaryEntriesForText(prepared, glossaryEntries)) {
      const pattern = glossaryPattern(entry.source, { caseSensitive: matchMode === "exact" });
      prepared = prepared.replace(pattern, () => {
        const token = `⟦G_${group.groupId}_${String(lockCounter + 1).padStart(4, "0")}⟧`;
        lockCounter += 1;
        locks.push({ token, source: entry.source, target: entry.target, definition: entry.definition, segmentIndex });
        return token;
      });
    }
    const anchor = `⟦S_${group.groupId}_${String(segmentIndex + 1).padStart(3, "0")}⟧`;
    return { anchor, text: `${anchor}${prepared}` };
  });
  return { ...group, locks, bookSourceLocks, preparedSegments };
}

function makeBatches(preparedGroups, maxChars, maxGroups, maxSegments) {
  const batches = [];
  let current = null;
  for (const group of preparedGroups) {
    const groupChars = group.preparedSegments.reduce((sum, item) => sum + item.text.length, 0);
    const groupSegments = group.preparedSegments.length;
    if (groupChars > maxChars || groupSegments > maxSegments) {
      throw new Error(
        `${group.groupId} requires ${groupChars} characters and ${groupSegments} segments, exceeding ` +
        `the per-batch limits (${maxChars} characters, ${maxSegments} segments). Increase the configured limits.`
      );
    }
    if (!current || (current.groups.length && (
      current.sourceChars + groupChars > maxChars ||
      current.groups.length >= maxGroups ||
      current.segmentCount + groupSegments > maxSegments
    ))) {
      current = {
        batchId: `batch_${String(batches.length + 1).padStart(4, "0")}`,
        sourceChars: 0,
        segmentCount: 0,
        groups: [],
      };
      batches.push(current);
    }
    current.groups.push(group);
    current.sourceChars += groupChars;
    current.segmentCount += groupSegments;
  }
  return batches;
}

function buildPrompt(batch, config) {
  const payload = {
    batch_id: batch.batchId,
    target_language: config.targetLanguage,
    glossary_profile: config.glossaryProfile,
    groups: batch.groups.map((group) => ({
      group_id: group.groupId,
      segments: group.preparedSegments.map((item) => item.text),
      ...(group.baselineSegments ? { baseline_segments: group.baselineSegments } : {}),
      glossary_locks: group.locks,
      book_source_locks: group.bookSourceLocks,
    })),
  };
  return [
    "You are translating book content for a professional military audience.",
    `Translate every source segment into natural ${config.targetLanguage}.`,
    "Return only the JSON object required by the supplied output schema.",
    "Keep every group_id, group order, segment order, and segment count exactly unchanged.",
    "Each segment starts with a unique ⟦S_...⟧ anchor. Preserve that anchor exactly at the start of that segment.",
    "Each ⟦G_...⟧ glossary token represents the exact target string listed in glossary_locks. Keep the token in the grammatically correct position; the caller replaces it deterministically after translation.",
    "Every glossary token in the source payload occurs exactly once. Preserve each token exactly once: never duplicate it, omit it, substitute one glossary token for another, or invent a glossary token.",
    "Each ⟦B_...⟧ book-source token represents the exact original-English string listed in book_source_locks. Preserve the token exactly once; the caller restores that official name verbatim.",
    "Translate all ordinary English, including English inside quotation marks and capitalized role labels. Do not leave English words merely because they are capitalized.",
    `Use clear, direct, idiomatic language suitable for a ${config.targetLanguage}-language defense reader. Normalize capitalization to target-language conventions.`,
    ...(config.bookInstructions.applied ? [
      "The following book-specific rules are mandatory. They override conflicting general instructions, glossary wording, and edition guidance:",
      ...config.bookInstructions.promptInstructions.map((instruction) => `- ${instruction}`),
      ...config.bookInstructions.preferredExamples.map((example) => `Preferred example: ${example}`),
    ] : []),
    ...(config.translationGuidance ? [`Editorial guidance for this edition: ${config.translationGuidance}`] : []),
    ...(batch.groups.some((group) => group.baselineSegments) ? [
      "For each group with baseline_segments, use that accepted translation as the starting point. Make only the changes required by the mandatory book rules, current glossary locks, this edition's editorial guidance, or a clear translation error. Preserve good baseline wording and segmentation wherever possible.",
    ] : []),
    "Do not merge, split, summarize, omit, or add information.",
    "Preserve numbers, dates, email addresses, codes, punctuation when appropriate, internal line breaks, and every processing instruction such as <?ACE 4?> exactly.",
    "Preserve leading and trailing whitespace after the segment anchor.",
    "Do not use tools, browse, or read files. Translate only the JSON payload below.",
    JSON.stringify(payload),
  ].join("\n\n");
}

function validateAndRestoreResponse(response, batch, bookInstructions) {
  if (!response || typeof response !== "object" || response.batch_id !== batch.batchId) {
    throw new Error(`Response batch_id mismatch for ${batch.batchId}.`);
  }
  if (!Array.isArray(response.groups) || response.groups.length !== batch.groups.length) {
    throw new Error(`Response group count mismatch for ${batch.batchId}.`);
  }
  const byId = new Map(response.groups.map((group) => [group.group_id, group]));
  if (byId.size !== response.groups.length) throw new Error(`Duplicate group_id in ${batch.batchId} response.`);
  const restored = [];
  for (const sourceGroup of batch.groups) {
    const translatedGroup = byId.get(sourceGroup.groupId);
    if (!translatedGroup || !Array.isArray(translatedGroup.segments)) {
      throw new Error(`Missing translated group ${sourceGroup.groupId}.`);
    }
    if (translatedGroup.segments.length !== sourceGroup.sourceSegments.length) {
      throw new Error(`Segment count mismatch for ${sourceGroup.groupId}.`);
    }
    const segments = translatedGroup.segments.map((raw, index) => {
      if (typeof raw !== "string") {
        throw new Error(`Non-string translation in ${sourceGroup.groupId}, segment ${index + 1}.`);
      }
      let translated = normalizeCell(raw);
      const anchor = sourceGroup.preparedSegments[index].anchor;
      if (!translated.startsWith(anchor)) {
        throw new Error(`Missing segment anchor ${anchor}.`);
      }
      translated = translated.slice(anchor.length);
      const inventedAnchor = translated.match(/⟦S_[^⟧]+⟧/);
      if (inventedAnchor) throw new Error(`Unexpected segment anchor ${inventedAnchor[0]} in ${sourceGroup.groupId}.`);
      for (const lock of sourceGroup.locks.filter((entry) => entry.segmentIndex === index)) {
        const occurrences = translated.split(lock.token).length - 1;
        if (occurrences !== 1) {
          throw new Error(`Glossary lock ${lock.token} occurred ${occurrences} time(s) in ${sourceGroup.groupId}; expected once.`);
        }
        translated = translated.split(lock.token).join(lock.target);
      }
      const leftoverLock = translated.match(/⟦G_[^⟧]+⟧/);
      if (leftoverLock) throw new Error(`Unresolved glossary lock ${leftoverLock[0]} in ${sourceGroup.groupId}.`);
      for (const lock of sourceGroup.bookSourceLocks.filter((entry) => entry.segmentIndex === index)) {
        const occurrences = translated.split(lock.token).length - 1;
        if (occurrences !== 1) {
          throw new Error(`Book source lock ${lock.token} occurred ${occurrences} time(s) in ${sourceGroup.groupId}; expected once.`);
        }
        translated = translated.split(lock.token).join(lock.source);
        restoredBookSourceLocks += 1;
      }
      const leftoverBookLock = translated.match(/⟦B_[^⟧]+⟧/);
      if (leftoverBookLock) throw new Error(`Unresolved book source lock ${leftoverBookLock[0]} in ${sourceGroup.groupId}.`);
      const location = `${sourceGroup.groupId}, segment ${index + 1}`;
      translated = sanitizeXmlText(translated, location);
      if (sourceGroup.sourceSegments[index].trim() && !translated.trim()) {
        throw new Error(`Blank translation for ${sourceGroup.groupId}, segment ${index + 1}.`);
      }
      assertSegmentStructure(sourceGroup.sourceSegments[index], translated, location);
      for (const rule of bookInstructions.forbiddenTargetPatterns) {
        const match = configuredPattern(rule).exec(translated);
        if (match) {
          throw new Error(`Book instruction '${rule.id}' failed in ${sourceGroup.groupId}, segment ${index + 1}: ${rule.message || `forbidden target '${match[0]}'`}`);
        }
      }
      return translated;
    });
    restored.push({ groupId: sourceGroup.groupId, segments });
  }
  return restored;
}

function codexEnvironment() {
  const childEnv = { ...process.env };
  for (const name of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_ORGANIZATION",
    "OPENAI_PROJECT",
  ]) delete childEnv[name];
  return childEnv;
}

function runCodex(nodePath, cliPath, args, options = {}) {
  const run = spawnSync(nodePath, [cliPath, ...args], {
    cwd: options.cwd,
    env: codexEnvironment(),
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs || 60000,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  if (run.error) {
    throw new Error(`Codex process failed to run: ${run.error.message}`, { cause: run.error });
  }
  return run;
}

function assertChatGptLogin(nodePath, cliPath) {
  const status = runCodex(nodePath, cliPath, ["login", "status"]);
  const text = `${status.stdout || ""}\n${status.stderr || ""}`;
  if (status.status !== 0 || !/Logged in using ChatGPT/i.test(text)) {
    throw new Error("Codex subscription provider requires 'Logged in using ChatGPT'. API-key authentication is not permitted for this job.");
  }
}

const REQUIRED_SUBSCRIPTION_REASONING_EFFORT = "xhigh";
const REQUIRED_MODEL_POLICY = "official_latest_frontier";

async function runTranslationBatch({ batch, config, nodePath, cliPath, schemaPath, stateRoot, bookInstructions }) {
  const promptPath = path.join(stateRoot, "requests", `${batch.batchId}.json`);
  const responsePath = path.join(stateRoot, "responses", `${batch.batchId}.json`);
  const rawResponsePath = path.join(stateRoot, "responses", `${batch.batchId}.raw.json`);
  fs.mkdirSync(path.dirname(promptPath), { recursive: true });
  fs.mkdirSync(path.dirname(responsePath), { recursive: true });

  if (fs.existsSync(responsePath)) {
    return validateAndRestoreResponse(readJson(responsePath, `${batch.batchId} response`), batch, bookInstructions);
  }

  if (fs.existsSync(rawResponsePath)) {
    try {
      const recovered = readJson(rawResponsePath, `${batch.batchId} interrupted raw response`);
      const restored = validateAndRestoreResponse(recovered, batch, bookInstructions);
      writeJson(responsePath, recovered);
      fs.rmSync(rawResponsePath, { force: true });
      console.log(`CODEX_BATCH_RECOVERED|batch=${batch.batchId}|groups=${restored.length}`);
      return restored;
    } catch (error) {
      const quarantined = `${rawResponsePath}.invalid-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      fs.renameSync(rawResponsePath, quarantined);
      console.warn(`CODEX_BATCH_RAW_QUARANTINED|batch=${batch.batchId}|file=${quarantined}|reason=${error.message}`);
    }
  }

  const prompt = buildPrompt(batch, { ...config, bookInstructions });
  assertChatGptLogin(nodePath, cliPath);
  const queryModelResolution = await resolveLatestSubscriptionModel({ nodePath, cliPath });
  if (queryModelResolution.model !== config.model) {
    throw new Error(
      `Translation query ${batch.batchId} was prepared for '${config.model}', but the current official frontier model is '${queryModelResolution.model}'. Create a new job; no stale-model fallback is permitted.`
    );
  }
  writeJson(promptPath, {
    batchId: batch.batchId,
    model: queryModelResolution.model,
    modelPolicy: queryModelResolution.policy,
    modelResolvedAt: queryModelResolution.resolvedAt,
    modelResolutionSourceUrl: queryModelResolution.sourceUrl,
    reasoningEffort: config.reasoningEffort,
    sourceChars: batch.sourceChars,
    segmentCount: batch.segmentCount,
    groupCount: batch.groups.length,
    prompt,
  });
  console.log(`CODEX_BATCH_START|batch=${batch.batchId}|groups=${batch.groups.length}|segments=${batch.segmentCount}|chars=${batch.sourceChars}`);

  const run = runCodex(nodePath, cliPath, [
    "exec",
    "-",
    "--model", queryModelResolution.model,
    "-c", `model_reasoning_effort=\"${config.reasoningEffort}\"`,
    "--strict-config",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema", schemaPath,
    "--output-last-message", rawResponsePath,
    "--cd", stateRoot,
    "--color", "never",
  ], { cwd: stateRoot, input: prompt, timeoutMs: config.queryTimeoutMs });

  if (run.status !== 0) {
    const diagnostics = `${run.stdout || ""}\n${run.stderr || ""}`.slice(-12000);
    throw new Error(`Codex subscription query failed for ${batch.batchId} with exit code ${run.status}.\n${diagnostics}`);
  }
  const parsed = readJson(rawResponsePath, `${batch.batchId} raw Codex response`);
  const restored = validateAndRestoreResponse(parsed, batch, bookInstructions);
  writeJson(responsePath, parsed);
  fs.rmSync(rawResponsePath, { force: true });
  console.log(`CODEX_BATCH_COMPLETE|batch=${batch.batchId}|groups=${restored.length}`);
  return restored;
}

function updateManifest(manifestPath, status, details) {
  const manifest = readJson(manifestPath, "job manifest");
  manifest.status = status;
  manifest.updatedAt = new Date().toISOString();
  manifest.subscriptionTranslation = { ...(manifest.subscriptionTranslation || {}), ...details };
  if (status !== "translation_failed") {
    delete manifest.subscriptionTranslation.failedAt;
    delete manifest.subscriptionTranslation.error;
  }
  writeJson(manifestPath, manifest);
}

const cli = parseArgs(process.argv.slice(2));
const jobDir = path.resolve(cli.job);
const configPath = path.join(jobDir, "job_config.json");
const manifestPath = path.join(jobDir, "job_manifest.json");
const config = readJson(configPath, "job configuration");
if (!pathsEqual(String(config.jobPath || ""), jobDir)) throw new Error("Job configuration path does not match --job.");
const stateName = String(config.subscriptionStateName || "codex_subscription");
if (!/^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]*$/.test(stateName)) {
  throw new Error("subscriptionStateName must be a safe relative directory name.");
}
const stateRoot = path.join(jobDir, "state", stateName);
const finalizationJournal = path.join(stateRoot, "finalization_transaction.json");
const finalizationRecovery = recoverFileSetJournalSync(finalizationJournal);
if (finalizationRecovery.recovered) {
  console.log(`CODEX_FINALIZATION_RECOVERED|phase=${finalizationRecovery.phase}`);
}
const manifest = readJson(manifestPath, "job manifest");
if (String(config.translationProvider || "") !== "CodexSubscription") {
  throw new Error(`This runner requires translationProvider=CodexSubscription; found '${config.translationProvider || "(blank)"}'.`);
}
if (String(config.modelPolicy || "") !== REQUIRED_MODEL_POLICY ||
    String(config.reasoningEffort || "") !== REQUIRED_SUBSCRIPTION_REASONING_EFFORT) {
  throw new Error(
    `CodexSubscription requires model policy '${REQUIRED_MODEL_POLICY}' with reasoning effort '${REQUIRED_SUBSCRIPTION_REASONING_EFFORT}'.`
  );
}
const codexCliPath = process.env.CODEX_CLI_JS;
const codexNodePath = process.env.CODEX_NODE_EXE || process.execPath;
if (!codexCliPath || !fs.existsSync(codexCliPath)) throw new Error("The official standalone Codex CLI is not installed.");
const latestModelResolution = await resolveLatestSubscriptionModel({
  nodePath: codexNodePath,
  cliPath: codexCliPath,
});
if (String(config.model || "") !== latestModelResolution.model) {
  throw new Error(
    `This job resolved model '${config.model || "(blank)"}', but the current official frontier model is '${latestModelResolution.model}'. Create a new job; no stale-model fallback is permitted.`
  );
}
if (!["exported", "translating", "translation_failed", "qa_failed", "ready_for_import"].includes(String(manifest.status || ""))) {
  throw new Error(`Job status '${manifest.status || "(blank)"}' is not eligible for translation.`);
}
const bookInstructions = readBookTranslationInstructions(jobDir, config);

const inputPath = path.join(jobDir, "input", "content_export.xlsx");
const outputPath = path.join(jobDir, "output", "content_import.xlsx");
const schemaPath = path.join(stateRoot, "response_schema.json");
const statePath = path.join(stateRoot, "state.json");
const artifactNodeModules = process.env.CODEX_ARTIFACT_NODE_MODULES;
if (!artifactNodeModules) throw new Error("CODEX_ARTIFACT_NODE_MODULES was not supplied by the Step 2 launcher.");

const requireFromRuntime = createRequire(path.join(artifactNodeModules, "package.json"));
const { FileBlob, SpreadsheetFile } = requireFromRuntime("@oai/artifact-tool");

assertLiteralXlsxWorkbook(
  XLSX.readFile(inputPath, { cellFormula: true, cellText: false, cellDates: false }),
  inputPath
);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const worksheet = workbook.worksheets.getItemAt(0);
const usedRange = worksheet.getUsedRange(true);
const sourceValues = usedRange.values.map((row) => row.map(normalizeCell));
const contract = assertWorkbook(sourceValues, inputPath);
const groups = buildGroups(sourceValues);
const protectedSource = readProtectedSourceManifest(jobDir, config);
const protectedPartition = partitionProtectedGroups(groups, sourceValues, protectedSource.contentIds);
const glossary = readGlossary(jobDir, config, undefined, undefined, bookInstructions.glossarySourceTermExclusions);
const glossaryTableMap = readGlossaryTableMap(
  jobDir,
  config,
  [...new Set([
    ...bookInstructions.glossarySourceTermExclusions,
    ...bookInstructions.glossaryTableSourceTermExclusions,
  ])],
);
let selectedGroups = protectedPartition.translatable;
let reusedGroups = [...protectedPartition.protectedGroups];
let baselineDataSha256 = null;
let baselineMode = null;
let baselineCandidateEntryCount = 0;
let baselineBookInstructionCandidateGroupCount = 0;
if (config.baselineTranslation) {
  const configuredBaselinePath = String(config.baselineTranslation.workbookPath || "").trim();
  const baselinePath = path.resolve(configuredBaselinePath || ".");
  if (!configuredBaselinePath || !isStrictlyInside(baselinePath, jobDir)) {
    throw new Error(`Baseline translation workbook must be inside the translation job: ${configuredBaselinePath || "(blank)"}`);
  }
  if (!fs.existsSync(baselinePath)) throw new Error(`Missing baseline translation workbook: ${baselinePath}`);
  const baselineWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(baselinePath));
  const baselineValues = baselineWorkbook.worksheets.getItemAt(0).getUsedRange(true).values.map((row) => row.map(normalizeCell));
  assertBaselineWorkbook(sourceValues, baselineValues, baselinePath);
  baselineMode = String(config.baselineTranslation.mode || "");
  const previousGlossary = baselineMode === "profile_delta"
    ? readGlossary(
      jobDir,
      config,
      String(config.baselineTranslation.previousGlossaryTermKey || ""),
      String(config.baselineTranslation.previousGlossaryDefinitionKey || ""),
      bookInstructions.glossarySourceTermExclusions,
    )
    : [];
  const selection = selectGroupsForBaselineMode(
    protectedPartition.translatable,
    glossary,
    previousGlossary,
    baselineValues,
    baselineMode,
    bookInstructions,
  );
  selectedGroups = selection.selected;
  reusedGroups = [...protectedPartition.protectedGroups, ...selection.reused];
  baselineCandidateEntryCount = selection.candidateEntryCount;
  baselineBookInstructionCandidateGroupCount = selection.bookInstructionCandidateGroupCount;
  baselineDataSha256 = sha256Json(baselineValues);
}
const preparedGroups = selectedGroups.map((group) => prepareGroup(group, glossary, bookInstructions));
const maxChars = positiveIntegerSetting(config.subscriptionBatchMaxChars, DEFAULT_BATCH_MAX_CHARS, "subscriptionBatchMaxChars");
const maxGroups = positiveIntegerSetting(config.subscriptionBatchMaxGroups, DEFAULT_BATCH_MAX_GROUPS, "subscriptionBatchMaxGroups");
const maxSegments = positiveIntegerSetting(config.subscriptionBatchMaxSegments, DEFAULT_BATCH_MAX_SEGMENTS, "subscriptionBatchMaxSegments");
const queryTimeoutMs = positiveIntegerSetting(
  config.subscriptionQueryTimeoutMs,
  DEFAULT_QUERY_TIMEOUT_MS,
  "subscriptionQueryTimeoutMs",
  60000,
);
const batches = makeBatches(preparedGroups, maxChars, maxGroups, maxSegments);

const planCore = {
  schemaVersion: 2,
  inputDataSha256: sha256Json(sourceValues),
  inputFileSha256: sha256File(inputPath),
  glossarySha256: sha256Json(glossary),
  model: String(config.model || ""),
  modelPolicy: REQUIRED_MODEL_POLICY,
  modelResolutionSourceUrl: latestModelResolution.sourceUrl,
  modelCatalogPriority: latestModelResolution.catalogPriority,
  reasoningEffort: String(config.reasoningEffort || "xhigh"),
  targetLanguage: String(config.targetLanguage || ""),
  glossaryProfile: String(config.glossaryProfile || ""),
  maxChars,
  maxGroups,
  maxSegments,
  queryTimeoutMs,
  groups: groups.length,
  protectedGroups: protectedPartition.protectedGroups.length,
  protectedSegments: protectedPartition.protectedSegments,
  protectedSourceContentIds: protectedSource.contentIdCount,
  protectedSourceSetSha256: protectedSource.sourceSetSha256,
  protectedSourceSelectors: protectedSource.selectors,
  queriedGroups: preparedGroups.length,
  reusedGroups: reusedGroups.length,
  baselineMode,
  baselineDataSha256,
  baselineCandidateEntryCount,
  baselineBookInstructionCandidateGroupCount,
  translationGuidance: String(config.translationGuidance || ""),
  bookTranslationInstructions: {
    applied: bookInstructions.applied,
    moduleId: bookInstructions.moduleId,
    sha256: bookInstructions.sha256,
    languageException: bookInstructions.languageException,
    promptInstructions: bookInstructions.promptInstructions,
    preferredExamples: bookInstructions.preferredExamples,
    glossarySourceTermExclusions: bookInstructions.glossarySourceTermExclusions,
    glossaryTableSourceTermExclusions: bookInstructions.glossaryTableSourceTermExclusions,
    preserveSourcePatterns: bookInstructions.preserveSourcePatterns,
    forbiddenTargetPatterns: bookInstructions.forbiddenTargetPatterns,
  },
  batches: batches.length,
};
const planIdentity = {
  ...planCore,
  planSha256: sha256Json(planCore),
};
const hasPriorState = fs.existsSync(statePath);
if (hasPriorState) {
  const prior = readJson(statePath, "Codex subscription state");
  if (prior.planSha256 !== planIdentity.planSha256) {
    throw new Error("The workbook, glossary, model, effort, or batching configuration changed after this subscription run began. Create a new job.");
  }
}
const readinessMessage = `CODEX_SUBSCRIPTION_READY|model=${planIdentity.model}|effort=${planIdentity.reasoningEffort}|groups=${groups.length}|protectedGroups=${protectedPartition.protectedGroups.length}|protectedSegments=${protectedPartition.protectedSegments}|queriedGroups=${preparedGroups.length}|reusedGroups=${reusedGroups.length}|batches=${batches.length}|contentIds=${contract.contentIdCount}|bookInstructions=${bookInstructions.applied ? bookInstructions.moduleId : "none"}`;
if (cli.check) {
  assertChatGptLogin(codexNodePath, codexCliPath);
  console.log(readinessMessage);
  process.exit(0);
}

fs.mkdirSync(stateRoot, { recursive: true });
if (!hasPriorState) {
  writeJson(statePath, { ...planIdentity, createdAt: new Date().toISOString(), completedBatches: [] });
}
writeJson(schemaPath, {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: false,
  properties: {
    batch_id: { type: "string" },
    groups: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          group_id: { type: "string" },
          segments: { type: "array", items: { type: "string" } },
        },
        required: ["group_id", "segments"],
      },
    },
  },
  required: ["batch_id", "groups"],
});

assertChatGptLogin(codexNodePath, codexCliPath);
console.log(readinessMessage);

updateManifest(manifestPath, "translating", {
  provider: "CodexSubscription",
  model: planIdentity.model,
  modelPolicy: planIdentity.modelPolicy,
  latestModelCheckedAt: latestModelResolution.resolvedAt,
  modelResolutionSourceUrl: latestModelResolution.sourceUrl,
  reasoningEffort: planIdentity.reasoningEffort,
  planSha256: planIdentity.planSha256,
  startedAt: new Date().toISOString(),
});

const translatedByGroup = new Map();
for (const group of reusedGroups) translatedByGroup.set(group.groupId, group.segments);
let queried = 0;
try {
  for (const batch of batches) {
    const responsePath = path.join(stateRoot, "responses", `${batch.batchId}.json`);
    const existedBefore = fs.existsSync(responsePath);
    if (!existedBefore && cli.maxBatches !== undefined && queried >= cli.maxBatches) break;
    const restored = await runTranslationBatch({
      batch,
      config: {
        ...config,
        model: planIdentity.model,
        reasoningEffort: planIdentity.reasoningEffort,
        queryTimeoutMs,
      },
      nodePath: codexNodePath,
      cliPath: codexCliPath,
      schemaPath,
      stateRoot,
      bookInstructions,
    });
    if (!existedBefore) queried += 1;
    for (const group of restored) translatedByGroup.set(group.groupId, group.segments);
    const state = readJson(statePath, "Codex subscription state");
    state.completedBatches = batches
      .filter((candidate) => fs.existsSync(path.join(stateRoot, "responses", `${candidate.batchId}.json`)))
      .map((candidate) => candidate.batchId);
    state.updatedAt = new Date().toISOString();
    writeJson(statePath, state);
  }

  if (translatedByGroup.size !== groups.length) {
    const completed = batches.filter((batch) => fs.existsSync(path.join(stateRoot, "responses", `${batch.batchId}.json`))).length;
    updateManifest(manifestPath, "translating", { completedBatches: completed, totalBatches: batches.length });
    console.log(`CODEX_SUBSCRIPTION_PAUSED|completedBatches=${completed}|totalBatches=${batches.length}`);
    process.exit(2);
  }

  const outputValues = sourceValues.map((row) => [...row]);
  for (const group of groups) {
    const segments = translatedByGroup.get(group.groupId);
    for (let index = 0; index < group.rowIndexes.length; index += 1) {
      outputValues[group.rowIndexes[index]][COL_D] = segments[index];
    }
  }
  applyGlossaryTableContract(sourceValues, outputValues, glossaryTableMap);
  const languagePostprocessorCounts = applyLanguagePostprocessors(outputValues, config.targetLanguage, {
    protectedContentIds: protectedSource.contentIds,
  });
  assertBookInstructionOutput(sourceValues, outputValues, protectedSource.contentIds, bookInstructions);
  for (const group of groups) {
    outputValues[group.startRow][COL_B] = group.allRowIndexes.map((rowIndex) => outputValues[rowIndex][COL_D]).join("");
  }
  for (let row = 0; row < sourceValues.length; row += 1) {
    if (outputValues[row][0] !== sourceValues[row][0] || outputValues[row][2] !== sourceValues[row][2]) {
      throw new Error(`Protected identifier columns changed at row ${row + 1}.`);
    }
  }

  worksheet.getRangeByIndexes(0, 0, outputValues.length, 4).values = outputValues;
  const outputBlob = await SpreadsheetFile.exportXlsx(workbook);
  const temporaryOutput = path.join(stateRoot, `.content-import-${process.pid}-${crypto.randomUUID()}.xlsx`);
  let outputBytes;
  let verifyWorkbook;
  let verifySheet;
  let verifyValues;
  try {
    await outputBlob.save(temporaryOutput);

    // Canonicalize string storage through the shared-string table. Excel COM trims
    // boundary spaces from direct string <v> cells, but preserves them when the
    // shared-string entry carries xml:space="preserve". Those spaces are meaningful
    // at ICML Content boundaries and must survive the validator/importer handoff.
    const excelSafeWorkbook = XLSX.readFile(temporaryOutput, {
      cellDates: false,
      cellStyles: true,
    });
    // SheetJS can turn an explicit empty-string cell into a numeric shared-string
    // index during a bookSST rewrite. Continuation rows intentionally leave some
    // Step 2 cells blank, so remove those cells before canonicalizing the workbook.
    const excelSafeWorksheet = excelSafeWorkbook.Sheets[excelSafeWorkbook.SheetNames[0]];
    for (let row = 0; row < outputValues.length; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        if (outputValues[row][column] === "") {
          delete excelSafeWorksheet[XLSX.utils.encode_cell({ r: row, c: column })];
        }
      }
    }
    XLSX.writeFile(excelSafeWorkbook, temporaryOutput, {
      bookType: "xlsx",
      compression: true,
      bookSST: true,
      cellStyles: true,
    });
    assertLiteralXlsxWorkbook(
      XLSX.readFile(temporaryOutput, { cellFormula: true, cellText: false, cellDates: false }),
      temporaryOutput
    );

    verifyWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(temporaryOutput));
    verifySheet = verifyWorkbook.worksheets.getItemAt(0);
    verifyValues = verifySheet.getUsedRange(true).values.map((row) => row.map(normalizeCell));
    assertWorkbook(verifyValues, temporaryOutput);
    if (verifyValues.length !== sourceValues.length) throw new Error("Translated workbook row count changed during XLSX round trip.");
    for (let row = 0; row < sourceValues.length; row += 1) {
      if (verifyValues[row][0] !== sourceValues[row][0] || verifyValues[row][2] !== sourceValues[row][2]) {
        throw new Error(`Protected identifiers changed during XLSX round trip at row ${row + 1}.`);
      }
    }
    outputBytes = fs.readFileSync(temporaryOutput);
  } finally {
    fs.rmSync(temporaryOutput, { force: true });
  }

  const inspect = await verifyWorkbook.inspect({
    kind: "table",
    range: `A1:D${Math.min(verifyValues.length, 20)}`,
    include: "values,formulas",
    tableMaxRows: 20,
    tableMaxCols: 4,
    maxChars: 6000,
  });
  const formulaErrors = await verifyWorkbook.inspect({
    kind: "match",
    searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
    options: { useRegex: true, maxResults: 50 },
    summary: "translation workbook formula error scan",
  });
  const preview = await verifyWorkbook.render({
    sheetName: verifySheet.name,
    range: `A1:D${Math.min(verifyValues.length, 18)}`,
    scale: 1,
    format: "png",
  });
  const previewPath = path.join(jobDir, "reports", "content_import_preview.png");
  const previewBytes = Buffer.from(await preview.arrayBuffer());
  const reportPath = path.join(jobDir, "reports", "subscription_translation_report.json");
  const outputSha256 = sha256Buffer(outputBytes);
  const completedAt = new Date().toISOString();
  const report = {
    schemaVersion: 2,
    provider: "CodexSubscription",
    authentication: "ChatGPT",
    model: planIdentity.model,
    modelPolicy: planIdentity.modelPolicy,
    latestModelCheckedAt: latestModelResolution.resolvedAt,
    modelResolutionSourceUrl: latestModelResolution.sourceUrl,
    reasoningEffort: planIdentity.reasoningEffort,
    targetLanguage: planIdentity.targetLanguage,
    glossaryProfile: planIdentity.glossaryProfile,
    inputWorkbook: inputPath,
    outputWorkbook: outputPath,
    inputDataSha256: planIdentity.inputDataSha256,
    inputFileSha256: planIdentity.inputFileSha256,
    outputSha256,
    contentIdCount: contract.contentIdCount,
    groupCount: groups.length,
    queriedGroupCount: preparedGroups.length,
    reusedGroupCount: reusedGroups.length,
    baselineMode,
    baselineCandidateEntryCount,
    baselineBookInstructionCandidateGroupCount,
    batchCount: batches.length,
    queryTimeoutMs,
    previewPath,
    inspect: inspect.ndjson,
    formulaErrorScan: formulaErrors.ndjson,
    standardizedGlossaryTableRows,
    languagePostprocessors: languagePostprocessorCounts,
    bookTranslationInstructions: {
      applied: bookInstructions.applied,
      moduleId: bookInstructions.moduleId,
      sha256: bookInstructions.sha256,
      languageException: bookInstructions.languageException,
      restoredSourceLocks: restoredBookSourceLocks,
      excludedGlossarySourceTerms: bookInstructions.glossarySourceTermExclusions,
      excludedGlossaryTableSourceTerms: bookInstructions.glossaryTableSourceTermExclusions,
    },
    completedAt,
  };
  const finalManifest = readJson(manifestPath, "job manifest");
  finalManifest.status = "translated";
  finalManifest.updatedAt = completedAt;
  finalManifest.subscriptionTranslation = {
    ...(finalManifest.subscriptionTranslation || {}),
    completedAt,
    completedBatches: batches.length,
    totalBatches: batches.length,
    outputWorkbook: outputPath,
    outputSha256,
  };
  delete finalManifest.subscriptionTranslation.failedAt;
  delete finalManifest.subscriptionTranslation.error;
  const finalization = commitFileSetWithJournalSync(finalizationJournal, [
    { filePath: outputPath, data: outputBytes },
    { filePath: previewPath, data: previewBytes },
    { filePath: reportPath, data: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8") },
    { filePath: manifestPath, data: Buffer.from(`${JSON.stringify(finalManifest, null, 2)}\n`, "utf8") },
  ]);
  if (sha256File(outputPath) !== outputSha256) {
    throw new Error("Committed subscription workbook hash does not match the verified output bytes.");
  }
  console.log(`CODEX_FINALIZATION_OK|id=${finalization.transactionId}|files=${finalization.filesCommitted}`);
  console.log(`CODEX_SUBSCRIPTION_COMPLETE|output=${outputPath}|batches=${batches.length}|groups=${groups.length}`);
} catch (error) {
  updateManifest(manifestPath, "translation_failed", {
    failedAt: new Date().toISOString(),
    error: String(error?.message || error),
  });
  throw error;
}

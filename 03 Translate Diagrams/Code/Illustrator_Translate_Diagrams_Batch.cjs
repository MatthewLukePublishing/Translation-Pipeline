#!/usr/bin/env node
"use strict";

/**
 * Illustrator_Translate_Diagrams_Batch.cjs
 *
 * What it does
 * 1. Prompts for a folder containing .ai files
 * 2. Launches Illustrator ONCE for the whole batch
 * 3. A persistent controller JSX runs inside Illustrator
 * 4. For each .ai file:
 *    - controller invokes the worker JSX against that file
 *    - Illustrator scans Open Sans / Source Code Pro runs and writes scan JSON
 *    - Node makes one ChatGPT-authenticated Codex subscription query per diagram
 *    - Node writes translation JSON
 *    - Illustrator applies translations, saves, and closes
 * 5. If a file fails:
 *    - Node kills Illustrator
 *    - relaunches the persistent controller
 *    - retries that file once
 * 6. Batch continues past failures
 * 7. Failures are logged to a .txt file
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");
const { pathToFileURL } = require("url");
const {
  writeFileAtomicSync,
  writeJsonAtomicSync,
} = require("../../Code/AtomicFiles.cjs");
const {
  cleanText,
  trimString,
} = require("../../Code/TextNormalization.cjs");
const { deleteStateFileIfExists } = require("../../Code/JsonStateStore.cjs");
const {
  buildAcronymSymbolsRuntime,
  listAiFiles,
  resolveDiagramGlossaryResources,
} = require("./DiagramResources.cjs");

let MODEL = "";
let TARGET_LANGUAGE = trimString(process.env.AI_TARGET_LANGUAGE || "");
let BOOK = trimString(process.env.AI_BOOK || "");
let GLOSSARY_PROFILE = trimString(process.env.AI_GLOSSARY_PROFILE || "");
let GLOSSARY_RESOURCES = null;
let SYMBOL_RUNTIME = null;
const REASONING_EFFORT = "xhigh";
const MAX_SUBSCRIPTION_RETRIES = 3;
const CODEX_QUERY_TIMEOUT_MS = 60 * 60 * 1000;
const WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const WAIT_POLL_MS = 500;
const STARTUP_TIMEOUT_MS = 30 * 1000;
const CONTROLLER_READY_TIMEOUT_MS = 2 * 60 * 1000;
const ILLUSTRATOR_RETRY_LIMIT = 2;

const OPEN_SANS_MATCHES = [
  "open sans",
  "opensans",
  "open-sans",
  "alte din 1451 mittelschrift gepraegt",
  "alte din 1451 mittelschrift geprægt"
];

const SOURCE_CODE_MATCHES = [
  "source code pro",
  "sourcecodepro",
  "source-code-pro",
  "source code",
  "sourcecode",
  "source-code"
];

const PROGRAM_ROOT = path.resolve(__dirname, "..", "..");
const MODEL_RESOLVER = path.join(PROGRAM_ROOT, "02 Translate Text", "Code", "Resolve-LatestSubscriptionModel.mjs");
const CODEX_CLI_JS = process.env.CODEX_CLI_JS || path.join(
  process.env.APPDATA || "",
  "npm", "node_modules", "@openai", "codex", "bin", "codex.js",
);
const CODEX_NODE_EXE = process.env.CODEX_NODE_EXE || process.execPath;
const CLI_ARGUMENTS = new Set(process.argv.slice(2));
for (const argument of CLI_ARGUMENTS) {
  if (argument !== "--check") throw new Error(`Unknown argument: ${argument}`);
}
const CHECK_ONLY = CLI_ARGUMENTS.has("--check");

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeToLF(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function getLineBreakStyle(text) {
  const s = String(text ?? "");
  if (s.indexOf("\r\n") !== -1) return "\r\n";
  if (s.indexOf("\r") !== -1) return "\r";
  if (s.indexOf("\n") !== -1) return "\n";
  return null;
}

function countLineBreaks(text) {
  const s = String(text ?? "");
  const matches = s.match(/\r\n|\r|\n/g);
  return matches ? matches.length : 0;
}

function convertLineBreaks(text, targetStyle) {
  const lf = normalizeToLF(text);
  if (!targetStyle) return lf;
  if (targetStyle === "\r\n") return lf.replace(/\n/g, "\r\n");
  if (targetStyle === "\r") return lf.replace(/\n/g, "\r");
  return lf;
}

function splitOuterWhitespace(text) {
  const m = String(text).match(/^([\s]*)([\s\S]*?)([\s]*)$/);
  return {
    leading: m ? m[1] : "",
    core: m ? m[2] : text,
    trailing: m ? m[3] : "",
  };
}

function shouldSkipTranslation(text) {
  const t = cleanText(text).trim();
  if (!t) return true;
  if (/^[0-9\s.,:/\\()[\]{}+_\-–—]+$/.test(t)) return true;
  return false;
}

function normalizeLookupKey(value) {
  return trimString(value).toLowerCase();
}

function escapeRegExp(text) {
  return String(text ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeSmartPunctuation(text) {
  return String(text ?? "")
    .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, "\"")
    .replace(/[\u2010-\u2015]/g, "-");
}

function buildFlexibleTermPattern(term) {
  const normalized = normalizeSmartPunctuation(term);
  return [...normalized].map((ch) => {
    if (ch === "'") return "['\u2018\u2019\u201B\u2032]";
    if (ch === "\"") return "[\"\\u201C\\u201D\\u2033]";
    return escapeRegExp(ch);
  }).join("");
}

function buildBoundaryRegex(term) {
  return new RegExp(
    `(^|[^A-Za-z0-9_])(${buildFlexibleTermPattern(term)})(?=$|[^A-Za-z0-9_])`,
    "giu"
  );
}

function sortGlossaryEntriesForReplacement(entries) {
  return [...entries].sort((a, b) => {
    const aIsAcronym = (a?.kind || "word") === "acronym";
    const bIsAcronym = (b?.kind || "word") === "acronym";
    if (aIsAcronym !== bIsAcronym) return aIsAcronym ? -1 : 1;
    return String(b?.source || "").length - String(a?.source || "").length;
  });
}

function makeGlossaryPairKey(source, target) {
  return `${normalizeLookupKey(source)}\n${normalizeLookupKey(target)}`;
}

function buildGlossaryIndex(glossary) {
  const byPair = new Map();
  const bySource = new Map();

  for (const entry of glossary) {
    const source = trimString(entry.source);
    const target = trimString(entry.target);
    if (!source || !target) continue;

    const normalized = {
      source,
      target,
      context: trimString(entry.context || ""),
      kind: trimString(entry.kind || "word") || "word",
    };

    byPair.set(makeGlossaryPairKey(source, target), normalized);
    if (!bySource.has(normalizeLookupKey(source))) {
      bySource.set(normalizeLookupKey(source), normalized);
    }
  }

  return { byPair, bySource };
}

function enrichGlossaryMatches(glossaryMatches, glossaryIndex) {
  const matches = Array.isArray(glossaryMatches) ? glossaryMatches : [];

  return uniqueBy(
    matches
      .map((match) => {
        const source = trimString(match.source);
        const target = trimString(match.target);
        if (!source || !target) return null;

        const enriched =
          glossaryIndex.byPair.get(makeGlossaryPairKey(source, target)) ||
          glossaryIndex.bySource.get(normalizeLookupKey(source)) ||
          null;

        return {
          source,
          target,
          context: enriched ? enriched.context : "",
          kind: enriched ? enriched.kind : "word",
        };
      })
      .filter(Boolean),
    (entry) => `${entry.source}\n${entry.target}\n${entry.kind}`
  );
}

function hardReplaceGlossaryTermsInText(text, glossaryEntries) {
  let out = String(text ?? "");
  const applied = [];

  for (const entry of sortGlossaryEntriesForReplacement(glossaryEntries)) {
    const source = trimString(entry.source);
    const target = trimString(entry.target);
    if (!source || !target) continue;

    let replacedCount = 0;
    out = out.replace(buildBoundaryRegex(source), (_match, before) => {
      replacedCount += 1;
      return `${before}${target}`;
    });

    if (replacedCount > 0) {
      applied.push({
        source,
        target,
        context: trimString(entry.context || ""),
        kind: trimString(entry.kind || "word") || "word",
        count: replacedCount,
      });
    }
  }

  return { text: out, applied };
}

function buildRelevantAcronymLocks(text, glossaryEntries) {
  const sourceText = String(text ?? "");
  const locks = [];
  const seen = new Set();

  for (const entry of sortGlossaryEntriesForReplacement(glossaryEntries)) {
    const source = trimString(entry.source);
    const target = trimString(entry.target);
    const kind = trimString(entry.kind || "word") || "word";

    if (kind !== "acronym" || !source || !target) continue;
    if (seen.has(`${source}\n${target}`)) continue;
    if (!buildBoundaryRegex(target).test(sourceText)) continue;

    seen.add(`${source}\n${target}`);
    locks.push({
      source,
      target,
      placeholder: `__lock_acronym_${locks.length + 1}__`,
    });
  }

  return locks;
}

function applyAcronymLocksToText(text, locks) {
  let out = String(text ?? "");
  for (const lock of locks) {
    out = out.replace(buildBoundaryRegex(lock.target), (_match, before) => {
      return `${before}${lock.placeholder}`;
    });
  }
  return out;
}

function restoreAcronymLocksInText(text, locks) {
  let out = String(text ?? "");
  for (const lock of locks) {
    out = out.split(lock.placeholder).join(lock.target);
  }
  return out;
}

function findIllustratorExe() {
  const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
  const candidates = [];

  for (const root of roots) {
    const adobeDir = path.join(root, "Adobe");
    if (!fs.existsSync(adobeDir)) continue;

    for (const entry of fs.readdirSync(adobeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^Adobe Illustrator/i.test(entry.name)) continue;

      const exe = path.join(
        adobeDir,
        entry.name,
        "Support Files",
        "Contents",
        "Windows",
        "Illustrator.exe"
      );

      if (fs.existsSync(exe)) {
        candidates.push(exe);
      }
    }
  }

  if (!candidates.length) return null;

  return candidates
    .map((p) => ({ p, t: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0].p;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeBaseName(file) {
  return path.basename(file, path.extname(file));
}

function makeTempStem(filePath) {
  const base = safeBaseName(filePath)
    .replace(/[^\w.-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "diagram";

  const hash = crypto
    .createHash("sha1")
    .update(path.resolve(filePath))
    .digest("hex")
    .slice(0, 12);

  return `${base}.${hash}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeTextAtomic(filePath, text) {
  writeFileAtomicSync(filePath, text, "utf8");
}

function writeJson(filePath, obj) {
  writeJsonAtomicSync(filePath, obj);
}

function removeFileIfExists(filePath) {
  deleteStateFileIfExists(filePath, "Illustrator coordination file");
}

function tryReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return readJson(filePath);
  } catch {
    return null;
  }
}

function terminateChildProcess(child) {
  if (!child || child.killed) return;

  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
  } catch { /* Fall through to the portable SIGTERM path. */ }

  try {
    child.kill("SIGTERM");
  } catch { /* Process may already have exited. */ }
}

function makeFailureLogPath(tempRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(tempRoot, `Illustrator_Translate_Diagrams_Batch.failures.${stamp}.txt`);
}

function appendFailureLog(logPath, lines) {
  const payload = Array.isArray(lines) ? lines.join("\n") : String(lines);
  fs.appendFileSync(logPath, payload + "\n", "utf8");
}

async function waitForSignalFile({
  filePath,
  timeoutMs,
  illustratorState,
  errorPaths,
  stageLabel,
  onTimeoutMessage,
}) {
  const start = Date.now();

  while (true) {
    if (fs.existsSync(filePath)) return;

    if (Array.isArray(errorPaths)) {
      for (const errPath of errorPaths) {
        if (!errPath || !fs.existsSync(errPath)) continue;

        const errPayload = tryReadJson(errPath);
        if (errPayload && errPayload.message) {
          const location = errPayload.file ? `\nTarget file: ${errPayload.file}` : "";
          const details = Array.isArray(errPayload.issues) && errPayload.issues.length
            ? `\nIssues:\n- ${errPayload.issues.join("\n- ")}`
            : "";
          throw new Error(
            `Illustrator JSX failed during ${stageLabel}: ${errPayload.message}${location}${details}`
          );
        }
        if (errPayload && errPayload.error) {
          throw new Error(
            `Illustrator controller failed during ${stageLabel}: ${errPayload.error}`
          );
        }
        throw new Error(`Illustrator reported an error during ${stageLabel}. See: ${errPath}`);
      }
    }

    if (illustratorState && illustratorState.exited) {
      throw new Error(
        illustratorState.exitSignal
          ? `Illustrator exited during ${stageLabel} due to signal ${illustratorState.exitSignal}`
          : `Illustrator exited during ${stageLabel} with code ${illustratorState.exitCode}`
      );
    }

    if (Date.now() - start > timeoutMs) {
      const extra = onTimeoutMessage ? ` ${onTimeoutMessage}` : "";
      throw new Error(`Timed out waiting for file: ${filePath}.${extra}`);
    }

    await sleep(WAIT_POLL_MS);
  }
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function makeGlossarySection(scanPayload) {
  const glossary = Array.isArray(scanPayload.glossary) ? scanPayload.glossary : [];

  const normalized = glossary
    .map((g) => ({
      source: trimString(g.source),
      target: trimString(g.target),
      context: trimString(g.context || ""),
      kind: trimString(g.kind || "word"),
    }))
    .filter((g) => g.source && g.target);

  return uniqueBy(normalized, (g) => `${g.source}\n${g.target}\n${g.kind}`);
}

function makeInputItems(scanPayload) {
  const runs = Array.isArray(scanPayload.runs) ? scanPayload.runs : [];
  const glossary = makeGlossarySection(scanPayload);
  const glossaryIndex = buildGlossaryIndex(glossary);

  return runs.map((run) => {
    const originalText = String(run.originalText || "");
    const { leading, core, trailing } = splitOuterWhitespace(originalText);
    const sourceText = normalizeToLF(core);
    const glossaryMatches = enrichGlossaryMatches(run.glossaryMatches, glossaryIndex);
    const replaced = hardReplaceGlossaryTermsInText(sourceText, glossaryMatches);
    const acronymLocks = buildRelevantAcronymLocks(replaced.text, glossaryMatches);
    const lockedText = applyAcronymLocksToText(replaced.text, acronymLocks);

    return {
      id: String(run.id),
      sourceText,
      text: lockedText,
      leadingWhitespace: leading,
      trailingWhitespace: trailing,
      originalLineBreakStyle: getLineBreakStyle(core),
      originalLineBreakCount: countLineBreaks(core),
      glossaryMatches,
      appliedGlossaryReplacements: replaced.applied,
      lockedAcronyms: acronymLocks,
      skipTranslation: shouldSkipTranslation(core),
    };
  });
}

function buildDelimitedPrompt(scanPayload) {
  const targetLanguage = trimString(scanPayload.targetLanguage || TARGET_LANGUAGE);
  const glossary = makeGlossarySection(scanPayload);
  const items = makeInputItems(scanPayload);

  return [
    "You are translating all text loads from one Illustrator diagram in a single batch.",
    "The shared glossary applies to the entire diagram and is separate from the text items.",
    "Each item's text is the authoritative source to translate.",
    "Some glossary terms may already be pre-replaced into the target language inside item text.",
    "Do not translate pre-replaced glossary terms back into English or paraphrase them.",
    "Any placeholder like __lock_acronym_1__ is a locked acronym token that must be preserved exactly.",
    "Preserve ids exactly and return only valid JSON matching the schema.",
    "",
    "<<<BEGIN_SHARED_SCHEMA>>>",
    JSON.stringify({
      input_type: "diagram_translation_batch",
      output_type: {
        translations: [
          { id: "string", translated: "string" }
        ]
      }
    }, null, 2),
    "<<<END_SHARED_SCHEMA>>>",
    "",
    "<<<BEGIN_SHARED_GLOSSARY>>>",
    JSON.stringify({
      target_language: targetLanguage,
      rules: [
        "Use exact glossary target terms whenever the glossary source term appears.",
        "Use glossary context only as semantic guidance.",
        "If an item is only a glossary term, return only the exact glossary target term.",
        "Some glossary terms may already appear in target-language form inside the item text. Keep them exactly."
      ],
      shared_glossary: glossary
    }, null, 2),
    "<<<END_SHARED_GLOSSARY>>>",
    "",
    "<<<BEGIN_TEXT_ITEMS>>>",
    JSON.stringify({
      instructions: [
        "Translate each item into the target language.",
        `Write fully in ${targetLanguage}. No ordinary English lexical words should remain unless they are required unchanged items such as email addresses, URLs, file names, code, or locked acronym placeholders.`,
        "Do not assume a capitalized English word is a proper noun. Translate it unless it is a true name or another required unchanged item.",
        "Normalize capitalization to natural target-language conventions while preserving meaning and required tokens.",
        "Do not omit any item.",
        "Do not add information, summarize, or split one item into multiple ideas.",
        "Preserve punctuation, numbering, and formatting inside each item.",
        "Preserve internal line breaks exactly.",
        "Do not collapse multi-line text into one line.",
        "If skipTranslation is true, return the item text unchanged.",
        "Preserve every locked acronym placeholder exactly and do not expand, translate, or remove it.",
        "Return translations only in the required JSON schema."
      ],
      items: items.map((item) => {
        const payload = {
          id: item.id,
          text: item.text,
          skipTranslation: item.skipTranslation,
        };

        if (item.appliedGlossaryReplacements.length) {
          payload.applied_glossary_replacements = item.appliedGlossaryReplacements;
        }

        if (item.lockedAcronyms.length) {
          payload.locked_acronyms = item.lockedAcronyms;
        }

        return payload;
      })
    }, null, 2),
    "<<<END_TEXT_ITEMS>>>"
  ].join("\n");
}

function buildResponseSchema(expectedIds) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        translations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                enum: expectedIds
              },
              translated: {
                type: "string"
              }
            },
            required: ["id", "translated"]
          }
        }
      },
      required: ["translations"]
  };
}

function codexEnvironment() {
  const childEnv = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENAI_PROJECT"]) {
    delete childEnv[name];
  }
  return childEnv;
}

function runCodex(args, options = {}) {
  const run = spawnSync(CODEX_NODE_EXE, [CODEX_CLI_JS, ...args], {
    cwd: options.cwd,
    env: codexEnvironment(),
    input: options.input,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs || 60000,
    killSignal: "SIGTERM",
    windowsHide: true,
  });
  if (run.error) throw new Error(`Codex subscription process failed: ${run.error.message}`, { cause: run.error });
  return run;
}

function assertChatGptLogin() {
  const status = runCodex(["login", "status"]);
  const diagnostic = `${status.stdout || ""}\n${status.stderr || ""}`;
  if (status.status !== 0 || !/Logged in using ChatGPT/i.test(diagnostic)) {
    throw new Error("Diagram translation requires Codex logged in with ChatGPT; API-key authentication is disabled.");
  }
}

async function resolveSubscriptionModel() {
  if (!fs.existsSync(MODEL_RESOLVER)) throw new Error(`Missing latest-model resolver: ${MODEL_RESOLVER}`);
  if (!fs.existsSync(CODEX_CLI_JS)) throw new Error(`Missing official Codex CLI: ${CODEX_CLI_JS}`);
  const resolver = await import(pathToFileURL(MODEL_RESOLVER).href);
  const resolution = await resolver.resolveLatestSubscriptionModel({
    nodePath: CODEX_NODE_EXE,
    cliPath: CODEX_CLI_JS,
  });
  if (resolution.reasoningEffort !== REASONING_EFFORT) {
    throw new Error(`Latest Codex model does not satisfy required reasoning effort '${REASONING_EFFORT}'.`);
  }
  return resolution;
}

async function translateDiagramOnce(scanPayload, statePaths) {
  const runs = Array.isArray(scanPayload.runs) ? scanPayload.runs : [];
  const items = makeInputItems(scanPayload);

  if (!runs.length) {
    return { translations: [] };
  }

  const onlySkippable = items.every((item) => item.skipTranslation);
  if (onlySkippable) {
    return {
      translations: runs.map((run, idx) => ({
        id: String(run.id),
        translated: items[idx].sourceText
      }))
    };
  }

  const expectedIds = runs.map((run) => String(run.id));
  const prompt = buildDelimitedPrompt(scanPayload);
  writeJson(statePaths.codexSchemaJson, buildResponseSchema(expectedIds));
  writeTextAtomic(statePaths.codexPromptText, prompt);
  let lastErr;

  for (let attempt = 1; attempt <= MAX_SUBSCRIPTION_RETRIES; attempt++) {
    try {
      removeFileIfExists(statePaths.codexResponseJson);
      const run = runCodex([
        "exec", "-",
        "--model", MODEL,
        "-c", `model_reasoning_effort=\"${REASONING_EFFORT}\"`,
        "--strict-config",
        "--sandbox", "read-only",
        "--skip-git-repo-check",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--output-schema", statePaths.codexSchemaJson,
        "--output-last-message", statePaths.codexResponseJson,
        "--cd", path.dirname(statePaths.codexResponseJson),
        "--color", "never",
      ], {
        cwd: path.dirname(statePaths.codexResponseJson),
        input: prompt,
        timeoutMs: CODEX_QUERY_TIMEOUT_MS,
      });
      if (run.status !== 0) {
        const diagnostics = `${run.stdout || ""}\n${run.stderr || ""}`.slice(-12000);
        throw new Error(`Codex subscription query exited with code ${run.status}.\n${diagnostics}`);
      }
      const parsed = readJson(statePaths.codexResponseJson);
      validateTranslations(scanPayload, parsed);

      return parsed;
    } catch (err) {
      lastErr = err;
      console.warn(`Diagram subscription retry ${attempt}/${MAX_SUBSCRIPTION_RETRIES} failed: ${err.message}`);
      await sleep(1000 * attempt);
    }
  }

  throw lastErr;
}

function validateTranslations(scanPayload, translationPayload) {
  const runs = Array.isArray(scanPayload.runs) ? scanPayload.runs : [];
  const items = makeInputItems(scanPayload);
  const itemById = new Map(items.map((item) => [item.id, item]));
  const expectedIds = {};
  let i;

  for (i = 0; i < runs.length; i++) {
    expectedIds[String(runs[i].id)] = true;
  }

  if (!translationPayload || !Array.isArray(translationPayload.translations)) {
    throw new Error("translationPayload.translations is missing or not an array.");
  }

  const seen = {};
  for (i = 0; i < translationPayload.translations.length; i++) {
    const row = translationPayload.translations[i];
    const id = String(row.id);

    if (!expectedIds[id]) {
      throw new Error("Response included unexpected id: " + id);
    }
    if (seen[id]) {
      throw new Error("Response included duplicate id: " + id);
    }
    if (typeof row.translated !== "string") {
      throw new Error("Response translated value must be a string for id: " + id);
    }
    const item = itemById.get(id);
    if (item.skipTranslation && row.translated !== item.sourceText) {
      throw new Error("Skippable diagram text changed for id: " + id);
    }
    if (countLineBreaks(row.translated) !== item.originalLineBreakCount) {
      throw new Error("Response changed the line-break count for id: " + id);
    }
    if (item.sourceText.trim() && !row.translated.trim()) {
      throw new Error("Response returned a blank translation for id: " + id);
    }
    for (const lock of item.lockedAcronyms || []) {
      const expected = item.text.split(lock.placeholder).length - 1;
      const actual = row.translated.split(lock.placeholder).length - 1;
      if (actual !== expected) {
        throw new Error(`Response changed locked acronym ${lock.placeholder} for id ${id}: expected ${expected}, found ${actual}.`);
      }
    }
    const knownLocks = new Set((item.lockedAcronyms || []).map((lock) => lock.placeholder));
    const inventedLocks = row.translated.match(/__lock_acronym_\d+__/g) || [];
    if (inventedLocks.some((token) => !knownLocks.has(token))) {
      throw new Error("Response invented a locked acronym placeholder for id: " + id);
    }

    seen[id] = true;
  }

  for (const id in expectedIds) {
    if (Object.prototype.hasOwnProperty.call(expectedIds, id) && !seen[id]) {
      throw new Error("Response omitted required id: " + id);
    }
  }
}

function sortTranslationsLikeRuns(scanPayload, translationPayload) {
  const byId = {};
  for (const row of translationPayload.translations) {
    byId[String(row.id)] = row;
  }

  const inputItems = makeInputItems(scanPayload);

  return {
    sourceFile: scanPayload.file || "",
    targetLanguage: scanPayload.targetLanguage || TARGET_LANGUAGE,
    count: (scanPayload.runs || []).length,
    translations: (scanPayload.runs || []).map((run, idx) => {
      const item = inputItems[idx];
      let translatedCore = String(byId[String(run.id)].translated || "");

      translatedCore = restoreAcronymLocksInText(translatedCore, item.lockedAcronyms || []);
      translatedCore = convertLineBreaks(
        translatedCore,
        item.originalLineBreakStyle || "\r"
      );

      return {
        id: String(run.id),
        frameIndex: run.frameIndex,
        start: run.start,
        length: run.length,
        translated: `${item.leadingWhitespace}${translatedCore}${item.trailingWhitespace}`
      };
    })
  };
}

function launchIllustratorControllerAsync(illustratorExe, controllerJsxPath, envVars) {
  const child = spawn(illustratorExe, ["-r", controllerJsxPath], {
    env: { ...process.env, ...envVars },
    windowsHide: false,
    stdio: "inherit",
  });

  const state = {
    exited: false,
    exitCode: null,
    exitSignal: null,
  };

  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      state.exited = true;
      state.exitCode = code;
      state.exitSignal = signal ?? null;

      if (code === 0) resolve();
      else {
        reject(new Error(
          signal
            ? `Illustrator exited due to signal ${signal}`
            : `Illustrator exited with code ${code}`
        ));
      }
    });
  });

  // Always observe the rejection so a non-zero exit (e.g. taskkill during
  // retry, or Illustrator crashing) never becomes an unhandled rejection
  // that crashes the Node process. State is tracked via `state.exited`.
  completion.catch(() => {});

  return { child, state, completion };
}

function assertBatchSucceeded(failureCount, totalCount, failureLogPath) {
  if (!Number.isInteger(failureCount) || failureCount < 0 ||
      !Number.isInteger(totalCount) || totalCount < failureCount) {
    throw new Error(`Invalid Stage 3 batch totals: failed=${failureCount}, total=${totalCount}`);
  }
  if (failureCount > 0) {
    throw new Error(
      `Stage 3 completed with ${failureCount} failed diagram(s) out of ${totalCount}. ` +
      `Review the failure log and rerun the failed files: ${failureLogPath}`
    );
  }
}

function buildControllerJsx({
  jobsDir,
  workerJsx,
  readyJson,
  stopJson,
  sessionErrorJson,
  pollMs,
}) {
  return `
#target illustrator

if (typeof JSON === "undefined") {
  JSON = {};

  JSON.stringify = function (value) {
    function escapeString(str) {
      var s = String(str);
      var out = '"';
      for (var i = 0; i < s.length; i++) {
        var code = s.charCodeAt(i);
        if (code === 0x22) { out += '\\\\"'; }
        else if (code === 0x5C) { out += '\\\\\\\\'; }
        else if (code === 0x08) { out += '\\\\b'; }
        else if (code === 0x09) { out += '\\\\t'; }
        else if (code === 0x0A) { out += '\\\\n'; }
        else if (code === 0x0C) { out += '\\\\f'; }
        else if (code === 0x0D) { out += '\\\\r'; }
        else if (code < 0x20 || code === 0x7F) {
          var hex = code.toString(16);
          while (hex.length < 4) hex = '0' + hex;
          out += '\\\\u' + hex;
        } else {
          out += s.charAt(i);
        }
      }
      out += '"';
      return out;
    }

    function stringify(v) {
      var i, key, parts;

      if (v === null) return "null";

      switch (typeof v) {
        case "string":
          return escapeString(v);
        case "number":
          return isFinite(v) ? String(v) : "null";
        case "boolean":
          return v ? "true" : "false";
        case "object":
          if (v instanceof Array) {
            parts = [];
            for (i = 0; i < v.length; i++) {
              parts.push(stringify(v[i]));
            }
            return "[" + parts.join(",") + "]";
          }

          parts = [];
          for (key in v) {
            if (v.hasOwnProperty(key)) {
              parts.push(stringify(String(key)) + ":" + stringify(v[key]));
            }
          }
          return "{" + parts.join(",") + "}";
        default:
          return "null";
      }
    }

    return stringify(value);
  };

  JSON.parse = function (text) {
    return eval("(" + text + ")");
  };
}

(function () {
  function writeText(filePath, text) {
    var f = new File(filePath);
    f.encoding = "UTF-8";
    if (!f.open("w")) throw new Error("Could not open file for writing: " + filePath);
    f.write(text);
    f.close();
  }

  function writeJson(filePath, obj) {
    writeText(filePath, JSON.stringify(obj));
  }

  function readText(filePath) {
    var f = new File(filePath);
    f.encoding = "UTF-8";
    if (!f.exists) return "";
    if (!f.open("r")) throw new Error("Could not open file for reading: " + filePath);
    var s = f.read();
    f.close();
    return s;
  }

  function readJson(filePath) {
    return JSON.parse(readText(filePath));
  }

  function listJobFiles(folderPath) {
    var folder = new Folder(folderPath);
    if (!folder.exists) return [];
    var files = folder.getFiles(function (entry) {
      return entry instanceof File && /\\.job\\.json$/i.test(entry.name);
    });
    files.sort(function (a, b) {
      var an = a.name.toLowerCase();
      var bn = b.name.toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return 1;
      return 0;
    });
    return files;
  }

  function renameFileInPlace(fileObj, newName) {
    return fileObj.rename(newName);
  }

  function setEnvMap(envMap) {
    for (var key in envMap) {
      if (!envMap.hasOwnProperty(key)) continue;
      try {
        $.setenv(key, String(envMap[key]));
      } catch (_) {}
    }
  }

  function clearSessionError() {
    var f = new File(${JSON.stringify(sessionErrorJson)});
    if (f.exists) {
      try { f.remove(); } catch (_) {}
    }
  }

  function writeSessionError(err, stage, filePath) {
    try {
      writeJson(${JSON.stringify(sessionErrorJson)}, {
        error: String(err),
        stage: String(stage || ""),
        file: String(filePath || ""),
        ts: new Date().toUTCString()
      });
    } catch (_) {}
  }

  try {
    clearSessionError();
    writeJson(${JSON.stringify(readyJson)}, {
      ready: true,
      ts: new Date().toUTCString(),
      app: app.name,
      version: app.version
    });

    while (true) {
      var stopFile = new File(${JSON.stringify(stopJson)});
      if (stopFile.exists) {
        break;
      }

      var jobs = listJobFiles(${JSON.stringify(jobsDir)});
      if (!jobs.length) {
        $.sleep(${Number(pollMs) || 500});
        continue;
      }

      var jobFile = jobs[0];
      var workingName = jobFile.name.replace(/\\.job\\.json$/i, ".working.json");
      renameFileInPlace(jobFile, workingName);

      var workingFile = new File(jobFile.parent.fsName + "/" + workingName);
      var job = null;

      try {
        job = readJson(workingFile.fsName);

        if (!job || !job.env || !job.controllerDoneJson || !job.controllerErrorJson) {
          throw new Error("Invalid controller job payload.");
        }

        var doneFile = new File(job.controllerDoneJson);
        var errFile = new File(job.controllerErrorJson);

        try { if (doneFile.exists) doneFile.remove(); } catch (_) {}
        try { if (errFile.exists) errFile.remove(); } catch (_) {}

        setEnvMap(job.env);

        try {
          $.evalFile(${JSON.stringify(workerJsx)});
        } catch (workerErr) {
          try {
            writeJson(job.controllerErrorJson, {
              error: String(workerErr),
              phase: "worker_eval",
              ts: new Date().toUTCString()
            });
          } catch (_) {}
          throw workerErr;
        }

        try {
          writeJson(job.controllerDoneJson, {
            ok: true,
            ts: new Date().toUTCString()
          });
        } catch (_) {}
      } catch (jobErr) {
        try {
          if (job && job.controllerErrorJson) {
            writeJson(job.controllerErrorJson, {
              error: String(jobErr),
              phase: "controller_job",
              ts: new Date().toUTCString()
            });
          }
        } catch (_) {}

        writeSessionError(jobErr, "controller_job", job && job.env ? job.env.AI_BATCH_FILE : "");
      } finally {
        try { if (workingFile.exists) workingFile.remove(); } catch (_) {}
      }
    }
  } catch (fatalErr) {
    writeSessionError(fatalErr, "controller_fatal", "");
  }
})();
`.trim();
}

function writeControllerJsx(controllerJsxPath, params) {
  const jsx = buildControllerJsx(params);
  writeTextAtomic(controllerJsxPath, jsx);
}

function makeSessionPaths(tempRoot) {
  const sessionDir = path.join(tempRoot, "session");
  const jobsDir = path.join(tempRoot, "jobs");
  ensureDir(sessionDir);
  ensureDir(jobsDir);

  return {
    sessionDir,
    jobsDir,
    controllerJsxPath: path.join(sessionDir, "Illustrator_Controller_Persistent.jsx"),
    readyJson: path.join(sessionDir, "controller.ready.json"),
    stopJson: path.join(sessionDir, "controller.stop.json"),
    sessionErrorJson: path.join(sessionDir, "controller.error.json"),
  };
}

async function startIllustratorSession({
  illustratorExe,
  controllerJsxPath,
  jobsDir,
  jsxWorker,
  readyJson,
  stopJson,
  sessionErrorJson,
}) {
  removeFileIfExists(readyJson);
  removeFileIfExists(stopJson);
  removeFileIfExists(sessionErrorJson);

  writeControllerJsx(controllerJsxPath, {
    jobsDir,
    workerJsx: jsxWorker,
    readyJson,
    stopJson,
    sessionErrorJson,
    pollMs: WAIT_POLL_MS,
  });

  const launch = launchIllustratorControllerAsync(illustratorExe, controllerJsxPath, {});

  await waitForSignalFile({
    filePath: readyJson,
    timeoutMs: CONTROLLER_READY_TIMEOUT_MS,
    illustratorState: launch.state,
    errorPaths: [sessionErrorJson],
    stageLabel: "controller startup",
    onTimeoutMessage:
      "Illustrator launched but the persistent controller did not report ready."
  });

  return launch;
}

function makePerFilePaths(tempRoot, stem) {
  const scanDir = path.join(tempRoot, "scan");
  const translateDir = path.join(tempRoot, "translate");
  const startupDir = path.join(tempRoot, "startup");
  const errorDir = path.join(tempRoot, "error");
  const controllerDoneDir = path.join(tempRoot, "controller-done");
  const controllerErrorDir = path.join(tempRoot, "controller-error");
  const codexDir = path.join(tempRoot, "codex-subscription");

  ensureDir(scanDir);
  ensureDir(translateDir);
  ensureDir(startupDir);
  ensureDir(errorDir);
  ensureDir(controllerDoneDir);
  ensureDir(controllerErrorDir);
  ensureDir(codexDir);

  return {
    scanJson: path.join(scanDir, `${stem}.scan.json`),
    translateJson: path.join(translateDir, `${stem}.translations.json`),
    startupJson: path.join(startupDir, `${stem}.started.json`),
    errorJson: path.join(errorDir, `${stem}.error.json`),
    controllerDoneJson: path.join(controllerDoneDir, `${stem}.done.json`),
    controllerErrorJson: path.join(controllerErrorDir, `${stem}.error.json`),
    codexPromptText: path.join(codexDir, `${stem}.prompt.txt`),
    codexSchemaJson: path.join(codexDir, `${stem}.schema.json`),
    codexResponseJson: path.join(codexDir, `${stem}.response.json`),
  };
}

function clearPerFilePaths(pathsObj) {
  for (const key of Object.keys(pathsObj)) {
    removeFileIfExists(pathsObj[key]);
  }
}

function submitControllerJob({ jobsDir, stem, envVars, controllerDoneJson, controllerErrorJson }) {
  const jobPath = path.join(jobsDir, `${stem}.${Date.now()}.job.json`);
  writeJson(jobPath, {
    env: envVars,
    controllerDoneJson,
    controllerErrorJson,
    ts: new Date().toISOString(),
  });
  return jobPath;
}

async function waitForControllerJobDone({
  controllerDoneJson,
  controllerErrorJson,
  workerErrorJson,
  sessionErrorJson,
  illustratorState,
  timeoutMs,
  aiFile,
}) {
  await waitForSignalFile({
    filePath: controllerDoneJson,
    timeoutMs,
    illustratorState,
    errorPaths: [controllerErrorJson, workerErrorJson, sessionErrorJson],
    stageLabel: `job completion for ${aiFile}`,
    onTimeoutMessage:
      "The worker started but did not finish in time."
  });
}

async function processFileInSession({
  aiFile,
  illustratorState,
  jobsDir,
  tempRoot,
  sessionErrorJson,
}) {
  const stem = makeTempStem(aiFile);
  const perFile = makePerFilePaths(tempRoot, stem);

  clearPerFilePaths(perFile);
  // Clear the shared session error from any previous file. Without this, a
  // residual sessionErrorJson cascades and is misreported as the current
  // file's error, breaking the rest of the batch.
  removeFileIfExists(sessionErrorJson);

  if (!fs.existsSync(aiFile)) {
    throw new Error(`Source .ai file does not exist on disk: ${aiFile}`);
  }

  const envVars = {
    AI_MODE: "process",
    AI_BATCH_FILE: aiFile,
    AI_SCAN_JSON: perFile.scanJson,
    AI_TRANSLATION_JSON: perFile.translateJson,
    AI_STARTUP_JSON: perFile.startupJson,
    AI_ERROR_JSON: perFile.errorJson,
    AI_OPEN_SANS_MATCHES: OPEN_SANS_MATCHES.join("|"),
    AI_SOURCE_CODE_MATCHES: SOURCE_CODE_MATCHES.join("|"),
    AI_TARGET_LANGUAGE: TARGET_LANGUAGE,
    AI_GLOSSARY_TERM_KEY: GLOSSARY_RESOURCES.glossaryTermKey,
    AI_SYMBOL_LANGUAGE: GLOSSARY_RESOURCES.targetLanguage,
    AI_NEW_WORDS_JSON: GLOSSARY_RESOURCES.wordsJson,
    AI_NEW_ACRONYMS_JSON: GLOSSARY_RESOURCES.acronymsJson,
    AI_NEW_ACRONYMS_SYMBOLS_JSON: GLOSSARY_RESOURCES.symbolsJson,
    AI_WAIT_TIMEOUT_MS: String(WAIT_TIMEOUT_MS),
    AI_WAIT_POLL_MS: String(WAIT_POLL_MS),
    AI_QUIT_ON_FINISH: "0",
  };

  submitControllerJob({
    jobsDir,
    stem,
    envVars,
    controllerDoneJson: perFile.controllerDoneJson,
    controllerErrorJson: perFile.controllerErrorJson,
  });

  await waitForSignalFile({
    filePath: perFile.startupJson,
    timeoutMs: STARTUP_TIMEOUT_MS,
    illustratorState,
    errorPaths: [perFile.controllerErrorJson, perFile.errorJson, sessionErrorJson],
    stageLabel: "startup",
    onTimeoutMessage:
      "Illustrator may be blocked by a permission or security prompt before the JSX begins running."
  });

  await waitForSignalFile({
    filePath: perFile.scanJson,
    timeoutMs: WAIT_TIMEOUT_MS,
    illustratorState,
    errorPaths: [perFile.controllerErrorJson, perFile.errorJson, sessionErrorJson],
    stageLabel: "scan generation",
    onTimeoutMessage:
      "The JSX started but did not produce scan JSON in time. Check Illustrator for open dialogs, missing fonts, or document-specific script errors."
  });

  const scanData = readJson(perFile.scanJson);
  const runs = Array.isArray(scanData.runs) ? scanData.runs : [];

  if (!runs.length) {
    console.log("No Open Sans text found. Waiting for Illustrator to finish save/close...");
    writeJson(perFile.translateJson, {
      sourceFile: aiFile,
      targetLanguage: TARGET_LANGUAGE,
      count: 0,
      translations: [],
    });

    await waitForControllerJobDone({
      controllerDoneJson: perFile.controllerDoneJson,
      controllerErrorJson: perFile.controllerErrorJson,
      workerErrorJson: perFile.errorJson,
      sessionErrorJson,
      illustratorState,
      timeoutMs: WAIT_TIMEOUT_MS,
      aiFile,
    });

    console.log("Done.");
    return;
  }

  console.log(`Found ${runs.length} Open Sans text runs. Translating through the Codex subscription...`);

  const translationPayload = await translateDiagramOnce(scanData, perFile);
  const finalPayload = sortTranslationsLikeRuns(scanData, translationPayload);

  writeJson(perFile.translateJson, finalPayload);

  console.log("Waiting for Illustrator to apply translations, save, and close...");

  await waitForControllerJobDone({
    controllerDoneJson: perFile.controllerDoneJson,
    controllerErrorJson: perFile.controllerErrorJson,
    workerErrorJson: perFile.errorJson,
    sessionErrorJson,
    illustratorState,
    timeoutMs: WAIT_TIMEOUT_MS,
    aiFile,
  });

  if (fs.existsSync(perFile.errorJson)) {
    const errPayload = tryReadJson(perFile.errorJson);
    if (errPayload && errPayload.message) {
      throw new Error(`Illustrator JSX reported an error after translation: ${errPayload.message}`);
    }
  }

  console.log("Done.");
}

async function processFileWithRetry({
  aiFile,
  illustratorExe,
  jsxWorker,
  sessionPaths,
  getSession,
  setSession,
  tempRoot,
  failureLogPath,
  index,
  total,
}) {
  let lastErr = null;

  for (let attempt = 1; attempt <= ILLUSTRATOR_RETRY_LIMIT; attempt++) {
    let session = getSession();

    try {
      if (!session || session.state.exited) {
        session = await startIllustratorSession({
          illustratorExe,
          controllerJsxPath: sessionPaths.controllerJsxPath,
          jobsDir: sessionPaths.jobsDir,
          jsxWorker,
          readyJson: sessionPaths.readyJson,
          stopJson: sessionPaths.stopJson,
          sessionErrorJson: sessionPaths.sessionErrorJson,
        });
        setSession(session);
      }

      await processFileInSession({
        aiFile,
        illustratorState: session.state,
        jobsDir: sessionPaths.jobsDir,
        tempRoot,
        sessionErrorJson: sessionPaths.sessionErrorJson,
      });

      return true;
    } catch (err) {
      lastErr = err;

      // If the source .ai file is genuinely missing on disk, retrying with
      // a fresh Illustrator session won't help — and tearing down a healthy
      // session would corrupt the batch. Log and move on without relaunch.
      if (!fs.existsSync(aiFile)) {
        appendFailureLog(failureLogPath, [
          `[${index + 1}/${total}] FAILED (file missing on disk)`,
          `File: ${aiFile}`,
          `Attempts: ${attempt}`,
          `Time: ${new Date().toISOString()}`,
          `Error: ${err && err.stack ? err.stack : String(err)}`,
          ""
        ]);
        console.error(`Source file missing, skipping without relaunch: ${aiFile}`);
        return false;
      }

      if (attempt < ILLUSTRATOR_RETRY_LIMIT) {
        console.warn(`Retrying after Illustrator relaunch (${attempt}/${ILLUSTRATOR_RETRY_LIMIT - 1} retry used): ${err.message}`);

        const current = getSession();
        if (current && current.child) {
          terminateChildProcess(current.child);
        }
        setSession(null);

        await sleep(1500);

        try {
          const relaunched = await startIllustratorSession({
            illustratorExe,
            controllerJsxPath: sessionPaths.controllerJsxPath,
            jobsDir: sessionPaths.jobsDir,
            jsxWorker,
            readyJson: sessionPaths.readyJson,
            stopJson: sessionPaths.stopJson,
            sessionErrorJson: sessionPaths.sessionErrorJson,
          });
          setSession(relaunched);
        } catch (relaunchErr) {
          lastErr = new Error(
            `Original file failure: ${err.message}\nRelaunch failure: ${relaunchErr.message}`
          );
        }

        continue;
      }

      appendFailureLog(failureLogPath, [
        `[${index + 1}/${total}] FAILED`,
        `File: ${aiFile}`,
        `Attempts: ${attempt}`,
        `Time: ${new Date().toISOString()}`,
        `Error: ${lastErr && lastErr.stack ? lastErr.stack : String(lastErr)}`,
        ""
      ]);

      console.error(`Failed and continuing: ${aiFile}`);
      console.error(lastErr);

      return false;
    }
  }

  return false;
}

async function main() {
  const scriptDir = __dirname;
  const jsxWorker = path.join(scriptDir, "Illustrator_Translate_Diagrams.jsx");

  if (!fs.existsSync(jsxWorker)) {
    console.error("Missing Illustrator JSX worker next to this script:");
    console.error(jsxWorker);
    process.exit(1);
  }

  if (!TARGET_LANGUAGE && CHECK_ONLY) {
    throw new Error("Set AI_TARGET_LANGUAGE for a non-interactive Stage 3 readiness check.");
  }
  if (!TARGET_LANGUAGE) TARGET_LANGUAGE = await ask("Target language: ");
  if (!TARGET_LANGUAGE || /[\r\n\0]/.test(TARGET_LANGUAGE)) {
    console.error("A valid target language is required.");
    process.exit(1);
  }
  if (!BOOK && CHECK_ONLY) {
    throw new Error("Set AI_BOOK for a non-interactive Stage 3 readiness check.");
  }
  if (!BOOK) BOOK = await ask("Book code: ");
  if (!BOOK || /[\r\n\0]/.test(BOOK)) {
    console.error("A valid book code is required.");
    process.exit(1);
  }
  GLOSSARY_RESOURCES = resolveDiagramGlossaryResources({
    programRoot: PROGRAM_ROOT,
    book: BOOK,
    targetLanguage: TARGET_LANGUAGE,
    glossaryProfile: GLOSSARY_PROFILE,
  });
  SYMBOL_RUNTIME = buildAcronymSymbolsRuntime(
    GLOSSARY_RESOURCES.symbolsWorkbook,
    GLOSSARY_RESOURCES.targetLanguage,
  );
  assertChatGptLogin();
  const modelResolution = await resolveSubscriptionModel();
  MODEL = modelResolution.model;
  if (CHECK_ONLY) {
    console.log(
      `DIAGRAM_SUBSCRIPTION_READY|model=${MODEL}|effort=${REASONING_EFFORT}|` +
      `book=${GLOSSARY_RESOURCES.book}|language=${TARGET_LANGUAGE}|profile=${GLOSSARY_RESOURCES.glossaryProfile}`
    );
    return;
  }

  const inputFolder = await ask("Folder containing .ai files: ");
  if (!inputFolder || !fs.existsSync(inputFolder)) {
    console.error("Invalid folder.");
    process.exit(1);
  }

  let illustratorExe = findIllustratorExe();
  if (!illustratorExe) {
    illustratorExe = await ask("Could not auto-find Illustrator.exe. Paste full path: ");
  }
  if (!illustratorExe || !fs.existsSync(illustratorExe)) {
    console.error("Illustrator.exe not found.");
    process.exit(1);
  }

  const aiFiles = (await listAiFiles(inputFolder)).sort();
  if (!aiFiles.length) {
    console.log("No .ai files found.");
    return;
  }

  const tempRoot = path.join(os.tmpdir(), "ai-open-sans-translate");
  ensureDir(tempRoot);
  const resourceDir = path.join(tempRoot, "resources");
  ensureDir(resourceDir);
  GLOSSARY_RESOURCES.symbolsJson = path.join(resourceDir, "diagram-acronym-symbols.json");
  writeJson(GLOSSARY_RESOURCES.symbolsJson, SYMBOL_RUNTIME);

  const failureLogPath = makeFailureLogPath(tempRoot);
  const sessionPaths = makeSessionPaths(tempRoot);

  console.log("");
  console.log("Illustrator:", illustratorExe);
  console.log("Files:", aiFiles.length);
  console.log("Model:", MODEL);
  console.log("Reasoning effort:", REASONING_EFFORT);
  console.log("Target language:", TARGET_LANGUAGE);
  console.log("Book:", GLOSSARY_RESOURCES.book);
  console.log("Glossary profile:", GLOSSARY_RESOURCES.glossaryProfile);
  console.log("Failure log:", failureLogPath);
  console.log("");

  appendFailureLog(failureLogPath, [
    "Illustrator Translate Diagrams Batch",
    `Started: ${new Date().toISOString()}`,
    `Input folder: ${inputFolder}`,
    `Illustrator: ${illustratorExe}`,
    `Files: ${aiFiles.length}`,
    `Model: ${MODEL}`,
    `Model policy: ${modelResolution.policy}`,
    `Reasoning effort: ${REASONING_EFFORT}`,
    `Target language: ${TARGET_LANGUAGE}`,
    `Book: ${GLOSSARY_RESOURCES.book}`,
    `Glossary profile: ${GLOSSARY_RESOURCES.glossaryProfile}`,
    `Word glossary: ${GLOSSARY_RESOURCES.wordsJson}`,
    `Acronym glossary: ${GLOSSARY_RESOURCES.acronymsJson}`,
    ""
  ]);

  let session = null;
  let successCount = 0;
  let failureCount = 0;

  const getSession = () => session;
  const setSession = (value) => { session = value; };

  try {
    session = await startIllustratorSession({
      illustratorExe,
      controllerJsxPath: sessionPaths.controllerJsxPath,
      jobsDir: sessionPaths.jobsDir,
      jsxWorker,
      readyJson: sessionPaths.readyJson,
      stopJson: sessionPaths.stopJson,
      sessionErrorJson: sessionPaths.sessionErrorJson,
    });

    for (let i = 0; i < aiFiles.length; i++) {
      const aiFile = aiFiles[i];
      console.log(`[${i + 1}/${aiFiles.length}] Processing: ${aiFile}`);

      const ok = await processFileWithRetry({
        aiFile,
        illustratorExe,
        jsxWorker,
        sessionPaths,
        getSession,
        setSession,
        tempRoot,
        failureLogPath,
        index: i,
        total: aiFiles.length,
      });

      if (ok) successCount++;
      else failureCount++;
    }

    console.log("");
    console.log("Batch finished.");
    console.log("Succeeded:", successCount);
    console.log("Failed:", failureCount);
    console.log("Failure log:", failureLogPath);

    appendFailureLog(failureLogPath, [
      `Finished: ${new Date().toISOString()}`,
      `Succeeded: ${successCount}`,
      `Failed: ${failureCount}`,
      ""
    ]);
    assertBatchSucceeded(failureCount, aiFiles.length, failureLogPath);
  } finally {
    try {
      writeJson(sessionPaths.stopJson, {
        stop: true,
        ts: new Date().toISOString()
      });
    } catch {}

    if (session && session.child && !session.state.exited) {
      await Promise.race([
        session.completion.catch(() => {}),
        sleep(5000)
      ]);

      if (!session.state.exited) {
        terminateChildProcess(session.child);
      }
    }
  }
}

module.exports = { assertBatchSucceeded };

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal error:");
    console.error(err);
    process.exitCode = 1;
  });
}

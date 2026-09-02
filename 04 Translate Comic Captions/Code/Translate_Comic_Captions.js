// Translate comic-caption workbook rows through the ChatGPT-authenticated Codex CLI.
// Paid API credentials are deliberately removed from every child process.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import atomicFiles from "../../Code/AtomicFiles.cjs";
import transactionalFiles from "../../Code/TransactionalFileReplacement.cjs";
import { resolveLatestSubscriptionModel } from "../../02 Translate Text/Code/Resolve-LatestSubscriptionModel.mjs";
import {
  applyPortugueseTranslations,
  assertOnlyPortugueseValuesChanged,
  readCaptionWorksheetState,
} from "./CaptionWorkbook.mjs";

const { writeJsonAtomicSync } = atomicFiles;
const { commitFileSetWithJournalSync, recoverFileSetJournalSync } = transactionalFiles;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKFLOW_DIR = path.resolve(SCRIPT_DIR, "..");
const WORKING_DIR = path.join(WORKFLOW_DIR, "Working Files");
const OUTPUT_DIR = path.join(WORKFLOW_DIR, "Output");
const WORKBOOK_PATH = path.join(WORKING_DIR, "Comics Translated Text.xlsx");
const STATE_DIR = path.join(WORKING_DIR, "subscription_state");
const STATE_PATH = path.join(STATE_DIR, "state.json");
const FINALIZATION_JOURNAL = path.join(STATE_DIR, "finalization_transaction.json");
const MODEL_POLICY = "official_latest_frontier";
const REASONING_EFFORT = "xhigh";
const TARGET_LANGUAGE = "Brazilian Portuguese";
const MAX_BATCH_ROWS = 40;
const MAX_BATCH_CHARS = 12000;
const QUERY_TIMEOUT_MS = 60 * 60 * 1000;
const EXPECTED_HEADERS = [
  "Image",
  "English Caption",
  "Spanish Description",
  "French Description",
  "Portuguese Description",
  "German Description",
];
const CODEX_CLI_JS = process.env.CODEX_CLI_JS || path.join(
  process.env.APPDATA || "",
  "npm", "node_modules", "@openai", "codex", "bin", "codex.js",
);
const CODEX_NODE_EXE = process.env.CODEX_NODE_EXE || process.execPath;

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") out.check = true;
    else if (argv[index] === "--max-batches") out.maxBatches = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (out.maxBatches !== undefined && (!Number.isSafeInteger(out.maxBatches) || out.maxBatches < 1)) {
    throw new Error("--max-batches must be a positive integer.");
  }
  return out;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomicSync(filePath, value, { trailingNewline: true });
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${filePath} | ${error.message}`, { cause: error });
  }
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
  if (!fs.existsSync(CODEX_CLI_JS)) throw new Error(`Missing official Codex CLI: ${CODEX_CLI_JS}`);
  const status = runCodex(["login", "status"]);
  const diagnostic = `${status.stdout || ""}\n${status.stderr || ""}`;
  if (status.status !== 0 || !/Logged in using ChatGPT/i.test(diagnostic)) {
    throw new Error("Comic-caption translation requires Codex logged in with ChatGPT; API-key authentication is disabled.");
  }
}

function lineBreaks(value) {
  return String(value ?? "").match(/\r\n|\r|\n/g) || [];
}

function boundaryWhitespace(value) {
  const text = String(value ?? "");
  return {
    leading: text.match(/^[ \t\r\n]*/)?.[0] || "",
    trailing: text.match(/[ \t\r\n]*$/)?.[0] || "",
  };
}

async function loadWorkbook() {
  if (!fs.existsSync(WORKBOOK_PATH)) throw new Error(`Missing caption workbook: ${WORKBOOK_PATH}`);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(WORKBOOK_PATH);
  if (workbook.worksheets.length !== 1) throw new Error("Caption workbook must contain exactly one worksheet.");
  const worksheet = workbook.worksheets[0];
  const { sourceSnapshot, pending } = readCaptionWorksheetState(worksheet, EXPECTED_HEADERS);
  return { workbook, worksheet, sourceSnapshot, pending };
}

function makeBatches(rows) {
  const batches = [];
  let current;
  for (const row of rows) {
    const chars = row.english.length + row.spanishReference.length + row.frenchReference.length;
    if (chars > MAX_BATCH_CHARS) throw new Error(`${row.id} exceeds the ${MAX_BATCH_CHARS}-character batch limit.`);
    if (!current || current.rows.length >= MAX_BATCH_ROWS || current.chars + chars > MAX_BATCH_CHARS) {
      current = { id: `batch_${String(batches.length + 1).padStart(4, "0")}`, rows: [], chars: 0 };
      batches.push(current);
    }
    current.rows.push(row);
    current.chars += chars;
  }
  return batches;
}

function responseSchema(batch) {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    additionalProperties: false,
    properties: {
      batch_id: { const: batch.id },
      translations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", enum: batch.rows.map((row) => row.id) },
            translated: { type: "string" },
          },
          required: ["id", "translated"],
        },
      },
    },
    required: ["batch_id", "translations"],
  };
}

function buildPrompt(batch) {
  return [
    "Translate the supplied English comic captions into natural Brazilian Portuguese.",
    "Return only the JSON required by the output schema. Preserve every id exactly and return each exactly once.",
    "Spanish and French are length/context references only; English is authoritative.",
    "Keep the result concise enough for the existing caption space. Do not omit, summarize, or add information.",
    "Preserve the exact line-break sequence and leading/trailing whitespace of each English caption.",
    "Write fully in Brazilian Portuguese except for true names, codes, URLs, email addresses, and filenames.",
    "Do not use tools, browse, or read files.",
    JSON.stringify({
      batch_id: batch.id,
      target_language: TARGET_LANGUAGE,
      captions: batch.rows.map((row) => ({
        id: row.id,
        image: row.image,
        english: row.english,
        spanish_reference: row.spanishReference,
        french_reference: row.frenchReference,
      })),
    }),
  ].join("\n\n");
}

function validateResponse(response, batch) {
  if (!response || response.batch_id !== batch.id || !Array.isArray(response.translations)) {
    throw new Error(`Invalid response envelope for ${batch.id}.`);
  }
  if (response.translations.length !== batch.rows.length) throw new Error(`Response row count changed for ${batch.id}.`);
  const rowsById = new Map(batch.rows.map((row) => [row.id, row]));
  const translated = new Map();
  for (const item of response.translations) {
    if (!rowsById.has(item?.id)) throw new Error(`Unexpected caption id in ${batch.id}: ${item?.id}`);
    if (translated.has(item.id)) throw new Error(`Duplicate caption id in ${batch.id}: ${item.id}`);
    if (typeof item.translated !== "string" || !item.translated.trim()) throw new Error(`Blank caption translation for ${item.id}.`);
    const source = rowsById.get(item.id).english;
    if (JSON.stringify(lineBreaks(source)) !== JSON.stringify(lineBreaks(item.translated))) {
      throw new Error(`Line breaks changed for ${item.id}.`);
    }
    if (JSON.stringify(boundaryWhitespace(source)) !== JSON.stringify(boundaryWhitespace(item.translated))) {
      throw new Error(`Boundary whitespace changed for ${item.id}.`);
    }
    translated.set(item.id, item.translated);
  }
  return translated;
}

async function queryBatch(batch, model) {
  const requestDir = path.join(STATE_DIR, "requests");
  const responseDir = path.join(STATE_DIR, "responses");
  fs.mkdirSync(requestDir, { recursive: true });
  fs.mkdirSync(responseDir, { recursive: true });
  const promptPath = path.join(requestDir, `${batch.id}.prompt.txt`);
  const schemaPath = path.join(requestDir, `${batch.id}.schema.json`);
  const responsePath = path.join(responseDir, `${batch.id}.json`);
  const rawPath = path.join(responseDir, `${batch.id}.raw.json`);
  if (fs.existsSync(responsePath)) return validateResponse(readJson(responsePath, `${batch.id} response`), batch);
  if (fs.existsSync(rawPath)) {
    try {
      const raw = readJson(rawPath, `${batch.id} interrupted response`);
      const restored = validateResponse(raw, batch);
      writeJson(responsePath, raw);
      fs.rmSync(rawPath, { force: true });
      return restored;
    } catch (error) {
      fs.renameSync(rawPath, `${rawPath}.invalid-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
      console.warn(`CAPTION_RAW_RESPONSE_QUARANTINED|batch=${batch.id}|reason=${error.message}`);
    }
  }
  const currentModel = await resolveLatestSubscriptionModel({ nodePath: CODEX_NODE_EXE, cliPath: CODEX_CLI_JS });
  if (currentModel.model !== model || currentModel.policy !== MODEL_POLICY) {
    throw new Error(`The current latest model changed from '${model}' to '${currentModel.model}'. Start a new caption run.`);
  }
  const prompt = buildPrompt(batch);
  fs.writeFileSync(promptPath, prompt, "utf8");
  writeJson(schemaPath, responseSchema(batch));
  fs.rmSync(rawPath, { force: true });
  const run = runCodex([
    "exec", "-",
    "--model", model,
    "-c", `model_reasoning_effort=\"${REASONING_EFFORT}\"`,
    "--strict-config",
    "--sandbox", "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--output-schema", schemaPath,
    "--output-last-message", rawPath,
    "--cd", STATE_DIR,
    "--color", "never",
  ], { cwd: STATE_DIR, input: prompt, timeoutMs: QUERY_TIMEOUT_MS });
  if (run.status !== 0) {
    const diagnostics = `${run.stdout || ""}\n${run.stderr || ""}`.slice(-12000);
    throw new Error(`Caption query ${batch.id} exited with code ${run.status}.\n${diagnostics}`);
  }
  const raw = readJson(rawPath, `${batch.id} raw response`);
  const restored = validateResponse(raw, batch);
  writeJson(responsePath, raw);
  fs.rmSync(rawPath, { force: true });
  return restored;
}

function timestamp() {
  return `${new Date().toISOString().replace(/[-:TZ.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
}

const cli = parseArgs(process.argv.slice(2));
const recovery = recoverFileSetJournalSync(FINALIZATION_JOURNAL);
if (recovery.recovered) console.log(`CAPTION_FINALIZATION_RECOVERED|phase=${recovery.phase}`);
const loaded = await loadWorkbook();
if (!loaded.pending.length) {
  console.log(`CAPTION_TRANSLATION_COMPLETE|pending=0|workbook=${WORKBOOK_PATH}`);
  process.exit(0);
}
assertChatGptLogin();
const modelResolution = await resolveLatestSubscriptionModel({ nodePath: CODEX_NODE_EXE, cliPath: CODEX_CLI_JS });
if (modelResolution.policy !== MODEL_POLICY || modelResolution.reasoningEffort !== REASONING_EFFORT) {
  throw new Error("Latest-model resolution does not satisfy the subscription xhigh contract.");
}
const batches = makeBatches(loaded.pending);
const plan = {
  schemaVersion: 1,
  provider: "CodexSubscription",
  model: modelResolution.model,
  modelPolicy: modelResolution.policy,
  reasoningEffort: REASONING_EFFORT,
  targetLanguage: TARGET_LANGUAGE,
  inputWorkbookSha256: sha256File(WORKBOOK_PATH),
  pendingRows: loaded.pending.map((row) => ({ id: row.id, rowNumber: row.rowNumber, english: row.english })),
  batches: batches.map((batch) => ({ id: batch.id, ids: batch.rows.map((row) => row.id) })),
};
plan.planSha256 = sha256Buffer(Buffer.from(JSON.stringify(plan), "utf8"));
console.log(`CAPTION_SUBSCRIPTION_READY|model=${modelResolution.model}|effort=${REASONING_EFFORT}|rows=${loaded.pending.length}|batches=${batches.length}`);
if (cli.check) process.exit(0);
if (fs.existsSync(STATE_PATH)) {
  const prior = readJson(STATE_PATH, "caption subscription state");
  if (prior.planSha256 !== plan.planSha256) throw new Error("Caption workbook or latest-model plan changed after this run began. Archive the old subscription_state and start again.");
} else {
  writeJson(STATE_PATH, { ...plan, status: "translating", createdAt: new Date().toISOString(), completedBatches: [] });
}

const translations = new Map();
let queried = 0;
for (const batch of batches) {
  const responsePath = path.join(STATE_DIR, "responses", `${batch.id}.json`);
  const existed = fs.existsSync(responsePath);
  if (!existed && cli.maxBatches !== undefined && queried >= cli.maxBatches) break;
  const batchTranslations = await queryBatch(batch, modelResolution.model);
  if (!existed) queried += 1;
  for (const [id, value] of batchTranslations) translations.set(id, value);
  const state = readJson(STATE_PATH, "caption subscription state");
  state.completedBatches = batches
    .filter((candidate) => fs.existsSync(path.join(STATE_DIR, "responses", `${candidate.id}.json`)))
    .map((candidate) => candidate.id);
  state.updatedAt = new Date().toISOString();
  writeJson(STATE_PATH, state);
}
if (translations.size !== loaded.pending.length) {
  console.log(`CAPTION_SUBSCRIPTION_PAUSED|translated=${translations.size}|pending=${loaded.pending.length}`);
  process.exit(2);
}

applyPortugueseTranslations(loaded.worksheet, loaded.pending, translations);
const temporaryWorkbook = path.join(STATE_DIR, `.caption-output-${process.pid}-${crypto.randomUUID()}.xlsx`);
fs.mkdirSync(STATE_DIR, { recursive: true });
let outputBytes;
try {
  await loaded.workbook.xlsx.writeFile(temporaryWorkbook);
  const verified = new ExcelJS.Workbook();
  await verified.xlsx.readFile(temporaryWorkbook);
  const verifySheet = verified.worksheets[0];
  assertOnlyPortugueseValuesChanged(verifySheet, loaded.sourceSnapshot, translations);
  outputBytes = fs.readFileSync(temporaryWorkbook);
} finally {
  fs.rmSync(temporaryWorkbook, { force: true });
}

const completedAt = new Date().toISOString();
const stamp = timestamp();
const archiveWorkbook = path.join(OUTPUT_DIR, `Comics Translated Text ${stamp}.xlsx`);
const reportPath = path.join(OUTPUT_DIR, `comic_caption_translation_${stamp}.json`);
const report = {
  schemaVersion: 1,
  provider: "CodexSubscription",
  authentication: "ChatGPT",
  model: modelResolution.model,
  modelPolicy: modelResolution.policy,
  reasoningEffort: REASONING_EFFORT,
  targetLanguage: TARGET_LANGUAGE,
  workbook: WORKBOOK_PATH,
  archivedWorkbook: archiveWorkbook,
  inputSha256: plan.inputWorkbookSha256,
  outputSha256: sha256Buffer(outputBytes),
  translatedRows: loaded.pending.length,
  batches: batches.length,
  completedAt,
};
const finalState = { ...readJson(STATE_PATH, "caption subscription state"), status: "complete", completedAt, outputSha256: report.outputSha256 };
const transaction = commitFileSetWithJournalSync(FINALIZATION_JOURNAL, [
  { filePath: WORKBOOK_PATH, data: outputBytes },
  { filePath: archiveWorkbook, data: outputBytes },
  { filePath: reportPath, data: Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8") },
  { filePath: STATE_PATH, data: Buffer.from(`${JSON.stringify(finalState, null, 2)}\n`, "utf8") },
]);
console.log(`CAPTION_TRANSLATION_COMPLETE|rows=${loaded.pending.length}|batches=${batches.length}|model=${modelResolution.model}|transaction=${transaction.transactionId}`);

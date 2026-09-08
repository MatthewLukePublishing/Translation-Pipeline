// Apply a QA-passed Step 2 XLSX payload to the isolated production ICML set.
// InDesign is intentionally not involved in the XML audit/write transaction;
// it refreshes the changed links afterward in bounded save batches.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import XLSX from "../../Code/SheetJsNode.mjs";
import transactionalFiles from "../../Code/TransactionalFileReplacement.cjs";
import editorialRules from "../../Code/TranslationEditorialRules.cjs";
import icmlGrep from "../../Code/IcmlGrep.cjs";
import grepRules from "../../Code/TranslationGrepRules.cjs";
import { assertNoIcmlLocks, assertRegularContained, hash, engineSha256 } from "./IcmlGrepJob.mjs";
import {panelManagedContent} from './PanelManagedReferences.mjs';
import { fnv1a32Utf16 } from "./ContentFingerprint.mjs";
import { normalizeContentId } from "./ContentIds.mjs";
import { assertIcmlReplacementStructure, xmlEscapePreserveIcml } from "./IcmlContent.mjs";
import { isStrictlyInside, pathsEqual } from "./PathSafety.mjs";
import { CONTENT_EXPORT_HEADERS, assertLiteralXlsxWorkbook, firstPopulatedExtraCell } from "./WorkbookContract.mjs";

const {
  commitFileSetWithJournalSync,
  recoverFileSetJournalSync,
} = transactionalFiles;

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--job") out.job = argv[++i];
    else if (argv[i] === "--dry-run") out.dryRun = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!out.job) throw new Error("--job is required.");
  return out;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not read ${label}: ${filePath} | ${error.message}`);
  }
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex").toUpperCase();
}

function sha256IcmlSet(plans, field, textRoot) {
  const hash = crypto.createHash("sha256");
  for (const plan of [...plans].sort((left, right) => left.filePath.localeCompare(right.filePath, "en"))) {
    const relativePath = path.relative(textRoot, plan.filePath).replace(/\\/g, "/");
    hash.update(relativePath, "utf8");
    hash.update("\0", "utf8");
    hash.update(plan[field], "utf8");
    hash.update("\n", "utf8");
  }
  return hash.digest("hex").toUpperCase();
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const milliseconds = String(d.getMilliseconds()).padStart(3, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${milliseconds}_${crypto.randomUUID().slice(0, 8)}`;
}

function workbookPayload(workbookPath, worksheetName) {
  const workbook = XLSX.readFile(workbookPath, { cellFormula: true, cellDates: false, raw: false });
  const effectiveSheet = worksheetName || workbook.SheetNames[0];
  const { worksheet } = assertLiteralXlsxWorkbook(workbook, workbookPath, effectiveSheet);
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
  if (rows.length < 2) throw new Error("The translated workbook has no data rows.");
  for (let col = 0; col < CONTENT_EXPORT_HEADERS.length; col += 1) {
    if (String(rows[0][col] ?? "") !== CONTENT_EXPORT_HEADERS[col]) {
      throw new Error(`Invalid workbook header in column ${col + 1}; expected ${CONTENT_EXPORT_HEADERS[col]}.`);
    }
  }
  const extra = firstPopulatedExtraCell(rows);
  if (extra) throw new Error(`Workbook contains populated data outside the four-column contract at row ${extra.row + 1}, column ${extra.column + 1}.`);

  const orderedRows = rows.slice(1).map((row, index) => ({
    row: index + 2,
    rawId: String(row[2] ?? ""),
    id: normalizeContentId(row[2]),
    content: String(row[3] ?? ""),
  }));
  const contentMap = new Map();
  const rowMap = new Map();
  for (const item of orderedRows) {
    if (!item.id && item.content) throw new Error(`Workbook row ${item.row} has Content text but no Content tag ID.`);
    if (!item.id) continue;
    if (!rowMap.has(item.id)) rowMap.set(item.id, []);
    rowMap.get(item.id).push(item.row);
    contentMap.set(item.id, item.content);
  }
  const duplicates = [...rowMap].filter(([, rowNumbers]) => rowNumbers.length > 1);
  if (duplicates.length) {
    throw new Error(`Duplicate normalized workbook Content IDs: ${duplicates.slice(0, 20).map(([id]) => id).join(", ")}`);
  }
  const payloadText = orderedRows.map((item) => `${item.rawId}\u001F${item.content}\u001E`).join("");
  const fingerprint = fnv1a32Utf16(payloadText);
  const payloadSha256 = sha256Text(payloadText);
  return { worksheet: effectiveSheet, rows, orderedRows, contentMap, fingerprint, payloadSha256 };
}

function makeReport(data) {
  return [
    "CONTENT IMPORT REPORT",
    "=====================",
    "",
    `Run time: ${data.completedAt}`,
    `Job: ${data.jobId}`,
    `Book: ${data.book}`,
    `Target language: ${data.targetLanguage}`,
    `Glossary profile: ${data.glossaryProfile}`,
    `Document: ${data.documentPath}`,
    `Workbook: ${data.workbookPath}`,
    `Worksheet: ${data.worksheet}`,
    `Content rows read from XLSX: ${data.contentRows}`,
    `Unique normalized XLSX IDs: ${data.uniqueIds}`,
    "Duplicate XLSX rows detected: 0",
    `ICML files processed: ${data.filesProcessed}`,
    `ICML files modified: ${data.filesModified}${data.dryRun ? " (dry run)" : ""}`,
    `Content matches applied: ${data.contentMatched}`,
    "XLSX IDs not found in ICML: 0",
    "Duplicate ICML IDs detected: 0",
    `Blocked: No`,
    `Dry run: ${data.dryRun ? "Yes" : "No"}`,
    "",
  ].join("\n");
}

const cli = parseArgs(process.argv.slice(2));
const jobPath = path.resolve(cli.job);
const configPath = path.join(jobPath, "job_config.json");
const manifestPath = path.join(jobPath, "job_manifest.json");
const transactionJournalPath = path.join(jobPath, "state", "content_import_transaction.json");
const config = readJson(configPath, "job configuration");
if (!config.productionWorkspace || !pathsEqual(config.jobPath, jobPath)) throw Error("Not the configured production job.");
// Recovery is a write too: scope-check its targets and require a closed edition.
if (fs.existsSync(transactionJournalPath)) {
  if (cli.dryRun) throw Error("Interrupted import requires recovery; dry-run never writes.");
  assertNoIcmlLocks(config);
  const journal = readJson(transactionJournalPath,"import journal");
  for (const item of journal.items || []) {
    const target = path.resolve(item.filePath);
    const report = isStrictlyInside(target,path.join(jobPath,"reports")) && /^(?:content_import_report_[\w]+\.txt|icml_grep_import\.json)$/u.test(path.basename(target));
    const icml = isStrictlyInside(target,config.productionWorkspace.textFolder) && path.extname(target).toLowerCase() === ".icml";
    if (!pathsEqual(target,manifestPath) && !report && !icml) throw Error("Import recovery target is outside its authorized scope.");
    for (const candidate of [target,item.backup,item.replacement]) {
      if (candidate && fs.existsSync(candidate)) assertRegularContained(path.resolve(candidate),icml ? path.resolve(config.productionWorkspace.textFolder) : jobPath);
    }
  }
  const recovery = recoverFileSetJournalSync(transactionJournalPath);
  console.warn(`IMPORT_TRANSACTION_RECOVERED|phase=${recovery.phase}`);
}
const manifest = readJson(manifestPath, "job manifest");
if (!config.productionWorkspace) throw new Error("The job is not a production workspace job.");
if (!pathsEqual(config.jobPath, jobPath)) throw new Error("The job configuration path does not match --job.");
if (manifest.status !== "ready_for_import" || manifest.qa?.status !== "passed") {
  throw new Error(`Job must be ready_for_import with passed QA; found ${manifest.status}.`);
}
if (!manifest.qa.grepProtection) throw Error("Validate first to record ICML GREP protections.");
const manifestHash = sha256(manifestPath), configHash = sha256(configPath);
const grepPolicy = grepRules.resolveGrepRules(config.targetLanguage);
if (!cli.dryRun) assertNoIcmlLocks(config);
const editorialPolicy = editorialRules.resolveEditorialRules(config.targetLanguage, "icml");
if (manifest.qa.editorialRules?.sha256 !== editorialPolicy.sha256 ||
    (config.editorialRules && config.editorialRules.sha256 !== editorialPolicy.sha256)) {
  throw new Error("ICML import requires QA under the current editorial rules; rerun the rules review and validation.");
}

const workspaceRoot = path.resolve(config.productionWorkspace.root);
const textRoot = path.resolve(config.productionWorkspace.textFolder);
const documentPath = path.resolve(config.productionWorkspace.documentPath);
if (!isStrictlyInside(textRoot, workspaceRoot) || !isStrictlyInside(documentPath, workspaceRoot)) {
  throw new Error("Production Text or INDD path is outside the isolated workspace.");
}
const workbookPath = path.resolve(config.paths.outputWorkbook);
if (!isStrictlyInside(workbookPath, jobPath)) throw new Error("Translated workbook is outside the job folder.");
if (!fs.existsSync(workbookPath)) throw new Error(`Missing translated workbook: ${workbookPath}`);
const expectedWorkbookHash = String(manifest.qa?.hashes?.outputWorkbookSha256 ?? "").toUpperCase();
const actualWorkbookHash = sha256(workbookPath);
if (!expectedWorkbookHash || expectedWorkbookHash !== actualWorkbookHash) {
  throw new Error(`Translated workbook SHA-256 differs from the QA record. Expected ${expectedWorkbookHash || "(missing)"}; found ${actualWorkbookHash}.`);
}

const payload = workbookPayload(workbookPath, manifest.workbook?.worksheet || "");
if (payload.orderedRows.length !== Number(manifest.workbook?.dataRowCount)) {
  throw new Error(`Workbook row count changed after export; expected ${manifest.workbook?.dataRowCount}, found ${payload.orderedRows.length}.`);
}
if (payload.contentMap.size !== Number(manifest.workbook?.contentIdCount)) {
  throw new Error(`Workbook Content ID count changed after export; expected ${manifest.workbook?.contentIdCount}, found ${payload.contentMap.size}.`);
}
const expectedPayload = String(manifest.qa?.hashes?.importPayloadFNV1A32UTF16 ?? "").toUpperCase();
if (!expectedPayload || expectedPayload !== payload.fingerprint) {
  throw new Error(`Workbook payload differs from the QA record. Expected ${expectedPayload || "(missing)"}; found ${payload.fingerprint}.`);
}

const expectedFiles = manifest.icmlFiles || [];
if (!expectedFiles.length || expectedFiles.length > 5000) throw new Error(`Unexpected manifest ICML file count: ${expectedFiles.length}.`);
const priorImport = manifest.invalidatedImport?.import;
// On re-import, the last ICML has already acquired intentional GREP spacing.
// Structural invariants still come from the immutable, QA-hashed source XLSX,
// not from the previously derived NBSP/NNBSP boundaries.
let sourcePayload, sourceWorkbookPath, sourceWorkbookHash;
if (priorImport) {
  sourceWorkbookPath = path.resolve(config.paths.inputWorkbook || path.join(jobPath,"input/content_export.xlsx"));
  if (!isStrictlyInside(sourceWorkbookPath,jobPath)) throw Error("Source workbook is outside the job.");
  sourceWorkbookHash = sha256(sourceWorkbookPath);
  if (sourceWorkbookHash !== manifest.qa.hashes.inputWorkbookSha256) throw Error("Source workbook changed since QA.");
  sourcePayload = workbookPayload(sourceWorkbookPath,manifest.workbook?.worksheet || "");
}
const priorFiles = new Map();
if (priorImport) {
  if (priorImport.engine !== "node-journaled-xlsx-import" ||
      !Array.isArray(priorImport.icmlFiles) || priorImport.icmlFiles.length !== expectedFiles.length ||
      !/^[A-F0-9]{64}$/i.test(priorImport.icmlAfterSetSha256 || "")) {
    throw new Error("Previous import evidence is incomplete; re-import blocked.");
  }
  const expectedPaths = new Set(expectedFiles.map(file => path.resolve(file.path).toLowerCase()));
  for (const file of priorImport.icmlFiles) {
    const key = path.resolve(String(file.path || "")).toLowerCase();
    if (!expectedPaths.has(key) || priorFiles.has(key) || !/^[A-F0-9]{64}$/i.test(file.afterSha256 || "")) {
      throw new Error("Previous import has invalid, duplicate, or unexpected ICML evidence.");
    }
    priorFiles.set(key, file);
  }
}
const seenPaths = new Set();
const touched = new Set();
const idLocations = new Map();
const plans = [];
let totalMatched = 0;
for (const expected of expectedFiles) {
  const filePath = path.resolve(String(expected.path || ""));
    if (!isStrictlyInside(filePath, textRoot) || path.extname(filePath).toLowerCase() !== ".icml") {
    throw new Error(`Manifest ICML path is outside the isolated Text folder: ${filePath}`);
  }
  const pathKey = filePath.toLowerCase();
  if (seenPaths.has(pathKey)) throw new Error(`Duplicate manifest ICML path: ${filePath}`);
  seenPaths.add(pathKey);
  assertRegularContained(filePath, textRoot);
  const originalBytes = fs.readFileSync(filePath);
  const decodedText = new TextDecoder("utf-8", {fatal:true, ignoreBOM:true}).decode(originalBytes);
  const bom = decodedText.startsWith("\uFEFF") ? "\uFEFF" : "";
  const originalText = decodedText.replace(/^\uFEFF/, "");
  const currentFingerprint = fnv1a32Utf16(originalText);
  if (!priorImport && currentFingerprint !== String(expected.fingerprint || "").toUpperCase()) {
    throw new Error(`ICML changed after export; import blocked: ${filePath}`);
  }
  const expectedSha256 = String(priorImport ? priorFiles.get(pathKey).afterSha256 : (expected.sha256 || "")).toUpperCase();
  const currentSha256 = sha256Text(originalText);
  if (!expectedSha256 || expectedSha256 !== currentSha256) {
    throw new Error(`ICML SHA-256 differs from the ${priorImport ? "previous import" : "export"} manifest; import blocked: ${filePath}`);
  }
  const contentPattern = /<Content\b([^>]*\bid\s*=\s*"([^"]+)"[^>]*?)(\/>|>([\s\S]*?)<\/Content>)/g;
  const panelManaged = panelManagedContent(originalText);
  const importedText = originalText.replace(contentPattern, (full, attrs, rawId, closing, innerContent) => {
    const id = normalizeContentId(rawId);
    if (!idLocations.has(id)) idLocations.set(id, []);
    idLocations.get(id).push(filePath);
    if (!payload.contentMap.has(id)) return full;
    touched.add(id);
    totalMatched += 1;
    const translatedContent = payload.contentMap.get(id);
    const sourceContent = closing === "/>" ? "" : innerContent;
    if (panelManaged.has(id) && translatedContent !== panelManaged.get(id)) {
      throw new Error(`Content ID ${id} is generated cross-reference text. Use the Cross-References panel encoder; direct import changes are forbidden.`);
    }
    if (sourcePayload && !sourcePayload.contentMap.has(id)) throw Error("Source workbook is missing an imported Content ID.");
    assertIcmlReplacementStructure(sourcePayload ? sourcePayload.contentMap.get(id) : sourceContent, translatedContent, `Content ID ${id} in ${filePath}`);
    const replacement = xmlEscapePreserveIcml(translatedContent);
    if (closing === "/>" && replacement === "") return `<Content${attrs}/>`;
    return `<Content${attrs}>${replacement}</Content>`;
  });
  const grepResult = icmlGrep.applyIcmlGrep(importedText, config.targetLanguage, manifest.qa.grepProtection);
  const updatedText = grepResult.text;
  if (icmlGrep.applyIcmlGrep(updatedText,config.targetLanguage,manifest.qa.grepProtection).changed) throw Error("ICML GREP did not reach a stable result.");
  plans.push({
    filePath,
    originalBytes,
    bom,
    grep: { records: grepResult.records, changed: grepResult.changed, protectedContents: grepResult.protectedContents },
    originalText,
    updatedText,
    originalSha256: sha256Text(originalText),
    updatedSha256: sha256Text(updatedText),
    changed: updatedText !== originalText,
  });
}

const duplicateIcmlIds = [...idLocations].filter(([, locations]) => locations.length > 1).map(([id]) => id);
if (duplicateIcmlIds.length) throw new Error(`Duplicate ICML Content IDs: ${duplicateIcmlIds.slice(0, 20).join(", ")}`);
const unmatched = [...payload.contentMap.keys()].filter((id) => !touched.has(id));
if (unmatched.length) throw new Error(`Workbook Content IDs not found in ICML: ${unmatched.slice(0, 20).join(", ")}`);
if (totalMatched !== Number(manifest.workbook?.contentIdCount)) {
  throw new Error(`Matched Content count differs from the export contract; expected ${manifest.workbook?.contentIdCount}, found ${totalMatched}.`);
}

const filesModified = plans.filter((plan) => plan.changed).length;
const completedAt = new Date().toISOString();
const icmlBeforeSetSha256 = sha256IcmlSet(plans, "originalSha256", textRoot);
const icmlAfterSetSha256 = sha256IcmlSet(plans, "updatedSha256", textRoot);
if (priorImport && icmlBeforeSetSha256 !== priorImport.icmlAfterSetSha256.toUpperCase()) {
  throw new Error("ICML set does not match the previous successful import; re-import blocked.");
}
const reportData = {
  completedAt,
  jobId: config.jobId,
  book: config.book,
  targetLanguage: config.targetLanguage,
  glossaryProfile: config.glossaryProfile,
  documentPath,
  workbookPath,
  worksheet: payload.worksheet,
  contentRows: payload.orderedRows.length,
  uniqueIds: payload.contentMap.size,
  filesProcessed: plans.length,
  filesModified,
  contentMatched: totalMatched,
  dryRun: cli.dryRun,
};
if (cli.dryRun) {
  console.log(`IMPORT_DRY_RUN_PASSED|files=${plans.length}|modified=${filesModified}|matched=${totalMatched}|grepRules=${grepPolicy.applicable.length}|grepChanges=${plans.reduce((n,p)=>n+p.grep.records.reduce((s,r)=>s+r.changes,0),0)}|payload=${payload.fingerprint}`);
  process.exit(0);
}

const reportPath = path.join(jobPath, "reports", `content_import_report_${timestamp()}.txt`);
const grepReportPath = path.join(jobPath, "reports", "icml_grep_import.json");
for (const plan of plans) {
  if (!fs.readFileSync(plan.filePath).equals(plan.originalBytes)) {
    throw new Error(`ICML changed during the import audit: ${plan.filePath}`);
  }
}
assertNoIcmlLocks(config);
if (sha256(workbookPath) !== actualWorkbookHash || sha256(configPath) !== configHash || sha256(manifestPath) !== manifestHash) throw Error("Job/workbook changed during import planning.");
if (sourceWorkbookPath && sha256(sourceWorkbookPath) !== sourceWorkbookHash) throw Error("Source workbook changed during import planning.");
const updatedManifest = structuredClone(manifest);
updatedManifest.status = "imported";
updatedManifest.updatedAt = completedAt;
updatedManifest.import = {
  grep: {
    reportPath: grepReportPath,
    status: "passed", method: "offline_icml_grep", policySha256: grepPolicy.sha256,
    engineSha256: engineSha256(),
    protectionSha256: hash(JSON.stringify(manifest.qa.grepProtection)),
    notApplicable: grepPolicy.notApplicable,
    files: plans.map(plan => ({ path: plan.filePath, ...plan.grep })),
    // QA hashes describe the approved translation input, not an unrecorded edit.
    derivation: "QA workbook -> Content-ID import -> protected, spacing-only ICML GREP",
  },
  editorialRules: { version: editorialPolicy.version, sha256: editorialPolicy.sha256 },
  completedAt,
  documentPath,
  workbookPath,
  reportPath,
  filesProcessed: plans.length,
  filesModified,
  contentMatched: totalMatched,
  engine: "node-journaled-xlsx-import",
  transactionJournal: transactionJournalPath,
  workbookSha256: actualWorkbookHash,
  payloadFNV1A32UTF16: payload.fingerprint,
  payloadSha256: payload.payloadSha256,
  icmlBeforeSetSha256,
  icmlAfterSetSha256,
  icmlFiles: plans.map((plan) => ({
    path: plan.filePath,
    beforeSha256: plan.originalSha256,
    afterSha256: plan.updatedSha256,
    changed: plan.changed,
  })),
};
const replacements = [
  ...plans.filter((plan) => plan.changed).map((plan) => ({ filePath: plan.filePath, data: plan.bom + plan.updatedText, options: "utf8" })),
  { filePath: reportPath, data: makeReport(reportData), options: "utf8" },
  { filePath: grepReportPath, data: JSON.stringify({ ...updatedManifest.import.grep, workbookSha256: actualWorkbookHash, icmlAfterSetSha256 }, null, 2) + "\n", options: "utf8" },
  { filePath: manifestPath, data: `${JSON.stringify(updatedManifest, null, 2)}\n`, options: "utf8" },
];
try {
  commitFileSetWithJournalSync(transactionJournalPath, replacements);
} catch (error) {
  const recovery = error.recoveryError ? ` | recovery failed: ${error.recoveryError.message}` : "";
  throw new Error(`Import commit failed; journaled rollback attempted. ${error.message}${recovery}`);
}

console.log(`IMPORT_COMPLETE|files=${plans.length}|modified=${filesModified}|matched=${totalMatched}|report=${reportPath}`);

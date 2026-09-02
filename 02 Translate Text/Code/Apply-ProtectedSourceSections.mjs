// Restore configured source-language-only sections in the Step 2 workbook and
// isolated ICML. Spreadsheet reads/writes use the bundled artifact-tool.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import XLSX from "xlsx";
import fileUtilities from "../../Code/FileUtilities.cjs";
import transactionalFiles from "../../Code/TransactionalFileReplacement.cjs";
import { normalizeContentId } from "./ContentIds.mjs";
import { buildContentGroups, compositeFromRows } from "./ContentGroups.mjs";
import { xmlEscapePreserveIcml } from "./IcmlContent.mjs";
import { isStrictlyInside, pathsEqual } from "./PathSafety.mjs";
import { loadProtectedSourceManifest } from "./ProtectedSourceManifest.mjs";
import {
  assertContentExportWorkbook as assertWorkbook,
  assertLiteralXlsxWorkbook,
  normalizeWorkbookCell as normalizeCell,
} from "./WorkbookContract.mjs";

const { readJsonFileRequired } = fileUtilities;
const { commitFileSetWithJournalSync, recoverFileSetJournalSync } = transactionalFiles;

function parseArgs(argv) {
  const result = { workbook: true, icml: true };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--job") result.job = argv[++index];
    else if (argv[index] === "--workbook-only") result.icml = false;
    else if (argv[index] === "--icml-only") result.workbook = false;
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.job) throw new Error("Use --job <translation-job-folder>.");
  return result;
}

function readJson(filePath, label) {
  return readJsonFileRequired(filePath, label, "read");
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function jsonBuffer(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadProtection(jobPath, config) {
  const { contentIds, sourceById, manifest, manifestPath } = loadProtectedSourceManifest(
    jobPath,
    config.protectedSourceContentManifest,
    readJson,
  );
  const stories = Array.isArray(manifest.stories) ? manifest.stories : [];
  if (!stories.length) throw new Error("Protected source manifest has no ICML stories.");
  const storyIds = new Set();
  for (const story of stories) {
    for (const id of (story.matches || []).flatMap((match) => match.contentIds || []).map(normalizeContentId).filter(Boolean)) {
      if (storyIds.has(id)) throw new Error(`Protected source manifest repeats Content ID ${id} across stories.`);
      storyIds.add(id);
    }
  }
  if (storyIds.size !== contentIds.size) throw new Error("Protected source story index does not cover the exact protected Content-ID set.");
  return { manifestPath, manifest, contentIds, sourceById, stories };
}

function rebuildComposites(sourceValues, outputValues) {
  for (let row = 1; row < outputValues.length; row += 1) outputValues[row][1] = "";
  for (const group of buildContentGroups(sourceValues)) {
    outputValues[group.startRow][1] = compositeFromRows(outputValues, group);
  }
}

const cli = parseArgs(process.argv.slice(2));
const jobPath = path.resolve(cli.job);
const transactionJournal = path.join(jobPath, "state", "protected_source_transaction.json");
const recovery = recoverFileSetJournalSync(transactionJournal);
if (recovery.recovered) {
  console.log(`PROTECTED_SOURCE_TRANSACTION_RECOVERED|phase=${recovery.phase}`);
}
const configPath = path.join(jobPath, "job_config.json");
const manifestPath = path.join(jobPath, "job_manifest.json");
const config = readJson(configPath, "job configuration");
const manifest = readJson(manifestPath, "job manifest");
if (!pathsEqual(String(config.jobPath || ""), jobPath)) throw new Error("Job configuration path does not match --job.");
if (!config.productionWorkspace) throw new Error("Protected source restoration requires a production workspace job.");
const protection = loadProtection(jobPath, config);
const workspaceRoot = path.resolve(String(config.productionWorkspace.root || ""));
const inputPath = path.resolve(String(config.paths?.inputWorkbook || path.join(jobPath, "input", "content_export.xlsx")));
const outputPath = path.resolve(String(config.paths?.outputWorkbook || path.join(jobPath, "output", "content_import.xlsx")));
const textFolder = path.resolve(String(config.productionWorkspace.textFolder || ""));
if (!isStrictlyInside(textFolder, workspaceRoot)) {
  throw new Error("Text folder is outside the isolated production workspace.");
}
if (!isStrictlyInside(inputPath, jobPath) || !isStrictlyInside(outputPath, jobPath)) {
  throw new Error("Source or translated workbook is outside the translation job.");
}
const stateFolder = path.join(jobPath, "state", "protected_source_checkpoints");
const reportFolder = path.join(jobPath, "reports");
fs.mkdirSync(stateFolder, { recursive: true });
fs.mkdirSync(reportFolder, { recursive: true });

const artifactNodeModules = process.env.CODEX_ARTIFACT_NODE_MODULES;
if (!artifactNodeModules) throw new Error("CODEX_ARTIFACT_NODE_MODULES was not supplied.");
const requireFromRuntime = createRequire(path.join(artifactNodeModules, "package.json"));
const { FileBlob, SpreadsheetFile } = requireFromRuntime("@oai/artifact-tool");

assertLiteralXlsxWorkbook(XLSX.readFile(inputPath, { cellFormula: true, cellText: false, cellDates: false }), inputPath);
const inputWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sourceValues = inputWorkbook.worksheets.getItemAt(0).getUsedRange(true).values.map((row) => row.map(normalizeCell));
assertWorkbook(sourceValues, inputPath);
const workbookSourceById = new Map();
for (let row = 1; row < sourceValues.length; row += 1) {
  const id = normalizeContentId(sourceValues[row]?.[2]);
  if (!id) throw new Error(`Blank Content tag at source workbook row ${row + 1}.`);
  if (workbookSourceById.has(id)) throw new Error(`Duplicate source Content tag ${id}.`);
  workbookSourceById.set(id, normalizeCell(sourceValues[row]?.[3]));
}
const expectedProtectedIds = [...protection.contentIds];
const absentSourceIds = expectedProtectedIds.filter((id) => !workbookSourceById.has(id));
if (absentSourceIds.length) throw new Error(`Protected Content IDs are absent from the source workbook: ${absentSourceIds.slice(0, 20).join(", ")}`);
for (const id of expectedProtectedIds) {
  if (workbookSourceById.get(id) !== protection.sourceById.get(id)) {
    throw new Error(`Source workbook no longer matches the protected snapshot for Content ID ${id}.`);
  }
}

const timestamp = `${new Date().toISOString().replace(/[-:TZ.]/g, "")}-${crypto.randomUUID().slice(0, 8)}`;
const replacements = [];
let workbookRowsRestored = 0;
let workbookBackup = "";
let workbookOutputSha256 = "";
if (cli.workbook) {
  if (!fs.existsSync(outputPath)) throw new Error(`Missing translated output workbook: ${outputPath}`);
  assertLiteralXlsxWorkbook(XLSX.readFile(outputPath, { cellFormula: true, cellText: false, cellDates: false }), outputPath);
  const translatedWorkbook = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
  const translatedValues = translatedWorkbook.worksheets.getItemAt(0).getUsedRange(true).values.map((row) => row.map(normalizeCell));
  const worksheet = inputWorkbook.worksheets.getItemAt(0);
  const outputValues = translatedValues.map((row) => [...row]);
  assertWorkbook(outputValues, outputPath);
  if (outputValues.length !== sourceValues.length) throw new Error("Source and output workbook row counts differ.");
  for (let row = 1; row < outputValues.length; row += 1) {
    if (normalizeContentId(outputValues[row]?.[2]) !== normalizeContentId(sourceValues[row]?.[2])) {
      throw new Error(`Content identifier mismatch at workbook row ${row + 1}: source=${sourceValues[row]?.[2]}; output=${outputValues[row]?.[2]}.`);
    }
    outputValues[row][0] = sourceValues[row][0];
    outputValues[row][2] = sourceValues[row][2];
    const sourceId = normalizeContentId(sourceValues[row]?.[2]);
    if (protection.contentIds.has(sourceId)) {
      outputValues[row][3] = protection.sourceById.get(sourceId);
      workbookRowsRestored += 1;
    }
  }
  rebuildComposites(sourceValues, outputValues);
  worksheet.getRangeByIndexes(0, 0, outputValues.length, 4).values = outputValues;
  workbookBackup = path.join(stateFolder, `${path.basename(outputPath, ".xlsx")}.pre_protected_source_${timestamp}.xlsx`);
  const originalWorkbookBytes = fs.readFileSync(outputPath);
  const outputBlob = await SpreadsheetFile.exportXlsx(inputWorkbook);
  const temporary = path.join(stateFolder, `.protected-workbook-${process.pid}-${crypto.randomUUID()}.xlsx`);
  try {
    await outputBlob.save(temporary);
    const excelSafeWorkbook = XLSX.readFile(temporary, { cellDates: false, cellStyles: true });
    const excelSafeWorksheet = excelSafeWorkbook.Sheets[excelSafeWorkbook.SheetNames[0]];
    for (let row = 0; row < outputValues.length; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        if (outputValues[row][column] === "") {
          delete excelSafeWorksheet[XLSX.utils.encode_cell({ r: row, c: column })];
        }
      }
    }
    XLSX.writeFile(excelSafeWorkbook, temporary, { bookType: "xlsx", compression: true, bookSST: true, cellStyles: true });
    assertLiteralXlsxWorkbook(
      XLSX.readFile(temporary, { cellFormula: true, cellText: false, cellDates: false }),
      temporary,
    );
    const verified = await SpreadsheetFile.importXlsx(await FileBlob.load(temporary));
    const verifyValues = verified.worksheets.getItemAt(0).getUsedRange(true).values.map((row) => row.map(normalizeCell));
    assertWorkbook(verifyValues, temporary);
    if (verifyValues.length !== outputValues.length) throw new Error("Protected workbook row count changed during round trip.");
    for (let row = 1; row < verifyValues.length; row += 1) {
      const sourceId = normalizeContentId(sourceValues[row]?.[2]);
      if (verifyValues[row][0] !== sourceValues[row][0] || verifyValues[row][2] !== sourceValues[row][2]) {
        throw new Error(`Protected identifier columns changed during XLSX round trip at row ${row + 1}.`);
      }
      if (!normalizeCell(sourceValues[row][0]).length && verifyValues[row][1] !== "") {
        throw new Error(`Continuation-row composite cell changed during XLSX round trip at row ${row + 1}.`);
      }
      if (protection.contentIds.has(sourceId) && verifyValues[row][3] !== protection.sourceById.get(sourceId)) {
        throw new Error(`Protected source text changed during XLSX round trip for Content ID ${sourceId}.`);
      }
    }
    const translatedWorkbookBytes = fs.readFileSync(temporary);
    workbookOutputSha256 = sha256Buffer(translatedWorkbookBytes);
    replacements.push(
      { filePath: workbookBackup, data: originalWorkbookBytes },
      { filePath: outputPath, data: translatedWorkbookBytes },
    );
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

const icmlResults = [];
if (cli.icml) {
  for (const story of protection.stories) {
    const relativePath = String(story.relativePath || story.file || "");
    const targetPath = path.resolve(textFolder, relativePath);
    if (!isStrictlyInside(targetPath, textFolder)) {
      throw new Error(`Protected story is outside the Text folder: ${targetPath}`);
    }
    if (!fs.existsSync(targetPath)) throw new Error(`Missing protected target story: ${targetPath}`);
    const storyIds = new Set(
      (Array.isArray(story.matches) ? story.matches : [])
        .flatMap((match) => Array.isArray(match.contentIds) ? match.contentIds : [])
        .map(normalizeContentId)
        .filter(Boolean)
    );
    if (!storyIds.size) throw new Error(`Protected story has no Content IDs: ${targetPath}`);
    const originalFileBytes = fs.readFileSync(targetPath);
    const original = originalFileBytes.toString("utf8").replace(/^\uFEFF/, "");
    const seen = new Set();
    const pattern = /<Content\b([^>]*\bid\s*=\s*"([^"]+)"[^>]*?)(\/\>|>([\s\S]*?)<\/Content>)/g;
    const updated = original.replace(pattern, (full, attrs, rawId) => {
      const id = normalizeContentId(rawId);
      if (!storyIds.has(id)) return full;
      if (!protection.sourceById.has(id)) throw new Error(`Protected Content ID ${id} is absent from the immutable source snapshot.`);
      if (seen.has(id)) throw new Error(`Protected Content ID ${id} occurs more than once in ${targetPath}.`);
      seen.add(id);
      return `<Content${attrs}>${xmlEscapePreserveIcml(protection.sourceById.get(id))}</Content>`;
    });
    const expected = [...storyIds];
    const missing = expected.filter((id) => !seen.has(id));
    if (missing.length) throw new Error(`Protected Content IDs missing from ${targetPath}: ${missing.slice(0, 20).join(", ")}`);
    const relativeHash = crypto.createHash("sha256").update(relativePath, "utf8").digest("hex").slice(0, 12);
    const backupPath = path.join(stateFolder, `${path.basename(targetPath)}.${relativeHash}.pre_protected_source_${timestamp}.icml`);
    const updatedBytes = Buffer.from(updated, "utf8");
    replacements.push(
      { filePath: backupPath, data: originalFileBytes },
      { filePath: targetPath, data: updatedBytes },
    );
    icmlResults.push({
      relativePath,
      targetPath,
      backupPath,
      protectedIds: seen.size,
      changed: updated !== original,
      beforeSha256: sha256Buffer(originalFileBytes),
      afterSha256: sha256Buffer(updatedBytes),
    });
  }
}

const completedAt = new Date().toISOString();
const report = {
  schemaVersion: 2,
  completedAt,
  jobId: config.jobId,
  book: config.book,
  targetLanguage: config.targetLanguage,
  policy: "source_language_verbatim",
  discoveryManifest: protection.manifestPath,
  selectors: protection.manifest.selectors,
  workbook: cli.workbook ? {
    inputPath,
    outputPath,
    backupPath: workbookBackup,
    rowsRestored: workbookRowsRestored,
    outputSha256: workbookOutputSha256,
  } : { skipped: true },
  icml: cli.icml ? icmlResults : { skipped: true },
};
const reportPath = path.join(reportFolder, `protected_source_report_${timestamp}.json`);
manifest.protectedSourceContent = {
  completedAt,
  policy: report.policy,
  selectors: protection.manifest.selectors,
  workbookRowsRestored,
  icmlStoriesRestored: icmlResults.length,
  reportPath,
};
replacements.push(
  { filePath: reportPath, data: jsonBuffer(report) },
  { filePath: manifestPath, data: jsonBuffer(manifest) },
);
const transaction = commitFileSetWithJournalSync(transactionJournal, replacements);
if (cli.workbook && sha256(outputPath) !== workbookOutputSha256) {
  throw new Error("Protected workbook hash differs after the committed file-set transaction.");
}
for (const item of icmlResults) {
  if (sha256(item.targetPath) !== item.afterSha256) {
    throw new Error(`Protected ICML hash differs after the committed file-set transaction: ${item.targetPath}`);
  }
}
console.log(`PROTECTED_SOURCE_APPLIED|rows=${workbookRowsRestored}|stories=${icmlResults.length}|report=${reportPath}`);
console.log(`PROTECTED_SOURCE_TRANSACTION_OK|id=${transaction.transactionId}|files=${transaction.filesCommitted}`);

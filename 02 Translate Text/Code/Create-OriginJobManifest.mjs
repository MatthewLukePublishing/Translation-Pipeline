// Create an exported Step 2 manifest from a standardized Origin workbook + local ICML snapshot.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import XLSX from "../../Code/SheetJsNode.mjs";
import atomicFiles from "../../Code/AtomicFiles.cjs";
import { fnv1a32Utf16 } from "./ContentFingerprint.mjs";
import { normalizeContentId } from "./ContentIds.mjs";
import { buildContentGroups } from "./ContentGroups.mjs";
import { isStrictlyInside, pathsEqual } from "./PathSafety.mjs";
import { isProductionJobLocation } from "./SourcePackage.mjs";
import { CONTENT_EXPORT_HEADERS, assertLiteralXlsxWorkbook, firstPopulatedExtraCell } from "./WorkbookContract.mjs";

const { writeJsonAtomicSync } = atomicFiles;

function parseArgs(argv) {
  const jobIndex = argv.indexOf("--job");
  if (jobIndex < 0 || !argv[jobIndex + 1]) throw new Error("Use --job <translation-job-folder>.");
  return { job: path.resolve(argv[jobIndex + 1]) };
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, value) {
  writeJsonAtomicSync(filePath, value, { trailingNewline: true });
}

function normalize(value) {
  return value === null || value === undefined ? "" : String(value).replace(/\r\n/g, "\n");
}

function collectFiles(root) {
  const output = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) output.push(...collectFiles(child));
    else if (/\.icml$/i.test(entry.name)) output.push(child);
  }
  return output;
}

function pageFromFilename(filename) {
  return String(filename).match(/Page_(\d+)/i)?.[1] || "";
}

const cli = parseArgs(process.argv.slice(2));
const configPath = path.join(cli.job, "job_config.json");
const manifestPath = path.join(cli.job, "job_manifest.json");
if (fs.existsSync(manifestPath)) throw new Error(`Job manifest already exists: ${manifestPath}`);
const config = readJson(configPath, "job configuration");
if (!pathsEqual(String(config.jobPath || ""), cli.job)) throw new Error("Job path mismatch.");
if (!config.productionWorkspace) throw new Error("Origin manifests are only supported for production workspaces.");

const inputPath = path.join(cli.job, "input", "content_export.xlsx");
const workspaceRoot = path.resolve(String(config.productionWorkspace.root || ""));
const textFolder = path.resolve(String(config.productionWorkspace.textFolder || ""));
const centralJobsRoot = fileURLToPath(new URL("../Jobs/", import.meta.url));
if (!isProductionJobLocation(cli.job, workspaceRoot, centralJobsRoot) || !isStrictlyInside(textFolder, workspaceRoot)) {
  throw new Error("Translation job or Text folder is outside its authorized boundary.");
}
if (!isStrictlyInside(inputPath, cli.job)) throw new Error("Origin workbook is outside the translation job.");
const artifactNodeModules = process.env.CODEX_ARTIFACT_NODE_MODULES;
if (!artifactNodeModules) throw new Error("CODEX_ARTIFACT_NODE_MODULES was not supplied.");
const requireFromRuntime = createRequire(path.join(artifactNodeModules, "package.json"));
const { FileBlob, SpreadsheetFile } = requireFromRuntime("@oai/artifact-tool");

assertLiteralXlsxWorkbook(
  XLSX.readFile(inputPath, { cellFormula: true, cellText: false, cellDates: false }),
  inputPath,
);
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheet = workbook.worksheets.getItemAt(0);
const values = sheet.getUsedRange(true).values.map((row) => row.map(normalize));
const headers = (values[0] || []).slice(0, 4);
if (headers.length !== 4 || headers.some((header, index) => header !== CONTENT_EXPORT_HEADERS[index])) {
  throw new Error("Origin workbook does not use the exact four-column Step 2 contract.");
}
const extra = firstPopulatedExtraCell(values);
if (extra) throw new Error(`Origin workbook contains populated data outside the four-column contract at row ${extra.row + 1}, column ${extra.column + 1}.`);
const workbookIds = new Set();
const workbookContent = new Map();
for (let row = 1; row < values.length; row += 1) {
  const contentId = normalizeContentId(values[row]?.[2]);
  if (!contentId) throw new Error(`Blank Content tag at workbook row ${row + 1}.`);
  if (workbookIds.has(contentId)) throw new Error(`Duplicate workbook Content tag: ${contentId}`);
  workbookIds.add(contentId);
  workbookContent.set(contentId, normalize(values[row]?.[3]));
}
const paragraphStyleRangeCount = buildContentGroups(values).length;

const files = collectFiles(textFolder).map((filePath) => ({
  path: filePath,
  name: path.basename(filePath),
  page: pageFromFilename(path.basename(filePath)),
}));
files.sort((left, right) => {
  const leftPage = Number.parseInt(left.page || "999999", 10);
  const rightPage = Number.parseInt(right.page || "999999", 10);
  return leftPage === rightPage ? left.name.localeCompare(right.name) : leftPage - rightPage;
});
if (!files.length || files.length > 5000) throw new Error(`Unexpected ICML file count: ${files.length}`);

const icmlIds = new Set();
const manifestFiles = [];
for (const file of files) {
  // Import_Translation_Workbook compares the logical ICML text without an
  // optional UTF-8 BOM. Build the origin fingerprint from the same text so an
  // unchanged BOM-bearing source cannot fail the later integrity check.
  const text = fs.readFileSync(file.path, "utf8").replace(/^\uFEFF/, "");
  const ids = [];
  const contentPattern = /<Content\b([^>]*\bid\s*=\s*"([^"]+)"[^>]*?)(\/\>|>([\s\S]*?)<\/Content>)/g;
  let match;
  while ((match = contentPattern.exec(text)) !== null) {
    const id = normalizeContentId(match[2]);
    if (icmlIds.has(id)) throw new Error(`Duplicate ICML Content id '${id}' in ${file.path}`);
    icmlIds.add(id);
    ids.push(id);
    if (!workbookContent.has(id)) throw new Error(`ICML Content ID '${id}' is absent from the Origin workbook.`);
    const icmlContent = match[3] === "/>" ? "" : match[4];
    if (icmlContent !== workbookContent.get(id)) throw new Error(`Origin workbook/ICML text differs for Content ID '${id}'.`);
  }
  manifestFiles.push({
    name: file.name,
    page: file.page,
    path: file.path,
    fingerprint: fnv1a32Utf16(text),
    fingerprintAlgorithm: "FNV1A32_UTF16",
    sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex").toUpperCase(),
    contentIdCount: ids.length,
    outerPsrCount: (text.match(/<ParagraphStyleRange\b/gi) || []).length,
  });
}
if (icmlIds.size !== workbookIds.size) {
  throw new Error(`Origin workbook/ICML Content-ID count mismatch: workbook=${workbookIds.size}; ICML=${icmlIds.size}`);
}
for (const id of workbookIds) if (!icmlIds.has(id)) throw new Error(`Workbook Content tag not found in local ICML: ${id}`);

const now = new Date().toISOString();
const manifest = {
  schemaVersion: 1,
  jobId: String(config.jobId || ""),
  jobPath: cli.job,
  book: String(config.book || ""),
  targetLanguage: String(config.targetLanguage || ""),
  glossaryProfile: String(config.glossaryProfile || ""),
  glossaryTermKey: String(config.glossaryTermKey || ""),
  glossaryDefinitionKey: String(config.glossaryDefinitionKey || ""),
  status: "exported",
  createdAt: now,
  updatedAt: now,
  document: {
    name: path.basename(String(config.productionWorkspace.documentPath || "")),
    path: String(config.productionWorkspace.documentPath || ""),
  },
  workbook: {
    worksheet: sheet.name,
    inputPath,
    rowCount: values.length,
    dataRowCount: values.length - 1,
    contentIdCount: workbookIds.size,
    paragraphStyleRangeCount,
  },
  icmlFingerprintAlgorithm: "FNV1A32_UTF16",
  icmlStrongHashAlgorithm: "SHA-256_UTF8",
  icmlFiles: manifestFiles,
  export: {
    method: "standardized_origin_package",
    duplicateLinkedPathsSkipped: 0,
    filesProcessed: manifestFiles.length,
    filesModified: 0,
  },
};
writeJson(manifestPath, manifest);
console.log(`ORIGIN_MANIFEST_CREATED|job=${cli.job}|rows=${values.length - 1}|contentIds=${workbookIds.size}|icml=${manifestFiles.length}`);

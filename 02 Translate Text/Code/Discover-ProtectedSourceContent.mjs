// Resolve source-language-only content from ICML paragraph-style selectors.
// The result is an exact, auditable Content-ID manifest used by translators,
// validators, and the transactional importer. No book filename or ID is assumed.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import atomicFiles from "../../Code/AtomicFiles.cjs";
import { normalizeContentId } from "./ContentIds.mjs";

const { writeJsonAtomicSync } = atomicFiles;

function parseArgs(argv) {
  const result = { paragraphStyles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--text") result.text = argv[++index];
    else if (argv[index] === "--output") result.output = argv[++index];
    else if (argv[index] === "--paragraph-style") result.paragraphStyles.push(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!result.text || !result.output) throw new Error("Use --text <Text-folder> --output <manifest.json>.");
  if (!result.paragraphStyles.length) throw new Error("Supply at least one --paragraph-style selector.");
  return result;
}

function walkIcml(folder, output) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) walkIcml(fullPath, output);
    else if (/\.icml$/i.test(entry.name)) output.push(fullPath);
  }
}

function decodeStyle(value) {
  let decoded = String(value || "");
  try { decoded = decodeURIComponent(decoded); }
  catch { /* Preserve malformed percent sequences as literal style text. */ }
  decoded = decoded.replace(/^ParagraphStyle\//i, "");
  return decoded;
}

function styleLeaf(value) {
  const decoded = decodeStyle(value);
  const parts = decoded.split(/[:/]/);
  return parts[parts.length - 1];
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJsonAtomicSync(filePath, value, { trailingNewline: true });
}

const cli = parseArgs(process.argv.slice(2));
const textRoot = path.resolve(cli.text);
const outputPath = path.resolve(cli.output);
if (!fs.existsSync(textRoot) || !fs.statSync(textRoot).isDirectory()) throw new Error(`Missing Text folder: ${textRoot}`);
const selectors = [...new Set(cli.paragraphStyles.map((value) => String(value || "").trim()).filter(Boolean))];
const selectorSpecs = selectors.map((value) => ({
  requested: value,
  exactPath: /[:/]/.test(value),
  key: value.toLocaleLowerCase("en-US"),
}));
const matchedSelectorKeys = new Set();
const matchedStylesBySelector = new Map(selectorSpecs.map((selector) => [selector.key, new Set()]));
const files = [];
walkIcml(textRoot, files);
files.sort((left, right) => left.localeCompare(right, "en-US", { sensitivity: "base" }));

const contentIds = [];
const contentSnapshots = [];
const idLocations = new Map();
const stories = [];
const paragraphPattern = /<ParagraphStyleRange\b([^>]*)>([\s\S]*?)<\/ParagraphStyleRange>/g;
const styleAttributePattern = /\bAppliedParagraphStyle\s*=\s*"([^"]+)"/i;
const contentPattern = /<Content\b([^>]*\bid\s*=\s*"([^"]+)"[^>]*?)(\/\>|>([\s\S]*?)<\/Content>)/g;
for (const filePath of files) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const relativePath = path.relative(textRoot, filePath).replace(/\\/g, "/");
  const fileMatches = [];
  paragraphPattern.lastIndex = 0;
  let paragraphMatch;
  while ((paragraphMatch = paragraphPattern.exec(text)) !== null) {
    const styleMatch = styleAttributePattern.exec(paragraphMatch[1]);
    if (!styleMatch) continue;
    const appliedStyle = decodeStyle(styleMatch[1]);
    const leaf = styleLeaf(styleMatch[1]);
    const selector = selectorSpecs.find((candidate) => (
      candidate.exactPath
        ? appliedStyle.toLocaleLowerCase("en-US") === candidate.key
        : leaf.toLocaleLowerCase("en-US") === candidate.key
    ));
    if (!selector) continue;
    matchedSelectorKeys.add(selector.key);
    matchedStylesBySelector.get(selector.key).add(appliedStyle);
    const rangeIds = [];
    contentPattern.lastIndex = 0;
    let contentMatch;
    while ((contentMatch = contentPattern.exec(paragraphMatch[2])) !== null) {
      const id = normalizeContentId(contentMatch[2]);
      if (!id) continue;
      const sourceText = contentMatch[3] === "/>" ? "" : contentMatch[4];
      rangeIds.push(id);
      contentIds.push(id);
      contentSnapshots.push({
        id,
        sourceText,
        sourceTextSha256: crypto.createHash("sha256").update(sourceText, "utf8").digest("hex").toUpperCase(),
        relativePath,
        appliedParagraphStyle: appliedStyle,
      });
      if (!idLocations.has(id)) idLocations.set(id, []);
      idLocations.get(id).push(filePath);
    }
    if (rangeIds.length) {
      fileMatches.push({
        paragraphStyle: selector.requested,
        appliedParagraphStyle: appliedStyle,
        contentIds: rangeIds,
      });
    }
  }
  if (fileMatches.length) {
    stories.push({
      file: path.basename(filePath),
      relativePath,
      sourceStorySha256: crypto.createHash("sha256").update(text, "utf8").digest("hex").toUpperCase(),
      matches: fileMatches,
      contentIdCount: fileMatches.reduce((sum, item) => sum + item.contentIds.length, 0),
    });
  }
}

const missingSelectors = selectors.filter((selector) => !matchedSelectorKeys.has(selector.toLocaleLowerCase("en-US")));
if (missingSelectors.length) throw new Error(`Protected paragraph styles not found in ICML: ${missingSelectors.join(", ")}`);
for (const selector of selectorSpecs) {
  const styles = [...matchedStylesBySelector.get(selector.key)];
  if (!selector.exactPath && styles.length > 1) {
    throw new Error(`Protected paragraph-style selector '${selector.requested}' is ambiguous across: ${styles.join(", ")}`);
  }
}
const duplicateIds = [...idLocations].filter(([, locations]) => locations.length > 1);
if (duplicateIds.length) throw new Error(`Protected Content IDs occur more than once: ${duplicateIds.slice(0, 20).map(([id]) => id).join(", ")}`);
if (!contentIds.length) throw new Error("Protected paragraph-style selectors found no Content IDs.");

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  policy: "source_language_verbatim",
  discovery: "icml_paragraph_style",
  textRoot,
  selectors: selectors.map((paragraphStyle) => ({
    type: "paragraph_style",
    paragraphStyle,
    includesHeading: false,
  })),
  contentIdCount: contentIds.length,
  contentIds,
  contentSnapshots,
  storyCount: stories.length,
  stories,
  sourceSetSha256: crypto.createHash("sha256").update(
    JSON.stringify(contentSnapshots.map(({ id, sourceText, relativePath, appliedParagraphStyle }) => ({
      id,
      sourceText,
      relativePath,
      appliedParagraphStyle,
    }))),
    "utf8",
  ).digest("hex").toUpperCase(),
};
writeJsonAtomic(outputPath, report);
console.log(`PROTECTED_SOURCE_DISCOVERED|styles=${selectors.length}|stories=${stories.length}|contentIds=${contentIds.length}|manifest=${outputPath}`);

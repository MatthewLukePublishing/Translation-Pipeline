"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const XLSX = require("xlsx");
const ROOT = path.resolve(__dirname, "..");
const { snapshotFromWorkbook } = require("../01 Translate Glossaries/Code/Shared/Import_Published_Glossaries.cjs");
const { validatePublication, applyPublishedGlossary, readContextualGlossary } = require("../01 Translate Glossaries/Code/Shared/PublishedGlossary.cjs");
const { compileFamily, buildFamily, assertFamilyCurrent } = require("../01 Translate Glossaries/Code/Shared/Build_Glossary_Runtime.cjs");

function fixtureWorkbook() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["English Acronyms", "English Definitions", ...["Spanish", "French", "German", "Portuguese"].flatMap(l => [`${l} Acronyms`, `${l} Definitions`, `${l} Combined Definitions`])],
    ["EX", "Example", "EJ", "Ejemplo", "Example (Ejemplo)", "EX", "Exemple", "Example (Exemple)", "BSP", "Beispiel", "Example (Beispiel)", "EX", "Exemplo", "Example (Exemplo)"],
  ]), "MFP");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ["Original English", ...["French", "German", "Portuguese", "Spanish"].flatMap(l => [`${l} (Reviewer)`, `${l} Definition (Reviewer)`])],
    ["EX", "EX", "Exemple", "BSP", "Beispiel", "EX", "Exemplo", "EJ", "Ejemplo"],
    ["Words", "Termes", "", "Wörter", "", "Palavras", "", "Términos", ""],
    ["Camera", "Caméra", "Point de vue", "Perspektive", "Blickwinkel", "Câmera", "Vista", "Cámara", "Vista"],
    ["Camera", "Caméra", "Appareil", "Kamera", "Gerät", "Câmera", "Aparelho", "Cámara", "Dispositivo"],
  ]), "FPST");
  return wb;
}

function snapshot(wb = fixtureWorkbook()) {
  return snapshotFromWorkbook(wb, Buffer.from("synthetic export"), "2026-09-16T00:00:00.000Z");
}

const columns = ["English", "English Definition", "French", "French Definition", "French Recommended", "French Recommended Definition", "German", "German Definition", "Portuguese", "Portuguese Definition", "Spanish", "Spanish Definition"];

test("sheet importer uses explicit sections, retains duplicate senses and excludes reviewer headers", () => {
  const data = snapshot();
  assert.equal(data.books.MFP.entries.length, 1);
  assert.equal(data.books.FPST.entries.length, 3);
  assert.deepEqual(data.books.FPST.entries.map(row => row.kind), ["acronyms", "words", "words"]);
  assert.equal(data.books.MFP.entries[0].translations.French.combinedDefinition, "Example (Exemple)");
  assert.doesNotMatch(JSON.stringify(data), /Reviewer|"Words"/);
  assert.deepEqual(data.books.FPST.entries.slice(1).map(row => row.row), [4, 5]);
});

test("importer rejects formulas, errors, malformed headers, missing sections, and unsafe duplicate rows", () => {
  for (const mutate of [
    wb => { wb.Sheets.MFP.F2.f = '"EX"'; },
    wb => { wb.Sheets.MFP.F2 = { t: "e", v: 29 }; },
    wb => { wb.Sheets.MFP.F2.v = "#NAME?"; },
    wb => { wb.Sheets.MFP.A2.v = "__proto__"; },
    wb => { wb.Sheets.MFP.A1.v = "Unexpected"; },
    wb => { wb.Sheets.FPST.A3.v = "Other"; },
    wb => { for (const col of "ABCDEFGHI") wb.Sheets.FPST[`${col}5`] = { ...wb.Sheets.FPST[`${col}4`] }; },
  ]) { const wb = fixtureWorkbook(); mutate(wb); assert.throws(() => snapshot(wb)); }
});

test("published overlay changes only bound fields, preserves missing values and never inserts bilingual prose", () => {
  const data = snapshot();
  data.books.MFP.entries[0].translations.French.term = "";
  const acronyms = { EX: { "English Definition": "Example", French: "historical", "French Definition": "historical definition", "French Recommended": "approved", "French Recommended Definition": "approved definition", Spanish: "anterior" } };
  const words = { Unrelated: { French: "untouched" } };
  applyPublishedGlossary({ acronyms, words, columns, source: { data, sheet: data.books.MFP, sha256: "0".repeat(64) }, config: { book: "MFP", languageFields: { French: "French Recommended", Spanish: "Spanish" } } });
  assert.equal(acronyms.EX.French, "historical");
  assert.equal(acronyms.EX["French Recommended"], "approved");
  assert.equal(acronyms.EX["French Recommended Definition"], "Exemple");
  assert.equal(acronyms.EX.Spanish, "EJ");
  assert.equal(words.Unrelated.French, "untouched");
});

test("duplicate senses are contextual rather than last-row-wins and case-only base keys stay unique", () => {
  const data = snapshot();
  const words = { camera: { German: "old", "German Definition": "old", "English Definition": "Old device sense" } };
  const result = applyPublishedGlossary({ acronyms: {}, words, columns, source: { data, sheet: data.books.FPST, sha256: "0".repeat(64) }, config: { book: "FPST", languageFields: { German: "German" } } });
  assert.deepEqual(Object.keys(words), ["camera"]);
  assert.equal(words.camera.German, ""); assert.equal(words.camera["German Definition"], "");
  assert.deepEqual(result.contextual.profiles.German[0].alternatives.map(item => item.target), ["Perspektive", "Kamera"]);
  assert.equal(result.contextual.profiles.German[0].source, "camera");
  assert.equal(result.acronyms.EX.German, "BSP");
});

test("checked-in snapshot builds both books on a clean clone with no private workbook", () => {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/book_glossary_map.published.json"), "utf8"));
  const published = validatePublication(JSON.parse(fs.readFileSync(path.join(ROOT, "01 Translate Glossaries/Published/Translation-Glossaries.json"), "utf8")));
  assert.equal(published.books.MFP.entries.length, 197);
  assert.equal(published.books.FPST.entries.length, 314);
  const mfp = compileFamily(map, "MFP", map.books.MFP);
  const fpst = compileFamily(map, "FPST", map.books.FPST);
  assert.equal(Object.keys(mfp.acronyms).length, 197);
  assert.equal(Object.keys(mfp.words).length, 0);
  assert.equal(Object.keys(fpst.acronyms).length, 65);
  assert.equal(Object.keys(fpst.words).length, 247);
  assert.equal(mfp.acronyms["1LT"].French, "1LT");
  assert.equal(mfp.acronyms["1LT"]["French Definition"], "Premier lieutenant — grade américain");
  assert.deepEqual(JSON.parse(fpst.replacements[2].data).profiles.German.map(item => item.source), ["Camera", "Ping"]);
});

test("published runtime, contextual senses and provenance commit together and reject stale sources", async () => {
  const parent = path.join(ROOT, ".tmp"); fs.mkdirSync(parent, { recursive: true });
  const temp = fs.mkdtempSync(path.join(parent, "published-glossary-"));
  try {
    const sourcePath = path.join(temp, "source.json"); fs.writeFileSync(sourcePath, JSON.stringify(snapshot()));
    const config = { family: "FPST", publishedSource: { path: sourcePath, book: "FPST" }, runtime: Object.fromEntries(["acronyms", "words", "contextual"].map(kind => [kind, path.join(temp, `${kind}.json`)])) };
    const map = { columns, sheets: { acronyms: "Acronyms", words: "Words" } };
    await buildFamily(map, "FPST", config, false);
    assert.doesNotThrow(() => assertFamilyCurrent(map, "FPST", config));
    assert.equal(readContextualGlossary(config.runtime.contextual, "German")[0].alternatives.length, 2);
    const before = fs.readFileSync(config.runtime.words, "utf8");
    // Exercise the real diagram resource resolver without private data, a model,
    // or Adobe. Profiles belonging only to other books must not create ambiguity.
    const resourceMap = { ...map, profiles: {
      German: { language: "German", termKey: "German", definitionKey: "German Definition" },
      "Other German": { language: "German", termKey: "Other German", definitionKey: "Other German Definition" },
    }, books: { FPST: { ...config, supportedProfiles: ["German"] } } };
    const mapFolder = path.join(temp, "01 Translate Glossaries"); fs.mkdirSync(mapFolder);
    fs.writeFileSync(path.join(mapFolder, "book_glossary_map.json"), JSON.stringify(resourceMap));
    const symbols = path.join(temp, "symbols.xlsx"); fs.writeFileSync(symbols, "existence-only fixture; not opened");
    const { resolveDiagramGlossaryResources } = require("../03 Translate Diagrams/Code/DiagramResources.cjs");
    const resources = resolveDiagramGlossaryResources({ programRoot: temp, book: "FPST", targetLanguage: "German", symbolsWorkbookPath: symbols });
    assert.equal(resources.glossaryProfile, "German");
    assert.equal(resources.contextualGlossary[0].alternatives[0].target, "Perspektive");
    const changed = snapshot(); changed.books.FPST.entries[0].translations.German.term = "NEU";
    fs.writeFileSync(sourcePath, JSON.stringify(changed));
    await assert.rejects(buildFamily(map, "FPST", config, true), /stale/);
    assert.throws(() => resolveDiagramGlossaryResources({ programRoot: temp, book: "FPST", targetLanguage: "German", symbolsWorkbookPath: symbols }), /stale/);
    assert.equal(fs.readFileSync(config.runtime.words, "utf8"), before);
    fs.writeFileSync(`${config.runtime.acronyms}.runtime-transaction.json`, "pending");
    await assert.rejects(buildFamily(map, "FPST", config, true), /read-only/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("text preparation checks the source and snapshots contextual data; both query stages consume it", () => {
  const prepare = fs.readFileSync(path.join(ROOT, "02 Translate Text/Code/Prepare-TranslationWorkspace.ps1"), "utf8");
  assert.match(prepare, /glossaryBuilder --check --family/);
  assert.match(prepare, /Copy-Item -LiteralPath \$contextualGlossarySource/);
  const runner = fs.readFileSync(path.join(ROOT, "02 Translate Text/Code/Translate_ICML_Codex_Subscription.mjs"), "utf8");
  assert.match(runner, /publishedGlossaries\.readContextualGlossary/);
  assert.match(runner, /contextualGlossarySha256/);
  const diagram = fs.readFileSync(path.join(ROOT, "03 Translate Diagrams/Code/DiagramResources.cjs"), "utf8");
  assert.match(diagram, /assertFamilyCurrent\(map/);
  assert.match(diagram, /readContextualGlossary\(/);
  const controller = fs.readFileSync(path.join(ROOT, "03 Translate Diagrams/Code/Illustrator_Translate_Diagrams_Batch.cjs"), "utf8");
  assert.match(controller, /contextual_glossary: GLOSSARY_RESOURCES\?\.contextualGlossary/);
});

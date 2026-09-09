"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const test = require("node:test");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");
const ROOT = path.resolve(__dirname, "..");
const { buildFamily } = require("../01 Translate Glossaries/Code/Shared/Build_Glossary_Runtime.cjs");
const { commitFileSetWithJournalSync: commit } = require("../Code/TransactionalFileReplacement.cjs");

async function fixture(run) {
  const parent = path.join(ROOT, ".tmp"); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "review-publication-"));
  try { await run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("caption snapshot hashes exactly the bytes loaded and cannot overwrite a later edit", () => fixture(async root => {
  const { readCaptionWorkbookSnapshot, assertCaptionLineBreaks } = await import("../04 Translate Comic Captions/Code/CaptionWorkbook.mjs");
  const input = path.join(root, "captions.xlsx");
  const workbook = new ExcelJS.Workbook(); workbook.addWorksheet("Captions").getCell("A1").value = "old";
  await workbook.xlsx.writeFile(input);
  const expected = crypto.createHash("sha256").update(fs.readFileSync(input)).digest("hex");
  const loaded = await readCaptionWorkbookSnapshot(input);
  assert.equal(loaded.inputWorkbookSha256.toLowerCase(), expected);
  fs.writeFileSync(input, "later user edit");
  assert.equal(loaded.workbook.worksheets[0].getCell("A1").value, "old");
  assert.throws(() => commit(path.join(root, "journal.json"), [{ filePath: input, data: "translation", expectedSha256: expected }]), /input changed/);
  assert.equal(fs.readFileSync(input, "utf8"), "later user edit");
  for (const separator of ["\r\n", "\r", "\n", "\u2028", "\u2029"]) {
    assert.doesNotThrow(() => assertCaptionLineBreaks(`A${separator}B`, `Un${separator}Deux`, "row"));
    assert.throws(() => assertCaptionLineBreaks(`A${separator}B`, "Un Deux", "row"), /Line breaks/);
  }
}));

test("glossary runtime pairs are validated before publication and published together", () => fixture(async root => {
  const authoringWorkbook = path.join(root, "Glossary.xlsx");
  const workbook = XLSX.utils.book_new();
  for (const name of ["Acronyms", "Words"]) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["English", "French"], ["Example", "Exemple"]]), name);
  XLSX.writeFile(workbook, authoringWorkbook);
  const runtime = { acronyms: path.join(root, "acronyms.json"), words: path.join(root, "words.json") };
  fs.writeFileSync(runtime.acronyms, "old"); fs.mkdirSync(runtime.words);
  const map = { sheets: { acronyms: "Acronyms", words: "Words" }, columns: ["English", "French"] };
  await assert.rejects(buildFamily(map, "Fixture", { authoringWorkbook, runtime }, false), /file, not a directory/);
  assert.equal(fs.readFileSync(runtime.acronyms, "utf8"), "old");
  fs.rmdirSync(runtime.words);
  await buildFamily(map, "Fixture", { authoringWorkbook, runtime }, false);
  await buildFamily(map, "Fixture", { authoringWorkbook, runtime }, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(runtime.words)), { Example: { French: "Exemple" } });
  const journal = `${authoringWorkbook}.runtime-transaction.json`; fs.writeFileSync(journal, "pending");
  await assert.rejects(buildFamily(map, "Fixture", { authoringWorkbook, runtime }, true), /read-only/);
  assert.equal(fs.readFileSync(journal, "utf8"), "pending");
}));

test("subscription check modes reject pending recovery before any recovery attempt", () => {
  for (const [file, marker] of [["04 Translate Comic Captions/Code/Translate_Comic_Captions.js", "FINALIZATION_JOURNAL"], ["02 Translate Text/Code/Translate_ICML_Codex_Subscription.mjs", "finalizationJournal"]]) {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.ok(source.indexOf(`cli.check && fs.existsSync(${marker})`) < source.indexOf(`recoverFileSetJournalSync(${marker})`));
    assert.match(source, new RegExp(`cli\\.check && fs\\.existsSync\\(${marker}\\)`));
  }
});

test("diagram staging leaves originals intact until guarded publication and preserves conflicts", () => fixture(async root => {
  const { prepareDiagramPublication, publishDiagram } = require("../03 Translate Diagrams/Code/DiagramPublication.cjs");
  const { listAiFiles } = require("../03 Translate Diagrams/Code/DiagramResources.cjs");
  const source = path.join(root, "diagram.AI"); fs.writeFileSync(source, "original fixture");
  const first = prepareDiagramPublication(source);
  fs.writeFileSync(first.outputPath, "translated fixture");
  assert.equal(fs.readFileSync(source, "utf8"), "original fixture");
  assert.deepEqual(await listAiFiles(root), [source], "never feed an interrupted staging file back into translation");
  publishDiagram(first);
  assert.equal(fs.readFileSync(source, "utf8"), "translated fixture");
  assert.equal(fs.existsSync(first.outputPath), false);
  const second = prepareDiagramPublication(source);
  fs.writeFileSync(second.outputPath, "new translated fixture"); fs.writeFileSync(source, "user edit");
  assert.throws(() => publishDiagram(second), /input changed/);
  assert.equal(fs.readFileSync(source, "utf8"), "user edit");
  assert.ok(fs.existsSync(second.outputPath), "retain uncertain output for review");
}));

test("diagram failure stops without relaunch or force-kill and workers only save staged output", async () => {
  const vm = require("node:vm");
  const source = fs.readFileSync(path.join(ROOT, "03 Translate Diagrams/Code/Illustrator_Translate_Diagrams_Batch.cjs"), "utf8");
  const code = source.slice(source.indexOf("async function processFileWithRetry("), source.indexOf("async function main("));
  let attempts = 0, aborts = 0;
  const context = { processFileInSession: async () => { attempts++; throw Error("save uncertainty"); },
    makePerFilePaths: () => ({ errorJson:"owned-error" }), makeTempStem: () => "fixture", writeJson: () => aborts++,
    appendFailureLog() {}, startIllustratorSession: () => assert.fail("must not relaunch") };
  vm.createContext(context); vm.runInContext(code, context);
  await assert.rejects(context.processFileWithRetry({ aiFile:"fixture", tempRoot:"fixture", sessionPaths:{}, getSession:()=>({ state:{ exited:false } }) }), /save uncertainty/);
  assert.equal(attempts,1); assert.equal(aborts,1);
  assert.doesNotMatch(source, /taskkill|terminateChildProcess|\.kill\(/);
  const worker = fs.readFileSync(path.join(ROOT,"03 Translate Diagrams/Code/Illustrator_Translate_Diagrams.jsx"),"utf8");
  assert.match(worker,/if \(app\.documents\.length\) throw/);
  assert.match(worker,/saveDocumentToPath\(doc, outputPath\)/);
  assert.match(worker,/app\.userInteractionLevel = originalInteraction/);
  assert.doesNotMatch(worker,/doc\.save\(\);|app\.quit\(/);
});

test("all query runners suppress raw process diagnostics and pin publication inputs", () => {
  for (const file of ["02 Translate Text/Code/Translate_ICML_Codex_Subscription.mjs", "03 Translate Diagrams/Code/Illustrator_Translate_Diagrams_Batch.cjs", "04 Translate Comic Captions/Code/Translate_Comic_Captions.js"]) {
    const source = fs.readFileSync(path.join(ROOT,file),"utf8");
    assert.doesNotMatch(source,/\$\{diagnostics\}/);
    assert.match(source,/Raw process output is withheld/);
  }
  const captions = fs.readFileSync(path.join(ROOT,"04 Translate Comic Captions/Code/Translate_Comic_Captions.js"),"utf8");
  assert.match(captions,/report\.finalModelResolution = await resolveLatestSubscriptionModel/);
  assert.match(captions,/expectedSha256: plan\.inputWorkbookSha256\.toLowerCase\(\)/);
  const text = fs.readFileSync(path.join(ROOT,"02 Translate Text/Code/Translate_ICML_Codex_Subscription.mjs"),"utf8");
  assert.match(text,/expectedSha256: outputBeforeTranslationSha256/);
  assert.match(text,/sha256File\(inputPath\) !== inputBeforeTranslationSha256/);
});

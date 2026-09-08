"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const { pathToFileURL } = require("node:url");
const ExcelJS = require("exceljs");
const XLSX = require("xlsx");

const ROOT = path.resolve(__dirname, "..");
const diagramResources = require(path.join(
  ROOT, "03 Translate Diagrams", "Code", "DiagramResources.cjs",
));

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function writeWorkbook(filePath, rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Content");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  XLSX.writeFile(workbook, filePath, { compression: true, bookSST: true });
}

test("Stage 3 discovers diagrams recursively and resolves canonical glossary resources", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "translate-diagrams-"));
  try {
    const folder = path.join(fixtureRoot, "diagrams");
    const nested = path.join(folder, "nested", "deeper");
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(folder, "root.ai"), "fixture", "utf8");
    fs.writeFileSync(path.join(nested, "nested.ai"), "fixture", "utf8");
    fs.writeFileSync(path.join(nested, "ignored.ai.txt"), "fixture", "utf8");
    const files = await diagramResources.listAiFiles(folder);
    assert.deepEqual(files.map((filePath) => path.relative(folder, filePath).replace(/\\/g, "/")), [
      "nested/deeper/nested.ai",
      "root.ai",
    ]);

    const glossaryRoot = path.join(fixtureRoot, "01 Translate Glossaries", "Demo", "Runtime");
    fs.mkdirSync(glossaryRoot, { recursive: true });
    fs.writeFileSync(path.join(glossaryRoot, "words.json"), `${JSON.stringify({
      Example: {
        "French Recommended": "Exemple",
        "French Recommended Definition": "Terme de démonstration",
      },
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(glossaryRoot, "acronyms.json"), `${JSON.stringify({
      EX: {
        "French Recommended": "EX",
        "French Recommended Definition": "Exemple",
      },
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(fixtureRoot, "01 Translate Glossaries", "book_glossary_map.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        profiles: {
          "French Recommended": {
            language: "French",
            termKey: "French Recommended",
            definitionKey: "French Recommended Definition",
          },
        },
        books: {
          DEMO: {
            family: "Demo",
            runtime: {
              acronyms: "01 Translate Glossaries/Demo/Runtime/acronyms.json",
              words: "01 Translate Glossaries/Demo/Runtime/words.json",
            },
            supportedProfiles: ["French Recommended"],
            defaultProfiles: { French: "French Recommended" },
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );
    const symbolsWorkbook = path.join(
      fixtureRoot, "03 Translate Diagrams", "Reference", "New Acronyms Symbols.xlsx",
    );
    writeWorkbook(symbolsWorkbook, [
      ["English", "English Definition", "French", "French Definition", "Portuguese", "Portuguese Definition"],
      ["A1", "Example symbol", "A1", "Symbole d’exemple", "AE1", "Símbolo de exemplo"],
    ]);

    const resources = diagramResources.resolveDiagramGlossaryResources({
      programRoot: fixtureRoot,
      book: "demo",
      targetLanguage: "French",
    });
    assert.equal(resources.book, "DEMO");
    assert.equal(resources.glossaryProfile, "French Recommended");
    assert.equal(resources.glossaryTermKey, "French Recommended");
    assert.ok(fs.existsSync(resources.wordsJson));
    assert.ok(fs.existsSync(resources.acronymsJson));
    const symbols = diagramResources.buildAcronymSymbolsRuntime(resources.symbolsWorkbook, "French");
    assert.equal(symbols.A1.French, "A1");
    assert.equal(symbols.A1.Portuguese, "AE1");
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("Stage 3 and Stage 4 contain no paid API client or hard-coded gpt-5.5 model", () => {
  const files = [
    path.join(ROOT, "03 Translate Diagrams", "Code", "Illustrator_Translate_Diagrams_Batch.cjs"),
    path.join(ROOT, "04 Translate Comic Captions", "Code", "Translate_Comic_Captions.js"),
  ];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, /gpt-5\.5/i, filePath);
    assert.doesNotMatch(source, /api\.openai\.com|new\s+OpenAI|responses\.create|chat\.completions/i, filePath);
    assert.match(source, /Codex subscription|CodexSubscription|codex/i, filePath);
  }
});

test("Stage 3 reports a failed diagram batch as a failed process outcome", () => {
  const batch = require(path.join(
    ROOT, "03 Translate Diagrams", "Code", "Illustrator_Translate_Diagrams_Batch.cjs",
  ));
  assert.doesNotThrow(() => batch.assertBatchSucceeded(0, 4, "failure.log"));
  assert.throws(
    () => batch.assertBatchSucceeded(1, 4, "failure.log"),
    /completed with 1 failed diagram.*failure\.log/i,
  );
  assert.throws(
    () => batch.assertBatchSucceeded(5, 4, "failure.log"),
    /Invalid Stage 3 batch totals/,
  );
});

test("Stage 4 mutates only pending Portuguese cells", async () => {
  const captionModule = await import(pathToFileURL(path.join(
    ROOT, "04 Translate Comic Captions", "Code", "CaptionWorkbook.mjs",
  )).href);
  const headers = [
    "Image",
    "English Caption",
    "Spanish Description",
    "French Description",
    "Portuguese Description",
    "German Description",
  ];
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Captions");
  worksheet.addRow(headers);
  worksheet.addRow(["image-1", "English", "Spanish", "French", "", "German"]);
  worksheet.addRow(["image-2", "Already done", "Spanish 2", "French 2", "Português", "German 2"]);
  worksheet.getCell("B2").font = { bold: true, name: "Arial" };
  worksheet.getCell("E2").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  const before = JSON.parse(JSON.stringify(worksheet.model));
  const state = captionModule.readCaptionWorksheetState(worksheet, headers);
  assert.deepEqual(state.pending.map((row) => row.id), ["row_000002"]);
  const translations = new Map([["row_000002", "Português novo"]]);
  captionModule.applyPortugueseTranslations(worksheet, state.pending, translations);
  captionModule.assertOnlyPortugueseValuesChanged(worksheet, state.sourceSnapshot, translations);
  assert.equal(worksheet.getCell("E2").value, "Português novo");
  assert.equal(worksheet.getCell("E3").value, "Português");
  assert.deepEqual(worksheet.getCell("B2").font, { bold: true, name: "Arial" });
  assert.deepEqual(worksheet.getCell("E2").fill, { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } });
  const after = JSON.parse(JSON.stringify(worksheet.model));
  for (let row = 0; row < before.rows.length; row += 1) {
    for (let column = 0; column < before.rows[row].cells.length; column += 1) {
      if (row === 1 && column === 4) continue;
      assert.deepEqual(after.rows[row].cells[column], before.rows[row].cells[column]);
    }
  }
});

test("QA revalidates edited workbooks but invalidates old import and finalization evidence", () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), "translate-imported-qa-"));
  try {
    const headers = [
      "ParagraphStyleRange id",
      "ParagraphStyleRange content",
      "Content tag",
      "Content content",
    ];
    const inputPath = path.join(job, "input", "content_export.xlsx");
    const outputPath = path.join(job, "output", "content_import.xlsx");
    writeWorkbook(inputPath, [headers, ["Body", "Source", "id-1", "Source"]]);
    writeWorkbook(outputPath, [headers, ["Body", "Cible", "id-1", "Cible"]]);
    const importedHash = sha256(outputPath);
    fs.writeFileSync(path.join(job, "job_config.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: "fixture",
      jobPath: job,
      book: "SUT",
      targetLanguage: "French",
      glossaryProfile: "French",
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(path.join(job, "job_manifest.json"), `${JSON.stringify({
      schemaVersion: 2,
      jobId: "fixture",
      status: "imported",
      workbook: { dataRowCount: 1, contentIdCount: 1 },
      qa: { status: "passed", hashes: { outputWorkbookSha256: importedHash } },
      import: { workbookSha256: importedHash },
      layoutFinalization: { documentSha256: "old-document" },
    }, null, 2)}\n`, "utf8");
    writeWorkbook(outputPath, [headers, ["Body", "Modifié", "id-1", "Modifié"]]);
    const validator = path.join(
      ROOT, "02 Translate Text", "Code", "Validation", "Validate_Translation_Job.js",
    );
    const run = spawnSync(process.execPath, [validator, "--job", job], {
      cwd: ROOT,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(run.status, 0, run.stderr);
    let manifest = JSON.parse(fs.readFileSync(path.join(job, "job_manifest.json")));
    assert.equal(manifest.status, "ready_for_import");
    assert.equal(manifest.qa.hashes.outputWorkbookSha256, sha256(outputPath));
    assert.equal(manifest.import, undefined);
    assert.equal(manifest.layoutFinalization, undefined);
    assert.equal(manifest.invalidatedImport.import.workbookSha256, importedHash);
    assert.equal(manifest.invalidatedImport.layoutFinalization.documentSha256, "old-document");
    manifest.status = "imported";
    manifest.import = { workbookSha256: sha256(outputPath), payloadSha256: manifest.qa.hashes.importPayloadSha256 };
    fs.writeFileSync(path.join(job, "job_manifest.json"), JSON.stringify(manifest));
    const unchanged = spawnSync(process.execPath, [validator, "--job", job], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    assert.equal(unchanged.status, 0, unchanged.stderr);
    manifest = JSON.parse(fs.readFileSync(path.join(job, "job_manifest.json")));
    assert.equal(manifest.status, "imported", "the exact already-imported payload remains resumable");
    writeWorkbook(outputPath, [headers, ["Body", "", "id-1", ""]]);
    const invalid = spawnSync(process.execPath, [validator, "--job", job], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    assert.notEqual(invalid.status, 0);
    manifest = JSON.parse(fs.readFileSync(path.join(job, "job_manifest.json")));
    assert.equal(manifest.status, "qa_failed");
    assert.equal(manifest.import, undefined, "a failed edited workbook cannot retain imported status");
  } finally {
    fs.rmSync(job, { recursive: true, force: true });
  }
});

test("journaled re-import accepts the exact previous output but never overwrites later ICML edits", async () => {
  const job = fs.mkdtempSync(path.join(os.tmpdir(), "translate-reimport-"));
  try {
    const { fnv1a32Utf16 } = await import(pathToFileURL(path.join(ROOT, "02 Translate Text/Code/ContentFingerprint.mjs")).href);
    const workspace = path.join(job, "edition"), textFolder = path.join(workspace, "Text");
    fs.mkdirSync(textFolder, { recursive: true });
    const icml = path.join(textFolder, "story.icml");
    const original = '<ParagraphStyleRange id="p1"><Content id="id-1">Source</Content></ParagraphStyleRange>';
    fs.writeFileSync(icml, original);
    const headers = ["ParagraphStyleRange id", "ParagraphStyleRange content", "Content tag", "Content content"];
    const output = path.join(job, "output/content_import.xlsx");
    writeWorkbook(path.join(job, "input/content_export.xlsx"), [headers, ["p1", "Source", "id-1", "Source"]]);
    writeWorkbook(output, [headers, ["p1", "Cible", "id-1", "Cible"]]);
    fs.writeFileSync(path.join(job, "job_config.json"), JSON.stringify({
      jobId: "fixture", jobPath: job, book: "DEMO", targetLanguage: "French", paths: { outputWorkbook: output },
      productionWorkspace: { root: workspace, textFolder, documentPath: path.join(workspace, "book.indd") },
    }));
    fs.writeFileSync(path.join(job, "job_manifest.json"), JSON.stringify({
      jobId: "fixture", status: "translated", workbook: { dataRowCount: 1, contentIdCount: 1 },
      icmlFiles: [{ path: icml, sha256: sha256(icml), fingerprint: fnv1a32Utf16(original) }],
    }));
    function run(name) {
      return spawnSync(process.execPath, [path.join(ROOT, "02 Translate Text/Code", name), "--job", job], { cwd: ROOT, encoding: "utf8", windowsHide: true });
    }
    for (const target of ["Cible", "Corrigé"]) {
      writeWorkbook(output, [headers, ["p1", target, "id-1", target]]);
      const qa = run("Validation/Validate_Translation_Job.js");
      assert.equal(qa.status, 0, qa.stderr);
      const imported = run("Import_Translation_Workbook.mjs");
      assert.equal(imported.status, 0, imported.stderr);
      assert.ok(fs.readFileSync(icml, "utf8").includes(`>${target}</Content>`));
    }
    const userEdit = fs.readFileSync(icml, "utf8").replace("Corrigé", "User edit");
    fs.writeFileSync(icml, userEdit);
    writeWorkbook(output, [headers, ["p1", "Nouvelle cible", "id-1", "Nouvelle cible"]]);
    assert.equal(run("Validation/Validate_Translation_Job.js").status, 0);
    const blocked = run("Import_Translation_Workbook.mjs");
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /differs from the previous import/);
    assert.equal(fs.readFileSync(icml, "utf8"), userEdit);
  } finally {
    fs.rmSync(job, { recursive: true, force: true });
  }
});

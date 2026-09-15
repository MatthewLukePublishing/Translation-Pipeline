"use strict";
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ROOT = path.resolve(__dirname, "..");
const {
  DiagramLedgerError,
  hashFile,
  loadLedger,
  matchDiagram,
  pendingUnits,
  recordTranslations,
  serializeLedger,
  translationsForLanguage,
  unitsForWorker,
  validateMatchReport,
  writeLedger,
} = require("../03 Translate Diagrams/Code/DiagramLedger.cjs");

function fixture(run) {
  const parent = path.join(ROOT, ".tmp");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "diagram-ledger-"));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function makeSource(root, { diagrams } = {}) {
  const entries = diagrams || [
    { file: "1_-_Example.ai", bytes: "diagram one", units: [
      { id: "1_-_Example#0001", font: "OpenSans-SemiBold", kind: "prose", text: "Scenario\n", plain: "Scenario" },
      { id: "1_-_Example#0002", font: "ChakraPetch-SemiBold", kind: "prose", text: "High\n", plain: "High" },
      { id: "1_-_Example#0003", font: "SourceCodePro-Black", kind: "sourceCode", text: "APM\n", plain: "APM" },
    ] },
  ];
  const diagramsOut = entries.map((entry, index) => {
    const file = path.join(root, entry.file);
    fs.writeFileSync(file, entry.bytes);
    return {
      order: index + 1,
      file: entry.file,
      relativePath: entry.file,
      bytes: Buffer.byteLength(entry.bytes),
      sha256: hashFile(file),
      textUnitCount: entry.units.length,
      textUnits: entry.units,
    };
  });
  const source = {
    schemaVersion: "diagram-text-ledger-2",
    book: "DEMO",
    sourceLanguage: "English",
    generatedUtc: "2026-09-15T00:00:00Z",
    sourceLabel: "Products/Demo/Diagrams",
    sourceFolder: "Diagrams",
    extraction: { method: "test" },
    terms: { copyright: "test" },
    diagramCount: diagramsOut.length,
    textUnitCount: diagramsOut.reduce((total, diagram) => total + diagram.textUnits.length, 0),
    diagrams: diagramsOut,
  };
  const ledgerPath = path.join(root, "DEMO-Diagram-Text-Ledger.json");
  fs.writeFileSync(ledgerPath, serializeLedger(source));
  return { ledgerPath, source };
}

test("a ledger round-trips, matches its diagram by hash, and reports pending units", () => fixture(root => {
  const { ledgerPath } = makeSource(root);
  const ledger = loadLedger(ledgerPath, { book: "DEMO" });
  assert.equal(ledger.book, "DEMO");
  assert.equal(ledger.diagrams.length, 1);
  assert.equal(ledger.source.textUnitCount, 3);

  const target = path.join(root, "copied-edition", "1 - Example.ai");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "diagram one");
  const { entry, matchedBy } = matchDiagram(ledger, target);
  assert.equal(entry.file, "1_-_Example.ai");
  assert.equal(matchedBy, "sha256");

  const units = unitsForWorker(entry);
  assert.deepEqual(units.map((unit) => unit.id), entry.textUnits.map((unit) => unit.id));
  assert.deepEqual(units.map((unit) => unit.kind), ["prose", "prose", "sourceCode"]);
  assert.equal(pendingUnits(entry, "French").length, 2);
}));

test("a revised or already translated diagram fails closed instead of being rewritten", () => fixture(root => {
  const { ledgerPath } = makeSource(root);
  const ledger = loadLedger(ledgerPath);
  const target = path.join(root, "1_-_Example.ai");
  fs.writeFileSync(target, "diagram one, revised");
  assert.throws(() => matchDiagram(ledger, target), /No diagram ledger entry matches/);
}));

test("an ambiguous hash is only accepted when the file name disambiguates it", () => fixture(root => {
  const { ledgerPath } = makeSource(root, { diagrams: [
    { file: "1_-_Example.ai", bytes: "same bytes", units: [{ id: "A#0001", font: "OpenSans-SemiBold", kind: "prose", text: "A\n", plain: "A" }] },
    { file: "2_-_Example.ai", bytes: "same bytes", units: [{ id: "B#0001", font: "OpenSans-SemiBold", kind: "prose", text: "B\n", plain: "B" }] },
  ] });
  const ledger = loadLedger(ledgerPath);
  const named = path.join(root, "renamed", "1 - Example.ai");
  fs.mkdirSync(path.dirname(named), { recursive: true });
  fs.writeFileSync(named, "same bytes");
  assert.equal(matchDiagram(ledger, named).matchedBy, "sha256+name");

  const ambiguous = path.join(root, "renamed", "3 - Example.ai");
  fs.writeFileSync(ambiguous, "same bytes");
  assert.throws(() => matchDiagram(ledger, ambiguous), /does not disambiguate/);
}));

test("ledger loading rejects a wrong schema, book, kind, or repeated unit id", () => fixture(root => {
  const { ledgerPath, source } = makeSource(root);
  const write = (mutate) => {
    const copy = JSON.parse(JSON.stringify(source));
    mutate(copy);
    fs.writeFileSync(ledgerPath, serializeLedger(copy));
  };

  write((copy) => { copy.schemaVersion = "diagram-text-ledger-1"; });
  assert.throws(() => loadLedger(ledgerPath), /Unsupported diagram ledger schema/);

  write((copy) => { copy.book = "OTHER"; });
  assert.throws(() => loadLedger(ledgerPath, { book: "DEMO" }), /is for OTHER/);

  write((copy) => { copy.diagrams[0].textUnits[0].kind = "other"; });
  assert.throws(() => loadLedger(ledgerPath), /unsupported kind 'other'/);

  write((copy) => { copy.diagrams[0].textUnits[1].id = copy.diagrams[0].textUnits[0].id; });
  assert.throws(() => loadLedger(ledgerPath), /repeats unit id/);
}));

test("a match report must cover every ledger unit in order with unchanged text", () => fixture(root => {
  const { ledgerPath } = makeSource(root);
  const ledger = loadLedger(ledgerPath);
  const entry = ledger.diagrams[0];
  const good = {
    runs: [
      { id: "1_-_Example#0001", originalText: "Scenario", frameIndex: 0, start: 0, length: 8 },
      { id: "1_-_Example#0002", originalText: "High", frameIndex: 1, start: 0, length: 4 },
    ],
    sourceCodeRuns: [{ id: "1_-_Example#0003", text: "APM", frameIndex: 2, start: 0, length: 3 }],
  };
  assert.deepEqual(validateMatchReport(entry, good), { proseCount: 2, sourceCodeCount: 1 });

  assert.throws(
    () => validateMatchReport(entry, { ...good, runs: good.runs.slice(0, 1) }),
    /but the ledger records 2 and 1/,
  );
  assert.throws(
    () => validateMatchReport(entry, { ...good, runs: [good.runs[1], good.runs[0]] }),
    /out of ledger order/,
  );
  assert.throws(
    () => validateMatchReport(entry, {
      ...good,
      runs: [good.runs[0], { ...good.runs[1], originalText: "Low" }],
    }),
    /no longer matches the ledger text/,
  );
}));

test("recorded translations are kept per language and the ledger write is hash-guarded", () => fixture(root => {
  const { ledgerPath } = makeSource(root);
  const ledger = loadLedger(ledgerPath);
  const entry = ledger.diagrams[0];

  assert.equal(recordTranslations(entry, "French", [
    { id: "1_-_Example#0001", translated: "Scénario" },
    { id: "1_-_Example#0002", translated: "Élevé" },
    { id: "1_-_Example#0003", translated: "APM" },
    { id: "unknown#0009", translated: "ignored" },
  ]), 3);
  assert.equal(recordTranslations(entry, "French", [{ id: "1_-_Example#0001", translated: "Scénario" }]), 0);

  writeLedger(ledger, ledger.source, { language: "French" });
  const reloaded = loadLedger(ledgerPath);
  assert.deepEqual(
    [...translationsForLanguage(reloaded.diagrams[0], "French").entries()],
    [["1_-_Example#0001", "Scénario"], ["1_-_Example#0002", "Élevé"], ["1_-_Example#0003", "APM"]],
  );
  assert.equal(pendingUnits(reloaded.diagrams[0], "French").length, 0);
  assert.equal(pendingUnits(reloaded.diagrams[0], "German").length, 2);
  assert.equal(reloaded.source.sourceLabel, "Products/Demo/Diagrams");

  fs.writeFileSync(ledgerPath, "{}");
  assert.throws(() => writeLedger(reloaded, reloaded.source), /changed during this run/);
}));

test("the published FPST ledger satisfies the ledger contract", () => {
  const ledgerPath = path.join(ROOT, "03 Translate Diagrams", "Ledgers", "FPST-Diagram-Text-Ledger.json");
  const ledger = loadLedger(ledgerPath, { book: "FPST" });
  assert.equal(ledger.diagrams.length, 115);
  assert.equal(ledger.diagrams.reduce((total, diagram) => total + diagram.textUnits.length, 0), 2014);
  assert.equal(ledger.source.textUnitCount, 2014);
  assert.ok(ledger.source.terms && ledger.source.terms.copyright, "the ledger must carry its content terms");
  assert.ok(ledger.source.extraction && ledger.source.extraction.adobeRequired === false);
  for (const diagram of ledger.diagrams) {
    assert.equal(diagram.textUnitCount, diagram.textUnits.length, `${diagram.file} unit count`);
    assert.equal(diagram.sha256.length, 64, `${diagram.file} sha256`);
  }
  const ids = new Set();
  for (const diagram of ledger.diagrams) {
    for (const unit of diagram.textUnits) {
      assert.ok(!ids.has(unit.id), `duplicate unit id ${unit.id}`);
      ids.add(unit.id);
      assert.ok(unit.plain.trim().length, `empty text for ${unit.id}`);
      assert.ok(["prose", "sourceCode"].includes(unit.kind), `unsupported kind for ${unit.id}`);
    }
  }
  assert.equal(ids.size, ledger.diagrams.reduce((total, diagram) => total + diagram.textUnits.length, 0));
});

test("the ledger writer is the only writer and never leaves a partial file", () => fixture(root => {
  const { ledgerPath, source } = makeSource(root);
  const text = serializeLedger(source);
  assert.equal(text.endsWith("}\n"), true);
  assert.equal(typeof crypto.createHash("sha256").update(text).digest("hex"), "string");
  const parsed = JSON.parse(text);
  assert.equal(parsed.diagrams[0].textUnits[0].plain, "Scenario");
  assert.equal(fs.readFileSync(ledgerPath, "utf8"), text);
  assert.throws(() => loadLedger(path.join(root, "missing.json")), DiagramLedgerError);
}));

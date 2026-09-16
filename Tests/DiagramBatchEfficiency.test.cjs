"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const test = require("node:test");
const plan = require("../03 Translate Diagrams/Code/DiagramTranslationPlan.cjs");
const { loadLedger } = require("../03 Translate Diagrams/Code/DiagramLedger.cjs");
const ROOT = path.resolve(__dirname, "..");
const CONTROLLER = path.join(ROOT, "03 Translate Diagrams/Code/Illustrator_Translate_Diagrams_Batch.cjs");
const WORKER = path.join(ROOT, "03 Translate Diagrams/Code/Illustrator_Translate_Diagrams.jsx");
const plain = value => JSON.parse(JSON.stringify(value));

function controllerHarness() {
  const source = fs.readFileSync(CONTROLLER, "utf8").replace(/^#!.*\r?\n/, "");
  const context = {
    require: createRequire(CONTROLLER), module: { exports: {} }, __dirname: path.dirname(CONTROLLER),
    process, console, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(context);
  vm.runInContext(`${source}
    module.exports = {
      makeInputItems, buildDelimitedPrompt, translateEfficientDiagram, sortTranslationsLikeRuns,
      shouldSkipTranslation, prepareLedgerTranslations, assertDiagramResourcesCurrent,
      processFileInSession,
      application({ prepared, submit, complete, resolve }) {
        PREPARED_LEDGER_TRANSLATIONS = prepared; LEDGER_REQUESTED = true;
        submitControllerJob = submit; waitForControllerJobDone = complete;
        waitForSignalFile = async () => {}; resolveSubscriptionModel = resolve;
        translateDiagramOnce = () => { throw new Error('Unexpected model query during ledger application'); };
      },
      configure({ resources, ledger = null, query, hashes = null }) {
        TARGET_LANGUAGE = 'French'; MODEL = 'test-frontier';
        GLOSSARY_RESOURCES = resources; LEDGER = ledger; RESOURCE_HASHES = hashes;
        EDITORIAL_POLICY = editorialRules.resolveEditorialRules('French', 'diagram');
        if (query) translateDiagramOnce = query;
      },
    };`, context, { filename: CONTROLLER });
  return context.module.exports;
}

function workerGlossaryHarness() {
  const source = fs.readFileSync(WORKER, "utf8");
  const body = source.slice(source.indexOf("(function"), source.indexOf('  var mode = getenv('));
  // Only function declarations are evaluated, never the Adobe entry point.
  return vm.runInNewContext(`${body}return { buildOpenSansGlossary, getDefinitionForLanguage, findGlossaryPairsInText, applyTranslations }; })();`);
}

function entry(name, texts) {
  return { file: name, textUnits: texts.map((text, i) => ({ id: `${name}#${i}`, kind: "prose", plain: text })) };
}

test("offline glossary preparation matches the actual Illustrator glossary helpers", () => {
  const worker = workerGlossaryHarness();
  const words = {
    High: { French: "Haut", "French Definition": "direction" },
    Low: { German: "Tief", _1: "unten", French: "Bas", _2: "en bas" },
    FPS: { French: "word overridden by acronym" },
    Missing: { French: "" },
    "Target (left)": { French: "Cible (gauche)" },
  };
  const acronyms = { FPS: { French: "FPS", "French Definition": "jeu de tir" } };
  const lookup = payload => Object.fromEntries(Object.entries(payload).map(([key, row]) => [key,
    row.French ? { French: { term: row.French, context: worker.getDefinitionForLanguage(row, "French") } } : {},
  ]));
  const expected = worker.buildOpenSansGlossary(lookup(words), lookup(acronyms), "French");
  const pairs = plan.buildLedgerGlossary(words, acronyms, "French");
  assert.deepEqual(pairs, plain(expected));
  const scan = plan.ledgerScan(entry("Example", ["High FPS", "Target (left), Low", "Highlight"]), "French", pairs);
  for (const run of scan.runs) {
    assert.deepEqual(run.glossaryMatches, plain(worker.findGlossaryPairsInText(run.originalText, expected)).map(({ source, target }) => ({ source, target })));
  }
  assert.equal(scan.runs[2].glossaryMatches.length, 0);
});

test("multi-diagram packing keeps whole diagram context, source order, and separate ids", () => {
  const scans = Array.from({ length: 17 }, (_, i) => plan.ledgerScan(entry(`Diagram${i}`, ["High", "10"]), "French", []));
  const batches = plan.packDiagramScans(scans);
  assert.deepEqual(batches.map(batch => batch.diagramContext.length), [8, 8, 1]);
  assert.deepEqual(batches.flatMap(batch => batch.runs.map(run => run.id)), scans.flatMap(scan => scan.runs.map(run => run.id)));
  assert.equal(new Set(batches.flatMap(batch => batch.runs.map(run => run.id))).size, 34);
  assert.equal(plan.packDiagramScans(scans, { diagrams: 8, items: 3, characters: 100000 }).length, 17);
  const large = plan.ledgerScan(entry("Large", ["x".repeat(25000)]), "French", []);
  assert.deepEqual(plan.packDiagramScans([scans[0], large, scans[1]]).map(batch => batch.diagramContext.length), [1, 1, 1]);
  assert.throws(() => plan.packDiagramScans(scans, { diagrams: 0, items: 1, characters: 1 }), /Invalid diagram batch limit/);
  assert.throws(() => plan.packDiagramScans([scans[0], { ...scans[1], targetLanguage: "German" }]), /cannot mix/);
});

test("compact requests exclude numeric output work and restore every original id exactly", () => {
  const scan = plan.ledgerScan(entry("Long source filename", ["High", "10", "Low"]), "French", []);
  const items = scan.runs.map(run => ({ id: run.id, sourceText: run.originalText, skipTranslation: run.originalText === "10" }));
  const compact = plan.compactQuery(scan, items);
  assert.deepEqual(compact.query.runs.map(run => run.id), ["t1", "t2"]);
  assert.deepEqual(compact.query.diagramContext[0].units.map(unit => unit.text), ["High", "10", "Low"]);
  const response = plan.expandResponse(compact, { translations: [{ id: "t2", translated: "Bas" }, { id: "t1", translated: "Haut" }] });
  assert.deepEqual(new Map(response.translations.map(row => [row.id, row.translated])), new Map([
    [scan.runs[0].id, "Haut"], [scan.runs[1].id, "10"], [scan.runs[2].id, "Bas"],
  ]));
  for (const translations of [[], [{ id: "unknown", translated: "x" }], [{ id: "t1", translated: "x" }, { id: "t1", translated: "x" }]]) {
    assert.throws(() => plan.expandResponse(compact, { translations }), /compact translation id/);
  }
  assert.throws(() => plan.compactQuery({ ...scan, runs: [scan.runs[0], scan.runs[0]] }, [items[0], items[0]]), /duplicate/);
});

test("compact prompts retain all editorial rules and applicable contextual senses, without cross-diagram substitution", () => {
  const harness = controllerHarness();
  harness.configure({ resources: { contextualGlossary: [
    { source: "Camera", alternatives: [{ target: "Caméra" }, { target: "Vue" }] },
    { source: "Unrelated", alternatives: [{ target: "A" }, { target: "B" }] },
  ] } });
  const scan = plan.packDiagramScans([
    plan.ledgerScan(entry("First", ["Camera", "42"]), "French", []),
    plan.ledgerScan(entry("Second", ["Camera"]), "French", []),
  ])[0];
  const compact = plan.compactQuery(scan, harness.makeInputItems(scan));
  const prompt = harness.buildDelimitedPrompt(compact.query);
  const payload = JSON.parse(prompt.split("<<<BEGIN_TEXT_ITEMS>>>\n")[1].split("\n<<<END_TEXT_ITEMS>>>")[0]);
  assert.equal(payload.diagrams.length, 2);
  assert.deepEqual(payload.diagrams[0].items, [{ id: "t1", text: "Camera" }, { context_only: "42" }]);
  assert.deepEqual(payload.diagrams[1].items, [{ id: "t2", text: "Camera" }]);
  assert.match(prompt, /Caméra/);
  assert.doesNotMatch(prompt, /Unrelated/);
  assert.match(prompt, /Identical labels in different diagrams may have different meanings/);
  const policy = require("../Code/TranslationEditorialRules.cjs").editorialPrompt("French", "diagram");
  assert.ok(prompt.includes(policy), "Batching must not shorten or drop the editorial rules");
});

test("efficient translation handles numeric-only scans without a query and retains mixed-run whitespace and acronym locks", async () => {
  const harness = controllerHarness();
  let queries = 0;
  harness.configure({ resources: {}, query: async scan => {
    queries++;
    assert.equal(scan.runs.length, 1);
    assert.equal(scan.runs[0].id, "t1");
    return { translations: [{ id: "t1", translated: "Déplacer __lock_acronym_1__" }] };
  } });
  const glossary = [{ source: "ABC", target: "XYZ", kind: "acronym", context: "unit" }];
  const scan = { targetLanguage: "French", glossary, runs: [
    { id: "n", originalText: " 123 ", frameIndex: 0, start: 0, length: 5 },
    { id: "a", originalText: " Move ABC ", glossaryMatches: glossary, frameIndex: 1, start: 0, length: 10 },
  ] };
  const translated = await harness.translateEfficientDiagram(scan, {});
  const restored = harness.sortTranslationsLikeRuns(scan, translated);
  assert.deepEqual(plain(restored.translations).map(row => row.translated), [" 123 ", " Déplacer XYZ "]);
  assert.equal(queries, 1);
  const numbers = await harness.translateEfficientDiagram({ ...scan, runs: [scan.runs[0]] }, {});
  assert.equal(numbers.translations[0].translated, "123");
  assert.equal(queries, 1);
});

test("exact unambiguous glossary labels bypass queries but ambiguous senses, case changes and phrases do not", async () => {
  const harness = controllerHarness();
  let queried = [];
  harness.configure({ resources: { contextualGlossary: [{ source: "Camera", alternatives: [{ target: "Caméra" }, { target: "Vue" }] }] },
    query: async scan => {
      queried = scan.runs.map(run => run.originalText);
      return { translations: scan.runs.map(run => ({ id: run.id, translated: "Modèle" })) };
    },
  });
  const pairs = [
    { source: "ABC", target: "XYZ", kind: "acronym" },
    { source: "Armor", target: "Blindage", kind: "word" },
    { source: "Camera", target: "Caméra", kind: "word" },
  ];
  const scan = plan.ledgerScan(entry("Exact", ["ABC", "Armor", "Camera", "ARMOR", "More Armor"]), "French", pairs);
  const result = await harness.translateEfficientDiagram(scan, {});
  const restored = harness.sortTranslationsLikeRuns(scan, result);
  assert.deepEqual(queried, ["Camera", "ARMOR", "More Armor"]);
  assert.deepEqual(plain(restored.translations).slice(0, 2).map(row => row.translated), ["XYZ", "Blindage"]);
});

test("Illustrator application reads each frame once, writes changed frames once, and matches the legacy replacement text", () => {
  const worker = workerGlossaryHarness();
  const originals = ["One Two Three", "123", "Left\rRight"];
  const counters = originals.map(() => ({ reads: 0, writes: 0 }));
  const contents = [...originals];
  const frames = originals.map((_, i) => ({
    get contents() { counters[i].reads++; return contents[i]; },
    set contents(value) { counters[i].writes++; contents[i] = value; },
  }));
  const items = [
    { id: "1", frameIndex: 0, start: 0, length: 3, translated: "Un" },
    { id: "2", frameIndex: 0, start: 4, length: 3, translated: "Deux" },
    { id: "3", frameIndex: 0, start: 8, length: 5, translated: "Trois plus long" },
    { id: "4", frameIndex: 1, start: 0, length: 3, translated: "123" },
    { id: "5", frameIndex: 2, start: 5, length: 5, translated: "À droite\nPlus bas" },
  ];
  const expected = [...originals];
  for (const item of [...items].sort((a, b) => a.frameIndex - b.frameIndex || b.start - a.start)) {
    const text = expected[item.frameIndex];
    expected[item.frameIndex] = text.slice(0, item.start) + item.translated.replace(/\r\n|\n/g, "\r") + text.slice(item.start + item.length);
  }
  assert.deepEqual(plain(worker.applyTranslations({ textFrames: frames }, items)), []);
  assert.deepEqual(contents, expected);
  assert.deepEqual(counters, [{ reads: 1, writes: 1 }, { reads: 1, writes: 0 }, { reads: 1, writes: 1 }]);
});

test("invalid or overlapping replacement ranges fail the entire preflight before any frame write", () => {
  const worker = workerGlossaryHarness();
  for (const bad of [
    { frameIndex: 1, start: 0, length: 100 },
    { frameIndex: 1, start: 0.5, length: 1 },
    { frameIndex: 1, start: 0, length: 0 },
    { frameIndex: -1, start: 0, length: 1 },
    { frameIndex: 1, start: 0, length: 3 },
  ]) {
    let writes = 0;
    const frames = [0, 1].map(() => ({ get contents() { return "ABCDE"; }, set contents(_) { writes++; } }));
    const issues = worker.applyTranslations({ textFrames: frames }, [
      { id: "valid", frameIndex: 0, start: 0, length: 1, translated: "ok" },
      { id: "later", frameIndex: 1, start: 2, length: 2, translated: "ok" },
      { id: "bad", ...bad, translated: "bad" },
    ]);
    assert.ok(issues.length);
    assert.equal(writes, 0);
  }
});

test("ledger pretranslation reuses approved entries, batches pending text, and leaves the ledger unchanged until artwork publication", async () => {
  const parent = path.join(ROOT, ".tmp"); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "diagram-preparation-"));
  try {
    const ledgerPath = path.join(root, "ledger.json");
    const words = path.join(root, "words.json");
    const acronyms = path.join(root, "acronyms.json");
    fs.writeFileSync(words, "{}"); fs.writeFileSync(acronyms, "{}");
    const entries = [entry("First", ["Known", " Pending ", " 123 "]), entry("Second", ["Other pending"])];
    entries[0].textUnits[0].translations = { French: " Approved " };
    fs.writeFileSync(ledgerPath, JSON.stringify({ schemaVersion: "diagram-text-ledger-2", book: "DEMO", diagrams: entries.map(row => {
      fs.writeFileSync(path.join(root, row.file), `original ${row.file}`);
      return { ...row, sha256: crypto.createHash("sha256").update(`original ${row.file}`).digest("hex") };
    }) }));
    const before = fs.readFileSync(ledgerPath);
    const ledger = loadLedger(ledgerPath);
    const harness = controllerHarness();
    let queries = 0;
    harness.configure({ resources: { wordsJson: words, acronymsJson: acronyms, glossaryTermKey: "French" }, ledger, query: async scan => {
      queries++;
      assert.equal(scan.diagramContext.length, 2);
      assert.equal(scan.runs.length, 2);
      return { translations: scan.runs.map(run => ({ id: run.id, translated: `Traduit ${run.originalText.trim()}` })) };
    } });
    const prepared = await harness.prepareLedgerTranslations(ledger.diagrams, root);
    assert.equal(queries, 1);
    assert.equal(prepared.get(ledger.diagrams[0]).translations.get("First#0"), " Approved ");
    assert.equal(prepared.get(ledger.diagrams[0]).translations.get("First#1"), " Traduit Pending ");
    assert.equal(prepared.get(ledger.diagrams[0]).translations.get("First#2"), " 123 ");
    assert.equal(prepared.get(ledger.diagrams[1]).translations.get("Second#0"), "Traduit Other pending");
    assert.deepEqual(fs.readFileSync(ledgerPath), before);
    assert.ok(fs.existsSync(path.join(root, "prepared-ledger-translations.json")));
    let submitted;
    let publicationsChecked = 0;
    harness.application({ prepared,
      submit: job => {
        submitted = job.envVars;
        const scan = prepared.get(ledger.diagrams[0]).scan;
        fs.writeFileSync(submitted.AI_SCAN_JSON, JSON.stringify({ ...scan,
          runs: scan.runs.map((run, i) => ({ ...run, frameIndex: i, start: 0, length: run.originalText.length })),
        }));
      },
      complete: async () => {
        const applied = JSON.parse(fs.readFileSync(submitted.AI_TRANSLATION_JSON, "utf8"));
        assert.deepEqual(applied.translations.map(row => row.translated), [" Approved ", " Traduit Pending ", " 123 "]);
        assert.deepEqual(applied.translations.map(row => row.frameIndex), [0, 1, 2]);
        fs.writeFileSync(submitted.AI_OUTPUT_FILE, "translated fixture artwork");
      },
      resolve: async () => { publicationsChecked++; return { model: "test-frontier", reasoningEffort: "xhigh" }; },
    });
    await harness.processFileInSession({ aiFile: path.join(root, "First"), tempRoot: root, jobsDir: root,
      sessionErrorJson: path.join(root, "session-error.json"), illustratorState: {},
    });
    assert.equal(queries, 1, "Application must not ask the model again");
    assert.equal(publicationsChecked, 1, "Fresh frontier verification still precedes publication");
    assert.equal(fs.readFileSync(path.join(root, "First"), "utf8"), "translated fixture artwork");
    assert.equal(fs.readFileSync(path.join(root, "Second"), "utf8"), "original Second");
    const published = loadLedger(ledgerPath);
    assert.equal(published.diagrams[0].textUnits[1].translations.French, " Traduit Pending ");
    assert.equal(published.diagrams[1].textUnits[0].translations, undefined, "Unpublished artwork cannot acquire applied translations");
    fs.writeFileSync(ledgerPath, "changed");
    assert.throws(() => harness.assertDiagramResourcesCurrent(), /ledger changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("FPST offline plan reduces requests without dropping text or merging identical labels", () => {
  const ledger = loadLedger(path.join(ROOT, "03 Translate Diagrams/Ledgers/FPST-Diagram-Text-Ledger.json"));
  const published = require("../01 Translate Glossaries/Code/Shared/PublishedGlossary.cjs");
  const config = { path: "01 Translate Glossaries/Published/Translation-Glossaries.json", book: "FPST" };
  const source = published.readPublishedSource(ROOT, config);
  const columns = ["English", "English Definition", ...published.LANGUAGES.flatMap(language => [language, `${language} Definition`])];
  const runtime = published.applyPublishedGlossary({ acronyms: {}, words: {}, columns, source, config });
  const pairs = plan.buildLedgerGlossary(runtime.words, runtime.acronyms, "French");
  const harness = controllerHarness();
  harness.configure({ resources: { contextualGlossary: runtime.contextual.profiles.French } });
  const scans = ledger.diagrams.map(diagram => plan.ledgerScan(diagram, "French", pairs));
  const pending = scans.map(scan => {
    const items = harness.makeInputItems(scan);
    return { ...scan, runs: scan.runs.filter((_, i) => typeof items[i].localTranslation !== "string") };
  });
  const baselineQueries = scans.filter(scan => scan.runs.some(run => !harness.shouldSkipTranslation(run.originalText))).length;
  const batches = plan.packDiagramScans(pending);
  const expectedIds = pending.flatMap(scan => scan.runs.map(run => run.id));
  assert.deepEqual(batches.flatMap(batch => batch.runs.map(run => run.id)), expectedIds);
  assert.equal(new Set(expectedIds).size, expectedIds.length);
  assert.ok(batches.length < baselineQueries / 3, "FPST must need fewer than one-third as many requests");
  assert.ok(batches.every(batch => batch.diagramContext.length <= 8));
  const compactCharacters = batches.reduce((sum, batch) => sum + harness.buildDelimitedPrompt(plan.compactQuery(batch, harness.makeInputItems(batch)).query).length, 0);
  const separateCharacters = scans.filter(scan => scan.runs.some(run => !harness.shouldSkipTranslation(run.originalText))).reduce((sum, scan) => sum + harness.buildDelimitedPrompt(scan).length, 0);
  assert.ok(compactCharacters < separateCharacters / 2, "FPST batching must more than halve serialized prompt characters");
  console.log(`FPST_OFFLINE_PLAN|legacyQueries=${baselineQueries}|batchedQueries=${batches.length}|pendingTextItems=${expectedIds.length}|separatePromptCharacters=${separateCharacters}|batchedPromptCharacters=${compactCharacters}`);
});

test("ledger model work precedes Adobe startup; application has no fallback query and retains hash guards", () => {
  const source = fs.readFileSync(CONTROLLER, "utf8");
  const main = source.slice(source.indexOf("async function main("));
  assert.ok(main.indexOf("await prepareLedgerTranslations(") < main.indexOf("await startIllustratorSession("));
  assert.match(source, /Ledger translations were not prepared before Illustrator started/);
  assert.match(source, /no fallback model query is allowed during application/);
  assert.match(source, /Illustrator's matched text or glossary differs/);
  assert.match(source, /hashFile\(file\) !== expected/);
  assert.match(source, /assertDiagramResourcesCurrent\(\);\s*writeJson\(`\$\{perFile\.translateJson\}\.publication\.json`/);
});

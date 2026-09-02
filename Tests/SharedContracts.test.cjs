"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const transactionFiles = require(path.join(ROOT, "Code", "TransactionalFileReplacement.cjs"));

function importFile(...segments) {
  return import(pathToFileURL(path.join(ROOT, ...segments)).href);
}

test("content groups use literal column A boundaries and preserve whitespace segments", async () => {
  const groupsModule = await importFile("02 Translate Text", "Code", "ContentGroups.mjs");
  const rows = [
    ["Paragraph Style", "Composite", "Content ID", "Segment"],
    ["", "", "orphan", "orphan"],
    ["Body", " x", "id-1", " "],
    ["", "", "id-2", "x"],
    ["Title", "", "id-3", ""],
  ];
  const groups = groupsModule.buildContentGroups(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].rowIndexes, [2, 3]);
  assert.deepEqual(groups[0].sourceSegments, [" ", "x"]);
  assert.equal(groupsModule.compositeFromRows(rows, groups[0]), " x");
  assert.deepEqual(groupsModule.findOrphanRows(rows), [1]);
});

test("bounded QA issue details still retain and count a late error", async () => {
  const { createIssueCollector } = await importFile(
    "02 Translate Text", "Code", "Validation", "IssueCollector.mjs",
  );
  const collector = createIssueCollector(3);
  collector.addIssue("warning", "W1", "warning 1");
  collector.addIssue("warning", "W2", "warning 2");
  collector.addIssue("warning", "W3", "warning 3");
  collector.addIssue("warning", "W4", "warning 4");
  collector.addIssue("error", "E1", "late error");
  assert.deepEqual(collector.counts, { errors: 1, warnings: 4, total: 5, retained: 3, omitted: 2 });
  assert.ok(collector.issues.some((issue) => issue.code === "E1"));
});

test("glossary resolution gives exact case priority and suppresses ambiguous fallback", async () => {
  const glossary = await importFile("02 Translate Text", "Code", "GlossaryResolution.mjs");
  const compiled = glossary.compileGlossaryEntries([
    { source: "BLAST", target: "acronym" },
    { source: "Blast", target: "word" },
    { source: "Squad Leader", target: "chef de groupe" },
  ]);
  assert.equal(glossary.resolveGlossaryEntriesForText("BLAST", compiled)[0].entry.target, "acronym");
  assert.equal(glossary.resolveGlossaryEntriesForText("Blast", compiled)[0].entry.target, "word");
  assert.equal(glossary.resolveGlossaryEntriesForText("blast", compiled).length, 0);
  assert.equal(
    glossary.resolveGlossaryEntriesForText("SQUAD LEADER", compiled)[0].matchMode,
    "case-insensitive-unique",
  );
});

test("latest subscription model comes from the visible Codex harness catalog", async () => {
  const resolver = await importFile("02 Translate Text", "Code", "Resolve-LatestSubscriptionModel.mjs");
  const selected = resolver.selectLatestCatalogModel({
    models: [
      {
        slug: "gpt-5.5",
        visibility: "list",
        priority: 2,
        description: "Frontier model.",
        supported_reasoning_levels: [{ effort: "xhigh" }],
      },
      {
        slug: "gpt-5.6-sol",
        visibility: "list",
        priority: 1,
        description: "Latest frontier agentic coding model.",
        supported_reasoning_levels: [{ effort: "xhigh" }],
      },
      {
        slug: "gpt-9-preview",
        visibility: "hidden",
        priority: 0,
        description: "Latest frontier preview.",
        supported_reasoning_levels: [{ effort: "xhigh" }],
      },
    ],
  });
  assert.equal(selected.slug, "gpt-5.6-sol");
  assert.doesNotThrow(() => resolver.assertModelSupportsEffort(selected, "xhigh"));
});

test("latest-model resolution refuses an older fallback for reasoning effort", async () => {
  const resolver = await importFile("02 Translate Text", "Code", "Resolve-LatestSubscriptionModel.mjs");
  const selected = resolver.selectLatestCatalogModel({
    models: [
      {
        slug: "gpt-newest",
        visibility: "list",
        priority: 0,
        description: "Latest frontier model.",
        supported_reasoning_levels: [{ effort: "high" }],
      },
      {
        slug: "gpt-older",
        visibility: "list",
        priority: 1,
        description: "Older model.",
        supported_reasoning_levels: [{ effort: "xhigh" }],
      },
    ],
  });
  assert.equal(selected.slug, "gpt-newest");
  assert.throws(
    () => resolver.assertModelSupportsEffort(selected, "xhigh"),
    /Refusing to fall back to an older model/,
  );
});

test("ICML replacements preserve structural tokens and escape ordinary XML characters", async () => {
  const icml = await importFile("02 Translate Text", "Code", "IcmlContent.mjs");
  const source = " Lead <?ACE 4?><Br/>tail ";
  const translated = " Texte <?ACE 4?><Br/>suite ";
  assert.doesNotThrow(() => icml.assertIcmlReplacementStructure(source, translated, "fixture"));
  assert.equal(
    icml.xmlEscapePreserveIcml(`${translated}& 2 < 3`),
    " Texte <?ACE 4?><Br/>suite &amp; 2 &lt; 3",
  );
  assert.throws(
    () => icml.assertIcmlReplacementStructure(source, " Texte <?ACE 5?><Br/>suite ", "fixture"),
    /processing instructions changed/,
  );
  assert.throws(
    () => icml.assertIcmlReplacementStructure(source, " Texte <?ACE 4?><Br/><Br/>suite ", "fixture"),
    /markup tags changed/,
  );
  assert.throws(
    () => icml.assertIcmlReplacementStructure(source, "Texte <?ACE 4?><Br/>suite ", "fixture"),
    /whitespace changed/,
  );
});

test("language postprocessors skip protected credits while standardizing French dates", async () => {
  const postprocessors = await importFile("02 Translate Text", "Code", "LanguagePostprocessors.mjs");
  const values = [
    ["Paragraph Style", "Composite", "Content ID", "Segment"],
    ["Body", "", "body-1", "6 Jun 1944"],
    ["Credits", "", "credit-1", "Image 1: 6 Jun 1944"],
  ];
  const counts = postprocessors.applyLanguagePostprocessors(values, "French", {
    protectedContentIds: new Set(["credit-1"]),
  });
  assert.equal(values[1][3], "6 juin 1944");
  assert.equal(values[2][3], "Image 1: 6 Jun 1944");
  assert.equal(counts.frenchDatesStandardized, 1);
});

test("file-set transactions commit together and recover interrupted application", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "translate-file-set-"));
  try {
    const first = path.join(folder, "first.txt");
    const second = path.join(folder, "second.txt");
    const journal = path.join(folder, "transaction.json");
    fs.writeFileSync(first, "old-first", "utf8");
    fs.writeFileSync(second, "old-second", "utf8");
    transactionFiles.commitFileSetWithJournalSync(journal, [
      { filePath: first, data: "new-first", options: "utf8" },
      { filePath: second, data: "new-second", options: "utf8" },
    ]);
    assert.equal(fs.readFileSync(first, "utf8"), "new-first");
    assert.equal(fs.readFileSync(second, "utf8"), "new-second");
    assert.equal(fs.existsSync(journal), false);

    const firstBackup = `${first}.codex-set-backup-fixture`;
    const secondBackup = `${second}.codex-set-backup-fixture`;
    const firstReplacement = `${first}.codex-set-new-fixture`;
    const secondReplacement = `${second}.codex-set-new-fixture`;
    fs.renameSync(first, firstBackup);
    fs.writeFileSync(first, "partial-first", "utf8");
    fs.renameSync(second, secondBackup);
    fs.writeFileSync(secondReplacement, "pending-second", "utf8");
    fs.writeFileSync(journal, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: "fixture",
      phase: "applying",
      items: [
        { filePath: first, backup: firstBackup, replacement: firstReplacement, hadOriginal: true },
        { filePath: second, backup: secondBackup, replacement: secondReplacement, hadOriginal: true },
      ],
    }, null, 2)}\n`, "utf8");
    const recovery = transactionFiles.recoverFileSetJournalSync(journal);
    assert.equal(recovery.phase, "rolled-back");
    assert.equal(fs.readFileSync(first, "utf8"), "new-first");
    assert.equal(fs.readFileSync(second, "utf8"), "new-second");
    assert.equal(fs.existsSync(journal), false);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("file-set transactions reject unsafe journals and blank or overlapping targets", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "translate-file-set-safety-"));
  try {
    const target = path.join(folder, "target.txt");
    const journal = path.join(folder, "transaction.json");
    const outside = path.join(path.dirname(folder), `${path.basename(folder)}-outside.txt`);
    fs.writeFileSync(target, "original", "utf8");
    fs.writeFileSync(outside, "must-survive", "utf8");
    fs.writeFileSync(journal, `${JSON.stringify({
      schemaVersion: 1,
      transactionId: "tampered-fixture",
      phase: "committed",
      items: [{
        filePath: target,
        backup: outside,
        replacement: `${target}.codex-set-new-fixture`,
        hadOriginal: true,
      }],
    }, null, 2)}\n`, "utf8");

    assert.throws(
      () => transactionFiles.recoverFileSetJournalSync(journal),
      /Invalid set-backup path/,
    );
    assert.equal(fs.readFileSync(outside, "utf8"), "must-survive");
    assert.equal(fs.existsSync(journal), true);
    fs.rmSync(journal, { force: true });

    assert.throws(
      () => transactionFiles.commitFileSetWithJournalSync(journal, [{ filePath: "", data: "x" }]),
      /non-blank path/,
    );
    assert.throws(
      () => transactionFiles.commitFileSetWithJournalSync(journal, [{ filePath: journal, data: "x" }]),
      /cannot also be a replacement target/,
    );
    assert.equal(fs.readFileSync(target, "utf8"), "original");
    fs.rmSync(outside, { force: true });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

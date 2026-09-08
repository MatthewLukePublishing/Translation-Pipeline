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

test("glossary table recommendations never erase unspecified cells or boundary whitespace", async () => {
  const { renderGlossaryTableRow } = await importFile("02 Translate Text", "Code", "GlossaryTable.mjs");
  assert.equal(renderGlossaryTableRow("Abn.\tAirborne", { targetTerm: "", targetDefinition: "Aéroporté" }), "Abn.\tAéroporté");
  assert.equal(renderGlossaryTableRow("  EX \t Example\r\n", { targetTerm: "FR", targetDefinition: "Exemple" }), "  FR \t Exemple\r\n");
  assert.equal(renderGlossaryTableRow("EX\tExample", { targetTerm: "FR", targetDefinition: "" }), "FR\tExample");
  assert.equal(renderGlossaryTableRow("EX\tExample", {}), "EX\tExample");
  assert.throws(() => renderGlossaryTableRow("EX\tExample\tExtra", {}), /exactly two/);
});

test("French definition agreement is accepted without weakening source or acronym matching", async () => {
  const { containsGlossaryTarget, glossaryPattern } = await importFile("02 Translate Text", "Code", "GlossaryPatterns.mjs");
  const check = { target: "Aéroporté", kind: "definition" };
  for (const target of ["aéroporté", "aéroportée", "aéroportés", "aéroportées"]) {
    assert.equal(containsGlossaryTarget(`Soldats ${target}.`, check, "French"), true);
  }
  for (const target of ["aéroportéess", "préaéroportés", "aéroportage"]) {
    assert.equal(containsGlossaryTarget(target, check, "French"), false);
  }
  assert.equal(containsGlossaryTarget("Aéroportés", check, "Portuguese"), false);
  assert.equal(containsGlossaryTarget("Aéroportés", { ...check, kind: "acronym" }, "French"), false);
  assert.equal(containsGlossaryTarget("CPTs", { target: "CPT", kind: "acronym" }, "French"), false);
  assert.equal(glossaryPattern("Aéroporté").test("Aéroportés"), false);
});

test("targeted rechecks retain valid groups and fail closed on model/query errors", async () => {
  const { validateWithTargetedRecheck } = await importFile("02 Translate Text", "Code", "BatchRecheck.mjs");
  const batch = { batchId: "batch_1", groups: ["a", "b"].map(groupId => ({ groupId, sourceSegments: ["source "] })) };
  const response = { batch_id: "batch_1", groups: [{ group_id: "a", segments: ["valid "] }, { group_id: "b", segments: ["invalid"] }] };
  function validate(value, source) {
    assert.equal(value.batch_id, source.batchId);
    assert.equal(value.groups.length, source.groups.length);
    for (const group of value.groups) if (!group.segments[0].endsWith(" ")) throw new Error("Boundary whitespace changed");
    return value.groups;
  }
  let queries = 0;
  const options = { response, batch, validate, query: async (repairBatch, context, attempt) => {
    queries++;
    assert.deepEqual(repairBatch.groups.map(g => g.groupId), ["b"]);
    assert.equal(repairBatch.segmentCount, 1);
    assert.equal(context[0].validation_error, "Boundary whitespace changed");
    assert.equal(attempt, 1);
    return { batch_id: repairBatch.batchId, groups: [{ group_id: "b", segments: ["rephrased "] }] };
  } };
  const result = await validateWithTargetedRecheck(options);
  assert.equal(queries, 1);
  assert.equal(result.response.groups[0], response.groups[0], "valid translations must remain exactly unchanged");
  assert.equal(response.groups[1].segments[0], "invalid", "keep the original draft intact");
  assert.equal(result.response.groups[1].segments[0], "rephrased ");
  await assert.rejects(validateWithTargetedRecheck({ ...options, query: async () => { throw new Error("Frontier changed"); } }), /Frontier changed/);
  await assert.rejects(validateWithTargetedRecheck({ ...options, attempt: 2 }), /recheck limit reached/);
  await assert.rejects(validateWithTargetedRecheck({ ...options, response: { ...response, groups: [response.groups[0]] } }), /Expected values/);
  const identities = [];
  const capture = async repairBatch => {
    identities.push(repairBatch.batchId);
    return { batch_id: repairBatch.batchId, groups: repairBatch.groups.map(group => ({ group_id: group.groupId, segments: ["valid "] })) };
  };
  await validateWithTargetedRecheck({ ...options, query: capture });
  await validateWithTargetedRecheck({ ...options, query: capture });
  await validateWithTargetedRecheck({ ...options, query: capture, response: { ...response, groups: response.groups.map(group => ({ ...group, segments: ["different invalid draft"] })) } });
  assert.equal(identities[0], identities[1], "identical rechecks can resume their saved query");
  assert.notEqual(identities[0], identities[2], "a different failed subset/draft must not reuse an unrelated cached recheck");
});

test("line-break encoding is restored without inventing or dropping separators", async () => {
  const { lineBreaks, restoreLineBreakKinds, lockLineBreaks, restoreLockedLineBreaks } = await importFile("02 Translate Text", "Code", "LineBreaks.mjs");
  assert.equal(restoreLineBreakKinds("A\u2028B\nC", "Un\nDeux\u2029Trois"), "Un\u2028Deux\nTrois");
  assert.deepEqual(lineBreaks("A\r\nB\rC\nD\u2028E\u2029F"), ["\r\n", "\r", "\n", "\u2028", "\u2029"]);
  assert.equal(restoreLineBreakKinds("A\u2028B", "Un Deux"), "Un Deux");
  assert.equal(restoreLineBreakKinds("A", "Un\nDeux"), "Un\nDeux");
  assert.equal(restoreLineBreakKinds("A\u2028B", "Un\u000bDeux"), "Un\u2028Deux");
  assert.equal(restoreLineBreakKinds("A", "Un\u000bDeux"), "Un\u000bDeux", "an invented break remains invalid for XML validation");
  const protectedBreaks = lockLineBreaks("A\u2028B\nC", "group_1", 0);
  assert.equal(restoreLockedLineBreaks(protectedBreaks.text, protectedBreaks.locks), "A\u2028B\nC");
  assert.throws(() => restoreLockedLineBreaks("Un\u2028Deux\nTrois", protectedBreaks.locks), /line-break token/);
  assert.throws(() => restoreLockedLineBreaks(protectedBreaks.text + protectedBreaks.locks[0].token, protectedBreaks.locks), /line-break token/);
  assert.equal(restoreLockedLineBreaks("Un\u2028Deux\nTrois", protectedBreaks.locks, false), "Un\u2028Deux\nTrois");
});

test("official-name additions and omissions trigger a recheck of only the invalid group", async () => {
  const { assertPreservedSourceNames, preservedSourceNameIssues } = await importFile("02 Translate Text", "Code", "BookTranslationRules.mjs");
  const { validateWithTargetedRecheck } = await importFile("02 Translate Text", "Code", "BatchRecheck.mjs");
  const rules = [{ id: "official_service", pattern: "U\\.S\\. Navy", flags: "gu" }];
  const source = "U.S. Navy personnel on a Navy boat.";
  const valid = "Du personnel de l’U.S. Navy sur une embarcation de la Navy.";
  const invalid = "Du personnel de l’U.S. Navy sur une embarcation de l’U.S. Navy.";
  assert.deepEqual(preservedSourceNameIssues(source, valid, rules), []);
  assert.throws(() => assertPreservedSourceNames(source, invalid, rules, "synthetic segment"), /exactly 1 time\(s\); found 2/);
  assert.throws(() => assertPreservedSourceNames(source, "Personnel sur une embarcation", rules, "synthetic segment"), /found 0/);
  assert.doesNotThrow(() => assertPreservedSourceNames("U.S. Navy / U.S. Navy", "U.S. Navy / U.S. Navy", rules, "repeated source"));
  const batch = { batchId: "names", groups: ["a", "b"].map(groupId => ({ groupId, sourceSegments: [source] })) };
  const response = { batch_id: "names", groups: [{ group_id: "a", segments: [valid] }, { group_id: "b", segments: [invalid] }] };
  const result = await validateWithTargetedRecheck({ response, batch,
    validate: (value, input) => { for (const group of input.groups) assertPreservedSourceNames(group.sourceSegments[0], value.groups.find(g => g.group_id === group.groupId).segments[0], rules, group.groupId); return value.groups; },
    query: async (repair, context) => { assert.deepEqual(repair.groups.map(g => g.groupId), ["b"]); assert.match(context[0].validation_error, /found 2/); return { batch_id: repair.batchId, groups: [{ group_id: "b", segments: [valid] }] }; },
  });
  assert.equal(result.response.groups[0], response.groups[0]);
  assert.equal(result.response.groups[1].segments[0], valid);
  const translator = fs.readFileSync(path.join(ROOT, "02 Translate Text/Code/Translate_ICML_Codex_Subscription.mjs"), "utf8");
  assert.match(translator, /assertPreservedSourceNames\(sourceGroup\.sourceSegments\[index\], translated/);
});

test("official headquarters-unit qualifiers are preserved atomically, not partly translated", async () => {
  const { configuredPattern } = await importFile("02 Translate Text", "Code", "BookTranslationRules.mjs");
  const rule = { id: "official_unit_type_abbreviation", pattern: "\\b(?:Bn|Co)\\.", flags: "gu" };
  const source = "Headquarters and Headquarters Bn., Headquarters and Service Co., Headquarters Co., Bn.; headquarters staff";
  assert.deepEqual([...source.matchAll(configuredPattern(rule))].map(match => match[0]), [
    "Headquarters and Headquarters Bn.", "Headquarters and Service Co.", "Headquarters Co.", "Bn.",
  ]);
  assert.equal(source.replace(configuredPattern(rule), "LOCK").includes("headquarters staff"), true);
  assert.equal(configuredPattern({ ...rule, id: "custom_rule" }).source, rule.pattern, "custom patterns retain their configured meaning");
});

test("ambiguous expanded definitions require context while explicit glossary conflicts still fail", async () => {
  const glossary = await importFile("02 Translate Text", "Code", "GlossaryResolution.mjs");
  const entries = glossary.compileGlossaryEntries([
    { source: "Captain", target: "Capitaine de vaisseau", sourceTerm: "CAPT", kind: "definition" },
    { source: "Captain", target: "Capitaine", sourceTerm: "CPT", kind: "definition" },
    { source: "CPT", target: "Cne", kind: "term" },
  ]);
  const captain = entries.find(entry => entry.source === "Captain");
  assert.equal(captain.contextual, true);
  assert.equal(captain.alternatives.length, 2);
  assert.equal(glossary.glossaryEntryApplies("Captain", captain), false);
  assert.deepEqual(glossary.resolveGlossaryEntriesForText("Captain or CPT", entries).map(item => item.entry.source), ["CPT"]);
  assert.throws(() => glossary.compileGlossaryEntries([
    { source: "CPT", target: "A", kind: "term" }, { source: "CPT", target: "B", kind: "term" },
  ]), /Conflicting glossary targets/);
});

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

test("live official frontier identity overrides catalog ranking and description", async () => {
  const resolver = await importFile("02 Translate Text", "Code", "Resolve-LatestSubscriptionModel.mjs");
  const selected = resolver.selectLatestCatalogModel({
    models: [
      {
        slug: "gpt-5.5",
        visibility: "list",
        priority: 0,
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
  }, "gpt-5.6-sol");
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
  }, "gpt-newest");
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
  assert.equal(values[1][3], "6\u00A0juin\u00A01944");
  assert.equal(values[2][3], "Image 1: 6 Jun 1944");
  assert.equal(counts.editorialSegmentsStandardized, 1);
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

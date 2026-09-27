"use strict";

// Literal prefilters and indexes only skip work whose regex or filter result is
// already decided. Each case compares the optimized module with the direct,
// unfiltered formulation it replaces, including characters that case-fold onto
// ASCII (U+017F, U+212A) and malformed audit records.
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const importFile = (...segments) => import(pathToFileURL(path.join(ROOT, ...segments)).href);
const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function directResolve(value, entries, glossaryPattern) {
  const claimed = new Set();
  const pass = (text, caseSensitive) => {
    let unclaimed = text;
    const matches = [];
    for (const entry of entries) {
      if (entry.contextual || (!caseSensitive && !entry.allowCaseInsensitiveFallback) || claimed.has(entry.source)) continue;
      const pattern = glossaryPattern(entry.source, { caseSensitive });
      if (!pattern.test(unclaimed)) continue;
      matches.push({ entry, matchMode: caseSensitive ? "exact" : "case-insensitive-unique" });
      claimed.add(entry.source);
      pattern.lastIndex = 0;
      unclaimed = unclaimed.replace(pattern, match => " ".repeat(match.length));
    }
    return { unclaimed, matches };
  };
  const exact = pass(String(value ?? ""), true);
  return [...exact.matches, ...pass(exact.unclaimed, false).matches];
}

test("glossary resolution prefilters agree with direct boundary patterns", async () => {
  const glossary = await importFile("02 Translate Text", "Code", "GlossaryResolution.mjs");
  const { glossaryPattern } = await importFile("02 Translate Text", "Code", "GlossaryPatterns.mjs");
  const entries = glossary.compileGlossaryEntries([
    { source: "Task Force", target: "Force opérationnelle" }, { source: "Task", target: "Tâche" },
    { source: "KIA", target: "Tué au combat" }, { source: "Kit", target: "Trousse" },
    { source: "Élan", target: "Élan" }, { source: "SS", target: "SS" }, { source: "C.O.", target: "C.O." },
    { source: "Captain", target: "Capitaine", kind: "definition" }, { source: "Captain", target: "Commandant", kind: "definition" },
  ]);
  const texts = [
    "Task Force and task", "TASK FORCE", "Taſk force", "Kit KIA", "kit KIT Kit", "élan ÉLAN",
    "ſſ and ss", "c.o. C.O.", "Captain", "", "Task Force", "xTask Taskx _Task", "İstanbul Task",
  ];
  for (const text of texts) {
    assert.deepEqual(glossary.resolveGlossaryEntriesForText(text, entries), directResolve(text, entries, glossaryPattern), text);
    for (const entry of entries) {
      const direct = !entry.contextual && (glossaryPattern(entry.source, { caseSensitive: true }).test(text) ||
        (entry.allowCaseInsensitiveFallback && glossaryPattern(entry.source, { caseSensitive: false }).test(text)));
      assert.equal(glossary.glossaryEntryApplies(text, entry), direct, `${entry.source} in ${text}`);
    }
  }
  assert.equal(glossary.resolveGlossaryEntriesForText("Taſk", entries)[0]?.entry.source, "Task");
});

test("reused glossary presence patterns keep independent results across calls", async () => {
  const { containsGlossaryTarget } = await importFile("02 Translate Text", "Code", "GlossaryPatterns.mjs");
  const check = { target: "Cne", kind: "term" };
  for (let repeat = 0; repeat < 3; repeat++) {
    assert.equal(containsGlossaryTarget("Le Cne et le Cne", check, "French"), true);
    assert.equal(containsGlossaryTarget("Cne", check, "French"), true);
    assert.equal(containsGlossaryTarget("Cnes", check, "French"), false);
  }
});

test("editorial masking skips only protected strings that cannot occur", () => {
  const rules = require(path.join(ROOT, "Code", "TranslationEditorialRules.cjs"));
  const protectedStrings = ["Force opérationnelle", "absent", "12 km", "km"];
  assert.equal(rules.normalizeEditorialText("La Force opérationnelle : 12 km", "French", { protectedStrings }),
    "La Force opérationnelle : 12 km");
  assert.equal(rules.normalizeEditorialText("Force opérationnelle : 5 %", "French", { protectedStrings: [] }),
    "Force opérationnelle : 5 %");
  assert.throws(() => rules.normalizeEditorialText("Alpha", "French", { protectedStrings: [5, "Alpha"] }), TypeError);
});

test("diagram term prefilter agrees with the non-Unicode case-insensitive pattern", () => {
  const { matchesTerm } = require(path.join(ROOT, "03 Translate Diagrams", "Code", "DiagramTranslationPlan.cjs"));
  const direct = (text, term) => new RegExp(`(^|[^A-Za-z0-9_])(${escape(term)})(?=$|[^A-Za-z0-9_])`, "gi").test(text);
  const terms = ["Task", "task force", "KIA", "C.O.", "Élan", "ß", "(U)", "s"];
  const texts = ["TASK FORCE", "Taſk", "KIA", "c.o.", "élan", "SS ß", "(u) marking", "x-task-y", "tasks", "ſ", ""];
  for (const term of terms) for (const text of texts) assert.equal(matchesTerm(text, term), direct(text, term), `${term} in ${text}`);
});

test("indexed native GREP planning matches per-story record filtering", () => {
  const { planGrep } = require(path.join(ROOT, "Code", "InDesignGrepPlan.cjs"));
  const grep = require(path.join(ROOT, "Code", "TranslationGrepRules.cjs"));
  const policy = grep.resolveGrepRules("French");
  const stories = [{ id: 1, referenceIds: [] }, { id: "2", referenceIds: [] }];
  const records = [];
  for (const rule of [...policy.applicable].reverse()) {
    for (const story of stories) {
      const storyId = story.id === 1 ? "1" : 2;
      records.push({ kind: "GREP_MATCH", storyId, ruleId: rule.id, text: rule.id === "fr_punctuation" ? " " : " ", reason: rule.id === "fr_punctuation" ? "" : "protected_source" });
      records.push({ kind: "GREP_RUN", storyId, ruleId: rule.id, matches: 1 });
    }
  }
  records.push({ kind: "GREP_MATCH", storyId: "1", ruleId: 7, text: " " }, { kind: "NOTE", storyId: "1", ruleId: "fr_punctuation" });
  const audit = { status: "inventory_complete", policySha256: policy.sha256, stories, records, protectedStyles: ["Credits"] };
  const plan = planGrep(audit, "French");
  assert.equal(plan.status, "changes_required");
  assert.deepEqual(plan.scopes.map(scope => [scope.storyId, scope.rules[0].id]), [[1, "fr_punctuation"], ["2", "fr_punctuation"]]);
  assert.deepEqual(plan.totals.find(total => total.id === "fr_punctuation"), { id: "fr_punctuation", runs: 2, matches: 2, changes: 2, excluded: 0, noops: 0 });
  records.push({ kind: "GREP_RUN", storyId: 1, ruleId: "fr_punctuation", matches: 1 });
  assert.throws(() => planGrep(audit, "French"), /Incomplete native GREP run: fr_punctuation, story 1/);
  records.pop();
  records.splice(3, 0, null);
  assert.throws(() => planGrep(audit, "French"), TypeError);
});

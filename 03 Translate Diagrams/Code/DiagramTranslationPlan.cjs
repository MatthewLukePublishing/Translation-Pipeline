"use strict";

// Pure, offline preparation. Illustrator remains responsible for locating and
// applying text; this module never opens artwork or queries a model.
const clean = value => String(value ?? "").trim();
const languageKeys = entry => Object.keys(entry).filter(key => key && !key.startsWith("_") && !/ Definition$/i.test(key));

function buildLedgerGlossary(words, acronyms, termKey) {
  const pairs = new Map();
  for (const [payload, kind] of [[words, "word"], [acronyms, "acronym"]]) {
    for (const [source, entry] of Object.entries(payload)) {
      if (!entry || typeof entry !== "object") continue;
      const key = languageKeys(entry).find(key => clean(key) === termKey);
      const target = clean(entry[key]);
      if (!key || !target) continue;
      const ordinal = languageKeys(entry).indexOf(key) + 1;
      const context = clean(entry[`${termKey} Definition`]) || clean(entry[`_${ordinal}`]);
      pairs.set(clean(source), { source: clean(source), target, context, kind });
    }
  }
  return [...pairs.values()].sort((a, b) => b.source.length - a.source.length);
}

function matchesTerm(text, term) {
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the Illustrator worker's glossary lookup exactly (not fuzzy matching).
  return new RegExp(`(^|[^A-Za-z0-9_])(${escaped})(?=$|[^A-Za-z0-9_])`, "gi").test(text);
}

function ledgerScan(entry, targetLanguage, glossaryPairs) {
  const used = new Map();
  const runs = entry.textUnits.filter(unit => unit.kind === "prose").map(unit => {
    const matches = glossaryPairs.filter(pair => matchesTerm(unit.plain, pair.source));
    for (const pair of matches) used.set(`${pair.source.toLowerCase()}\n${pair.target}`, pair);
    return { id: String(unit.id), originalText: unit.plain, glossaryMatches: matches.map(({ source, target }) => ({ source, target })) };
  });
  return {
    file: entry.file, targetLanguage, runs, glossary: [...used.values()],
    diagramContext: [{ name: entry.file, units: entry.textUnits.map(unit => ({ id: String(unit.id), text: unit.plain })) }],
  };
}

const BATCH_LIMITS = Object.freeze({ diagrams: 8, items: 160, characters: 24000 });

function packDiagramScans(scans, limits = BATCH_LIMITS) {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid diagram batch limit.");
  }
  const batches = [];
  let batch = [];
  let items = 0;
  let characters = 0;
  for (const scan of scans) {
    if (!scan.runs.length) continue;
    const size = JSON.stringify(scan).length;
    // Keep a diagram intact for context. Exceptionally large diagrams retain
    // the previous one-diagram request behavior; they are never split silently.
    if (batch.length && (batch.length >= limits.diagrams || items + scan.runs.length > limits.items || characters + size > limits.characters)) {
      batches.push(batch); batch = []; items = 0; characters = 0;
    }
    batch.push(scan); items += scan.runs.length; characters += size;
  }
  if (batch.length) batches.push(batch);
  return batches.map(group => {
    const glossary = new Map();
    for (const scan of group) for (const pair of scan.glossary) glossary.set(JSON.stringify(pair), pair);
    if (group.some(scan => scan.targetLanguage !== group[0].targetLanguage)) throw new Error("A batch cannot mix target languages.");
    return {
      targetLanguage: group[0].targetLanguage,
      runs: group.flatMap(scan => scan.runs),
      glossary: [...glossary.values()],
      diagramContext: group.flatMap(scan => scan.diagramContext),
    };
  });
}

function compactQuery(scan, items) {
  if (items.length !== scan.runs.length) throw new Error("Input item count differs from diagram runs.");
  const originals = new Map();
  const aliases = new Map();
  const unchanged = [];
  const runs = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const run = scan.runs[i];
    if (String(run.id) !== item.id || originals.has(item.id)) throw new Error("Invalid or duplicate diagram text id.");
    originals.set(item.id, run);
    if (typeof item.localTranslation === "string" || item.skipTranslation) {
      unchanged.push({ id: item.id, translated: item.localTranslation ?? item.sourceText });
    }
    else {
      const alias = `t${runs.length + 1}`;
      aliases.set(alias, item.id);
      runs.push({ ...run, id: alias });
    }
  }
  const byOriginal = new Map([...aliases].map(([alias, id]) => [id, alias]));
  const contexts = scan.diagramContext || [{ name: "Diagram", units: scan.runs.map(run => ({ id: String(run.id), text: run.originalText })) }];
  const diagramContext = contexts.map(context => ({
    name: context.name,
    units: context.units.map(unit => ({ id: byOriginal.get(unit.id), text: unit.text })),
  }));
  return { query: { ...scan, runs, diagramContext }, aliases, unchanged };
}

function expandResponse(plan, response) {
  const restored = [...plan.unchanged];
  const seen = new Set();
  if (!Array.isArray(response?.translations)) throw new Error("Missing compact translations.");
  for (const row of response.translations) {
    if (!plan.aliases.has(row.id) || seen.has(row.id)) throw new Error("Unexpected or repeated compact translation id.");
    seen.add(row.id);
    restored.push({ id: plan.aliases.get(row.id), translated: row.translated });
  }
  if (seen.size !== plan.aliases.size) throw new Error("Missing compact translation id.");
  return { translations: restored };
}

module.exports = { BATCH_LIMITS, buildLedgerGlossary, matchesTerm, ledgerScan, packDiagramScans, compactQuery, expandResponse };

import { glossaryPattern } from "./GlossaryPatterns.mjs";

function folded(value) {
  return String(value ?? "").normalize("NFC").toLocaleLowerCase("en-US");
}

function sorted(entries) {
  return [...entries].sort((left, right) => {
    const lengthDifference = String(right.source).length - String(left.source).length;
    return lengthDifference || 0;
  });
}

export function compileGlossaryEntries(rawEntries) {
  const exact = new Map();
  for (const rawEntry of rawEntries || []) {
    const source = String(rawEntry?.source ?? "");
    const target = String(rawEntry?.target ?? "");
    if (!source || !target) continue;
    const entry = { ...rawEntry, source, target };
    const existing = exact.get(source);
    if (existing && existing.target !== target) {
      throw new Error(`Conflicting glossary targets for exact source '${source}'.`);
    }
    if (!existing) exact.set(source, entry);
  }

  const byFoldedSource = new Map();
  for (const entry of exact.values()) {
    const key = folded(entry.source);
    if (!byFoldedSource.has(key)) byFoldedSource.set(key, []);
    byFoldedSource.get(key).push(entry);
  }

  return sorted([...exact.values()].map((entry) => ({
    ...entry,
    foldedSource: folded(entry.source),
    allowCaseInsensitiveFallback: byFoldedSource.get(folded(entry.source)).length === 1,
  })));
}

function claimMatches(text, entries, caseSensitive, claimedSources) {
  let unclaimed = text;
  const matches = [];
  for (const entry of entries) {
    if (!caseSensitive && !entry.allowCaseInsensitiveFallback) continue;
    if (claimedSources.has(entry.source)) continue;
    const pattern = glossaryPattern(entry.source, { caseSensitive });
    pattern.lastIndex = 0;
    if (!pattern.test(unclaimed)) continue;
    matches.push({ entry, matchMode: caseSensitive ? "exact" : "case-insensitive-unique" });
    claimedSources.add(entry.source);
    pattern.lastIndex = 0;
    unclaimed = unclaimed.replace(pattern, (match) => " ".repeat(match.length));
  }
  return { unclaimed, matches };
}

export function resolveGlossaryEntriesForText(value, compiledEntries) {
  const entries = compileGlossaryEntries(compiledEntries);
  const claimedSources = new Set();
  const exact = claimMatches(String(value ?? ""), entries, true, claimedSources);
  const fallback = claimMatches(exact.unclaimed, entries, false, claimedSources);
  return [...exact.matches, ...fallback.matches];
}

export function glossaryEntryApplies(value, entry) {
  const text = String(value ?? "");
  const exact = glossaryPattern(entry.source, { caseSensitive: true });
  if (exact.test(text)) return true;
  if (!entry.allowCaseInsensitiveFallback) return false;
  return glossaryPattern(entry.source, { caseSensitive: false }).test(text);
}

export function glossaryAmbiguities(compiledEntries) {
  const groups = new Map();
  for (const entry of compileGlossaryEntries(compiledEntries)) {
    if (!groups.has(entry.foldedSource)) groups.set(entry.foldedSource, []);
    groups.get(entry.foldedSource).push(entry);
  }
  return [...groups.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([foldedSource, entries]) => ({
      foldedSource,
      sources: entries.map((entry) => entry.source),
      targets: entries.map((entry) => entry.target),
    }));
}


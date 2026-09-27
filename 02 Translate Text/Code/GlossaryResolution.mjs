import { reusableGlossaryPattern } from "./GlossaryPatterns.mjs";

// Rows are resolved against the same glossary repeatedly; folding is pure.
const FOLDED_LIMIT = 10000;
const foldedValues = new Map();
function folded(value) {
  const text = String(value ?? "");
  let result = foldedValues.get(text);
  if (result === undefined) {
    result = text.normalize("NFC").toLocaleLowerCase("en-US");
    if (foldedValues.size >= FOLDED_LIMIT) foldedValues.clear();
    foldedValues.set(text, result);
  }
  return result;
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
      if (existing.kind === "definition" && entry.kind === "definition") {
        existing.contextual = true;
        existing.alternatives ||= [{ target: existing.target, sourceTerm: existing.sourceTerm || "" }];
        if (!existing.alternatives.some(choice => choice.target === target)) {
          existing.alternatives.push({ target, sourceTerm: entry.sourceTerm || "" });
        }
        continue;
      }
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
    allowCaseInsensitiveFallback: !entry.contextual && byFoldedSource.get(folded(entry.source)).length === 1,
  })));
}

const ASCII_TEXT = /^[\0-\x7F]*$/;
const NON_ASCII_CHARACTER = /[^\0-\x7F]/gu;
const FOLDS_ONTO_ASCII = /^[\0-\x7F]$/iu;
const loweredAsciiSources = new Map();
function loweredAsciiSource(source) {
  let result = loweredAsciiSources.get(source);
  if (result === undefined) {
    result = ASCII_TEXT.test(source) ? source.toLowerCase() : null;
    if (loweredAsciiSources.size >= FOLDED_LIMIT) loweredAsciiSources.clear();
    loweredAsciiSources.set(source, result);
  }
  return result;
}

// Ask the regex engine itself whether any non-ASCII character in the text is
// case-insensitively equivalent to an ASCII character (for example U+017F).
function mayFoldOntoAscii(text) {
  for (const [character] of text.matchAll(NON_ASCII_CHARACTER)) {
    if (FOLDS_ONTO_ASCII.test(character)) return true;
  }
  return false;
}

// Prefilters only skip entries whose pattern cannot match; every candidate is
// still decided by the same boundary pattern. An exact match is a literal
// occurrence. Without characters that fold onto ASCII, a case-insensitive
// match of an all-ASCII source is an ASCII run whose lowercase form occurs in
// the lowercased text.
function claimMatches(text, entries, caseSensitive, claimedSources) {
  let unclaimed = text;
  const matches = [];
  const asciiPrefilter = !caseSensitive && !mayFoldOntoAscii(unclaimed);
  let lowered = asciiPrefilter ? unclaimed.toLowerCase() : "";
  for (const entry of entries) {
    if (entry.contextual) continue;
    if (!caseSensitive && !entry.allowCaseInsensitiveFallback) continue;
    if (claimedSources.has(entry.source)) continue;
    if (caseSensitive) {
      if (!unclaimed.includes(entry.source)) continue;
    } else if (asciiPrefilter) {
      const source = loweredAsciiSource(entry.source);
      if (source !== null && !lowered.includes(source)) continue;
    }
    const pattern = reusableGlossaryPattern(entry.source, { caseSensitive });
    if (!pattern.test(unclaimed)) continue;
    matches.push({ entry, matchMode: caseSensitive ? "exact" : "case-insensitive-unique" });
    claimedSources.add(entry.source);
    pattern.lastIndex = 0;
    unclaimed = unclaimed.replace(pattern, (match) => " ".repeat(match.length));
    if (asciiPrefilter) lowered = unclaimed.toLowerCase();
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
  if (entry.contextual) return false;
  const text = String(value ?? "");
  const exact = reusableGlossaryPattern(entry.source, { caseSensitive: true });
  if (exact.test(text)) return true;
  if (!entry.allowCaseInsensitiveFallback) return false;
  return reusableGlossaryPattern(entry.source, { caseSensitive: false }).test(text);
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

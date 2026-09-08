export function escapeRegExp(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function glossaryPattern(value, options = {}) {
  const source = String(value ?? "");
  const escaped = escapeRegExp(source);
  const left = /^[\p{L}\p{M}\p{N}_]/u.test(source) ? "(?<![\\p{L}\\p{M}\\p{N}_])" : "";
  const right = /[\p{L}\p{M}\p{N}_]$/u.test(source) ? "(?![\\p{L}\\p{M}\\p{N}_])" : "";
  const defaultCaseSensitive = source.length <= 4 && source === source.toUpperCase();
  const caseSensitive = options.caseSensitive ?? defaultCaseSensitive;
  const flags = caseSensitive ? "gu" : "giu";
  return new RegExp(`${left}${escaped}${right}`, flags);
}

// Source matching and explicit abbreviations stay exact. In French prose,
// a one-word definition ending in -é may take regular gender/number agreement.
// This is a terminology-presence check, not a substitute for grammatical review.
export function containsGlossaryTarget(text, check, targetLanguage) {
  if (glossaryPattern(check.target).test(String(text ?? ""))) return true;
  if (!/^French$/i.test(String(targetLanguage)) || check.kind !== "definition"
      || !/^[\p{L}\p{M}]+é$/u.test(check.target)) return false;
  return ["e", "s", "es"].some(ending =>
    glossaryPattern(`${check.target}${ending}`).test(String(text ?? "")));
}

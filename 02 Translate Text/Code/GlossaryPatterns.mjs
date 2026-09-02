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

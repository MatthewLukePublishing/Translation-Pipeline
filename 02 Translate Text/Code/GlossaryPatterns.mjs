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

// Deliberately finite: do not accept arbitrary substrings (Zug in Zugang) or
// arbitrary compound suffixes. This is terminology presence, not grammar QA.
const GERMAN_NOUN_FORMS = new Map(Object.entries({
  kompanie: ['Kompanien', 'Kompanieebene', 'Kompaniechef', 'Kompaniemörser'],
  infanterie: ['Marineinfanterie', 'Infanterieausbildung', 'Infanterieausbildungsbataillon', 'Infanterieschule', 'Infanterieeinheit', 'Infanterieeinheiten'],
  pionier: ['Pioniere', 'Pionieren', 'Pioniers', 'Pionierkommando', 'Pionierkommandos'],
  ultraviolett: ['Ultraviolettstrahlung'],
  aufklärung: ['Aufklärungs-', 'Aufklärungseinheit', 'Aufklärungseinheiten', 'Aufklärungsauftrag', 'Aufklärungsmission'],
  artillerie: ['Artillerieschießen'],
  brigade: ['Brigaden', 'Brigadestärke'],
  gruppe: ['Gruppen', 'Gruppenführer'],
  zug: ['Zugführer', 'Zugführers', 'Zugführern'],
}));

// Source matching and explicit abbreviations stay exact. In French prose,
// a one-word definition ending in -é may take regular gender/number agreement.
// This is a terminology-presence check, not a substitute for grammatical review.
export function containsGlossaryTarget(text, check, targetLanguage) {
  if (glossaryPattern(check.target).test(String(text ?? ""))) return true;
  if (/^German$/i.test(String(targetLanguage))) {
    // An abbreviation may expand to this adjective, so permit its agreement
    // regardless of check.kind. No actual acronym receives suffix matching.
    if (String(check.target).toLocaleLowerCase('de') === 'fortgeschritten') {
      return /(?<![\p{L}\p{M}\p{N}_])fortgeschritten(?:er)?(?:e|en|em|er|es)?(?![\p{L}\p{M}\p{N}_])/iu.test(String(text ?? ''));
    }
    if (check.kind !== 'definition') return false;
    const forms = GERMAN_NOUN_FORMS.get(String(check.target).toLocaleLowerCase('de')) || [];
    return forms.some(form => {
      // A suspended compound ending in '-' still needs a following boundary.
      if (form.endsWith('-')) return new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRegExp(form)}(?=\\s|$)`, 'iu').test(String(text ?? ''));
      return glossaryPattern(form).test(String(text ?? ''));
    });
  }
  if (!/^French$/i.test(String(targetLanguage)) || check.kind !== "definition"
      || !/^[\p{L}\p{M}]+é$/u.test(check.target)) return false;
  return ["e", "s", "es"].some(ending =>
    glossaryPattern(`${check.target}${ending}`).test(String(text ?? "")));
}

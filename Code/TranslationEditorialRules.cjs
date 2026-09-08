"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const POLICY_PATH = path.join(__dirname, "TranslationEditorialRules.json");
const LANGUAGES = ["English", "French", "German", "Spanish", "Portuguese", "Dutch", "Italian", "Turkish", "Polish", "Swedish"];
const STAGES = ["glossary", "text", "diagram", "caption", "icml", "layout"];

function loadEditorialRules() {
  const bytes = fs.readFileSync(POLICY_PATH);
  const policy = JSON.parse(bytes.toString("utf8"));
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.shared) || !Array.isArray(policy.languages)) {
    throw new Error("Invalid translation editorial policy schema.");
  }
  const names = policy.languages.map(entry => entry.language);
  if (names.length !== LANGUAGES.length || new Set(names).size !== LANGUAGES.length || LANGUAGES.some(name => !names.includes(name))) {
    throw new Error("Translation editorial policy must cover exactly the ten supported languages.");
  }
  for (const rule of policy.shared) {
    if (!rule.id || !rule.instruction || !rule.stages?.length || rule.stages.some(stage => !STAGES.includes(stage))) {
      throw new Error("Invalid editorial rule or pipeline stage.");
    }
  }
  if (new Set(policy.shared.map(rule => rule.id)).size !== policy.shared.length) throw new Error("Duplicate editorial rule IDs.");
  return { policy, sha256: crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase() };
}

function resolveEditorialRules(language, stage) {
  if (!STAGES.includes(stage)) throw new Error(`Unknown editorial pipeline stage: ${stage}`);
  const { policy, sha256 } = loadEditorialRules();
  const requested = String(language || "").trim().toLowerCase();
  const name = requested === "brazilian portuguese" ? "portuguese" : requested;
  const selected = policy.languages.find(entry => entry.language.toLowerCase() === name);
  if (!selected) throw new Error(`No editorial policy for language: ${language}`);
  const effective = { ...selected };
  if (requested === "brazilian portuguese") effective.quotes = "“texto”";
  return {
    version: policy.version, sha256, stage, language: effective,
    precedence: policy.precedence,
    rules: policy.shared.filter(rule => rule.stages.includes(stage)),
  };
}

function editorialPrompt(language, stage, expectedSha256) {
  const selected = resolveEditorialRules(language, stage);
  if(expectedSha256 && selected.sha256!==expectedSha256) throw new Error("Editorial rules changed during the job; start a new rules review.");
  const locale = selected.language;
  const localRules = stage === "layout" ? [] : [
    locale.capitalization, locale.acronyms, locale.hyphens,
    ...(stage === "glossary" ? [] : [
      locale.dateRule, locale.punctuation,
      `Use ${locale.quotes} quotation typography and native-language placement of quotation punctuation.`,
      `Use decimal separator ${JSON.stringify(locale.decimal)} and grouping separator ${JSON.stringify(locale.grouping)} in ordinary quantities, never in years, page numbers, identifiers or official designations. Percentage example: ${locale.percentExample}.`,
      `Measurement policy: ${locale.units === "metric_only" ? "metric only outside the stated exceptions" : "metric first, then imperial"}.`,
    ]),
  ];
  return [
    `Publishing editorial rules ${selected.version}; ${locale.language}; stage ${stage}; SHA-256 ${selected.sha256}.`,
    ...selected.precedence,
    ...selected.rules.map(rule => `[${rule.id}] ${rule.instruction}`),
    ...localRules,
    ...(["text", "diagram", "caption"].includes(stage) ? ["Produce the final language-specific Unicode spacing during translation, before export/import. Do not defer text corrections to InDesign GREP. NNBSP is a label, not text or GREP syntax; use the actual U+202F character where required, and U+00A0 for NBSP."] : []),
    "Apply only relevant rules. Do not modify protected source quotations, official designations, glossary locks, literal markup or identifiers to satisfy a generic style rule.",
  ].join("\n");
}

// Protect literal syntax before any text-only typography operation. Caller-provided
// strings protect book-specific names and exact glossary entries as well.
function outsideProtectedText(value, protectedStrings, transform) {
  const originals = [];
  const reserve = text => { const token = `\uE100${originals.length}\uE101`; originals.push(text); return token; };
  let masked = String(value ?? "");
  if (/[\uE100\uE101]/u.test(masked)) throw new Error("Reserved editorial masking characters in input.");
  for (const text of [...new Set(protectedStrings || [])].filter(Boolean).sort((a,b) => b.length-a.length)) {
    const escaped=text.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    const pattern=new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,"gu");
    masked = masked.replace(pattern, () => reserve(text));
  }
  masked = masked.replace(/<\?[\s\S]*?\?>|<\/?[A-Za-z][^>]*>|&(?:#\d+|#x[\da-fA-F]+|[A-Za-z]+);|(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]+|⟦[^⟧]+⟧|__lock_[A-Za-z0-9_]+__/gu, reserve);
  return transform(masked).replace(/\uE100(\d+)\uE101/gu, (_match,index) => originals[Number(index)]);
}

const FRENCH_MONTHS = [
  ["janvier", "Jan|Janv\\.?|janvier"], ["février", "Feb|Fév\\.?|Févr\\.?|février"],
  ["mars", "Mar\\.?|mars"], ["avril", "Apr|Avr\\.?|avril"], ["mai", "May|mai"],
  ["juin", "Jun|juin"], ["juillet", "Jul|Juil\\.?|juillet"], ["août", "Aug|août"],
  ["septembre", "Sep\\.?|Sept\\.?|septembre"], ["octobre", "Oct\\.?|octobre"],
  ["novembre", "Nov\\.?|novembre"], ["décembre", "Dec\\.?|Déc\\.?|décembre"],
];

const DATE_MONTHS = {
  English: ["Jan|January", "Feb|February", "Mar|March", "Apr|April", "May", "Jun|June", "Jul|July", "Aug|August", "Sep|Sept|September", "Oct|October", "Nov|November", "Dec|December"],
  German: ["Jan|Januar", "Feb|Februar", "Mär|März", "Apr|April", "Mai", "Jun|Juni", "Jul|Juli", "Aug|August", "Sep|Sept|September", "Okt|Oktober", "Nov|November", "Dez|Dezember"],
  Spanish: ["enero|ene", "febrero|feb", "marzo|mar", "abril|abr", "mayo|may", "junio|jun", "julio|jul", "agosto|ago", "septiembre|sep|sept", "octubre|oct", "noviembre|nov", "diciembre|dic"],
  Portuguese: ["janeiro|jan", "fevereiro|fev", "março|mar", "abril|abr", "maio|mai", "junho|jun", "julho|jul", "agosto|ago", "setembro|set", "outubro|out", "novembro|nov", "dezembro|dez"],
  Dutch: ["jan|januari", "feb|februari", "mrt|maart", "apr|april", "mei", "jun|juni", "jul|juli", "aug|augustus", "sep|september", "okt|oktober", "nov|november", "dec|december"],
  Italian: ["gen|gennaio", "feb|febbraio", "mar|marzo", "apr|aprile", "mag|maggio", "giu|giugno", "lug|luglio", "ago|agosto", "set|settembre", "ott|ottobre", "nov|novembre", "dic|dicembre"],
  Turkish: ["Oca|Ocak", "Şub|Şubat", "Mar|Mart", "Nis|Nisan", "May|Mayıs", "Haz|Haziran", "Tem|Temmuz", "Ağu|Ağustos", "Eyl|Eylül", "Eki|Ekim", "Kas|Kasım", "Ara|Aralık"],
  Polish: ["sty|stycznia", "lut|lutego", "mar|marca", "kwi|kwietnia", "maj|maja", "cze|czerwca", "lip|lipca", "sie|sierpnia", "wrz|września", "paź|października", "lis|listopada", "gru|grudnia"],
  Swedish: ["jan|januari", "feb|februari", "mar|mars", "apr|april", "maj", "jun|juni", "jul|juli", "aug|augusti", "sep|september", "okt|oktober", "nov|november", "dec|december"],
};

function normalizeEditorialText(value, language, options = {}) {
  if (options.protected === true) return String(value ?? "");
  const selected = options.languageRules || resolveEditorialRules(language, "text").language;
  return outsideProtectedText(value, options.protectedStrings, original => {
    let text = original;
    const months=DATE_MONTHS[selected.language];
    if(months){
      const withDe=["Spanish","Portuguese"].includes(selected.language);
      for(const variants of months){
        const separator=withDe ? "[ \\u00A0\\u202F]+de[ \\u00A0\\u202F]+" : "[ \\u00A0\\u202F]+";
        const date=new RegExp(`\\b(\\d{1,2})${separator}(?:${variants})\\.?${separator}(\\d{4})\\b`,"giu");
        text=text.replace(date,(match,day,year)=> Number(day)<1||Number(day)>31 ? match : [day, ...(withDe?["de"]:[]), variants.split("|")[0], ...(withDe?["de"]:[]), year].join("\u00A0"));
      }
    }
    if (selected.language === "French") {
      for (const [month,aliases] of FRENCH_MONTHS) {
        const pattern = new RegExp(`\\b(\\d{1,2})(?:er)?[ \\u00A0\\u202F]+(?:${aliases})[ \\u00A0\\u202F]+(\\d{4})\\b`, "giu");
        text = text.replace(pattern, (match,day,year) => {
          if (Number(day)<1 || Number(day)>31) return match;
          return `${Number(day)===1 ? "1er" : day}\u00A0${month}\u00A0${year}`;
        });
      }
      // No newline-consuming \s: paragraph and style structure remain intact.
      text = text.replace(/([^\s])[ \u00A0\u202F\u2009]*([;!?])/gu, "$1\u202F$2");
      text = text.replace(/([^\s\d])[ \u00A0\u202F\u2009]*:(?!\d)/gu, "$1\u202F:");
      text = text.replace(/«[ \u00A0\u202F\u2009]*(?=\S)/gu, "«\u202F");
      text = text.replace(/(\S)[ \u00A0\u202F\u2009]*»/gu, "$1\u202F»");
      text = text.replace(/(\S)[ \u00A0\u202F\u2009]+—[ \u00A0\u202F\u2009]+(?=\S)/gu, "$1 —\u202F");
    }
    const percentGap=selected.percentExample.match(/5(.*)%/u)?.[1];
    if(percentGap!==undefined) text=text.replace(/(\d)[ \u00A0\u202F\u2009]*%/gu,`$1${percentGap}%`);
    // Existing measurement boundaries only; attached calibres such as 9mm are
    // not guessed to be ordinary quantities. Semantic review handles those cases.
    text=text.replace(/(\d)[ \u00A0\u202F\u2009]+(mm|cm|km|mg|kg|in|ft|yd|mi|min|MOA|mil|m|g|s|°C)(?![\p{L}\p{N}_])/gu,"$1\u00A0$2");
    text=text.replace(/(\d)[ \u00A0\u202F]+([+−×÷=≠≈<>≤≥±])[ \u00A0\u202F]+(?=[+−-]?\d)/gu,"$1\u00A0$2\u00A0");
    // Lazy loading avoids the policy module's language-list dependency cycle.
    // All applicable matrix expressions run before the translation is exported.
    return require("./IcmlGrep.cjs").transformText(text, selected.language).text;
  });
}

function auditEditorialText(value, language, options = {}) {
  if(options.protected === true) return [];
  const normalized=normalizeEditorialText(value,language,options);
  return normalized===String(value ?? "") ? [] : [{
    code:"EDITORIAL_TYPOGRAPHY", severity:"error",
    message:"Text does not match the language-specific date, punctuation, percentage, unit or mathematical spacing rules.",
  }];
}

module.exports={LANGUAGES,STAGES,loadEditorialRules,resolveEditorialRules,editorialPrompt,normalizeEditorialText,auditEditorialText};

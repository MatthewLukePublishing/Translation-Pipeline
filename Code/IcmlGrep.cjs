"use strict";
// Text-only execution of the maintained GREP matrix. Never serialize the XML:
// preserve every original byte except the exact spacing characters being edited.
const { resolveGrepRules, previewExpression, replacementForMatch } = require("./TranslationGrepRules.cjs");
const SPACE = /^[ \u00a0\u2009\u202f]$/u;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/y;
const BREAKS = new Set(["\t", "\r", "\n", "\u2028", "\u2029"]);
const NONSPACE = /\S/g;
const LITERAL_SYNTAX = /(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]+|⟦[^⟧]+⟧|__lock_[A-Za-z0-9_]+__/gu;
function decodeEntity(raw) {
  const names = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  if (names[raw]) return names[raw];
  const hex = raw.startsWith("&#x");
  const n = Number.parseInt(raw.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  if (!Number.isInteger(n) || n > 0x10ffff || (n < 32 && ![9,10,13].includes(n)) ||
      (n >= 0xd800 && n <= 0xdfff) || [0xfffe,0xffff].includes(n)) throw Error("Invalid XML character reference.");
  return String.fromCodePoint(n);
}
// For one code point, identical to
// /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.
function invalidTextCodePoint(code) {
  return code <= 0x08 || code === 0x0b || code === 0x0c || (code >= 0x0e && code <= 0x1f) ||
    (code >= 0xd800 && code <= 0xdfff) || code === 0xfffe || code === 0xffff;
}
function units(raw, offset = 0) {
  const out = [];
  for (let i = 0; i < raw.length;) {
    let code = raw.codePointAt(i), source = String.fromCodePoint(code), char = source;
    if (char === "&") {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(raw);
      if (!m) throw Error("Unsupported or malformed XML entity.");
      source = m[0]; char = decodeEntity(source); code = char.codePointAt(0);
    }
    if (invalidTextCodePoint(code)) throw Error("Invalid XML text character.");
    out.push({ char, raw: source, start: offset + i, end: offset + i + source.length });
    i += source.length;
  }
  return out;
}
// Attribute values without an entity or invalid character decode to themselves.
const ATTRIBUTE_NEEDS_DECODING = /[&\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u;
function decodeAttribute(value) {
  return ATTRIBUTE_NEEDS_DECODING.test(value) ? units(value).map(u=>u.char).join("") : value;
}
function protectionPatterns(strings) {
  const patterns = [{ literal: null, pattern: LITERAL_SYNTAX }];
  for (const value of new Set(strings || [])) {
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push({ literal: value, pattern: new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu") });
  }
  return patterns;
}
// Protected ranges of the current text. A protected string can match only where
// its literal occurs, so absent strings skip their regular expression. Patterns
// are only used through matchAll, which never changes their lastIndex.
function protectedRanges(text, patterns) {
  const ranges = [];
  for (const { literal, pattern } of patterns) {
    if (typeof literal === "string" && !text.includes(literal)) continue;
    for (const m of text.matchAll(pattern)) ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}
// Apply ascending, non-overlapping edits in one pass.
function spliceAscending(text, edits) {
  let out = "", last = 0;
  for (const edit of edits) { out += text.slice(last, edit.start) + edit.text; last = edit.end; }
  return out + text.slice(last);
}
// Compile each applicable rule once per run. A rule's replacement depends only
// on the matched text, so it is also computed and safety-checked once per text.
function prepareRules(policy) {
  return policy.applicable.map(rule => ({ rule, expression: previewExpression(rule), replacements: new Map() }));
}
function runRules(text, compiled, patterns) {
  const records = [];
  let result = text, ranges = null;
  for (const { rule, expression, replacements } of compiled) {
    const matches = [...result.matchAll(expression)];
    const edits = [];
    let excluded = 0;
    for (const match of matches) {
      const end = match.index + match[0].length;
      if (/[\t\r\n\u2028\u2029]/u.test(match[0])) { excluded++; continue; }
      // Ranges are recomputed only after an earlier rule changed this text.
      ranges ??= protectedRanges(result, patterns);
      if (ranges.some(([a,b]) => a < end && b > match.index)) { excluded++; continue; }
      let replacement = replacements.get(match[0]);
      if (replacement === undefined) {
        replacement = replacementForMatch(rule, match[0]);
        // Reject any expansion of the allowed transformation beyond horizontal spaces.
        if (match[0].replace(/[ \u00a0\u2009\u202f]/gu, "") !== replacement.replace(/[ \u00a0\u2009\u202f]/gu, "")) throw Error(`Unsafe GREP replacement: ${rule.id}`);
        replacements.set(match[0], replacement);
      }
      if (replacement !== match[0]) edits.push({ start: match.index, end, text: replacement });
    }
    // matchAll yields ascending, non-overlapping matches.
    if (edits.length) { result = spliceAscending(result, edits); ranges = null; }
    records.push({ ruleId: rule.id, matches: matches.length, changes: edits.length, excluded });
  }
  return { text: result, records };
}
// Map only changed whitespace runs back into their original Content nodes.
// Nonspacing characters (including entity spellings) never move between styles.
function spacingEdits(sourceUnits, revised) {
  const target = Array.from(revised), edits = [];
  let a = 0, b = 0;
  while (a < sourceUnits.length || b < target.length) {
    const start = a, begin = b;
    while (a < sourceUnits.length && SPACE.test(sourceUnits[a].char)) a++;
    while (b < target.length && SPACE.test(target[b])) b++;
    const before = sourceUnits.slice(start,a).map(u=>u.char).join("");
    const after = target.slice(begin,b).join("");
    if (before !== after) {
      if (start < a) {
        // Preserve the style of the first original space even across split runs.
        for (let i = start; i < a; i++) edits.push({ start: sourceUnits[i].start, end: sourceUnits[i].end, text: i === start ? after : "" });
      } else {
        const position = sourceUnits[start]?.start ?? sourceUnits.at(-1)?.end;
        if (position === undefined) throw Error("Cannot place a space in an empty text scope.");
        edits.push({ start: position, end: position, text: after });
      }
    }
    if (a === sourceUnits.length && b === target.length) break;
    if (!sourceUnits[a] || sourceUnits[a].char !== target[b]) throw Error("GREP attempted a nonspacing or structural change.");
    a++; b++;
  }
  return edits;
}
function transformText(text, language, options = {}) {
  const policy = resolveGrepRules(language);
  const patterns = protectionPatterns(options.protectedStrings);
  const revised = runRules(text, prepareRules(policy), patterns);
  return { text: revised.text, records: revised.records, policySha256: policy.sha256, notApplicable: policy.notApplicable };
}
// Import and verification call the engine once per ICML file with the same
// protection lists. Reuse their derived forms only for an identical all-string
// list; any other value takes the original, uncached path.
function stringListKey(values) {
  if (!Array.isArray(values)) return null;
  for (let i = 0; i < values.length; i++) if (typeof values[i] !== "string") return null;
  return JSON.stringify(values);
}
let protectedStringCache = null, protectedIdCache = null;
function parseScopes(xml, options = {}) {
  // A UTF-16 code unit encodes to at most three UTF-8 bytes.
  if (!(typeof xml === "string" && xml.length * 3 <= 8 * 1024 * 1024) && Buffer.byteLength(xml, "utf8") > 8 * 1024 * 1024) throw Error("ICML exceeds the 8 MiB per-file bound.");
  const stack = [], scopes = [], contentIds = new Set();
  let scope = [], position = 0, roots = 0, contentCount = 0, protectedContents = 0, blockedDepth = 0, propertiesDepth = 0;
  const flush = () => { if (scope.length) scopes.push(scope); scope = []; };
  // ICML often pads numeric IDs; QA uses the workbook's normalized identity.
  const idKey = value => { const s = String(value || "").trim(); return /^\d+$/u.test(s) ? s.replace(/^0+(?=\d)/u,"") : s; };
  const idListKey = stringListKey(options.protectedContentIds);
  let protectedIds;
  if (idListKey !== null && protectedIdCache?.key === idListKey) protectedIds = protectedIdCache.ids;
  else {
    protectedIds = new Set((options.protectedContentIds || []).map(idKey));
    if (idListKey !== null) protectedIdCache = { key: idListKey, ids: protectedIds };
  }
  const styles = new Set(["Credits", ...(options.protectedStyles || [])]);
  const token = /<!\[CDATA\[[\s\S]*?\]\]>|<!--(?:[^-]|-(?!->))*-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?\>/y;
  while (position < xml.length) {
    if (xml[position] !== "<") {
      const next = xml.indexOf("<", position), end = next < 0 ? xml.length : next;
      const raw = xml.slice(position,end);
      if (stack.at(-1)?.name === "Content") {
        const decoded = units(raw,position);
        if (!blockedDepth) {
          for (const u of decoded) {
            if (BREAKS.has(u.char)) flush(); else scope.push(u);
          }
        }
      } else if (!stack.length && raw.replace(/^\uFEFF/u, "").trim()) throw Error("Text outside the XML root.");
      position = end; continue;
    }
    token.lastIndex = position;
    const match = token.exec(xml);
    if (!match) throw Error("Malformed/unsupported ICML markup (DTD is not accepted).");
    const raw = match[0];
    position = token.lastIndex;
    if (raw.startsWith("<![CDATA[")) {
      if (!stack.length || stack.at(-1)?.name === "Content") throw Error("CDATA is supported only as opaque non-Content metadata.");
      flush(); continue;
    }
    if (raw.startsWith("<?") || raw.startsWith("<!--")) { flush(); continue; }
    const name = /^<\/?([\w.:-]+)/u.exec(raw)[1];
    const closing = raw.startsWith("</"), selfClosing = raw.endsWith("/>");
    if (closing) {
      const popped = stack.pop();
      if (popped?.blocked) blockedDepth--;
      if (popped?.name === "Properties") propertiesDepth--;
      if (popped?.name !== name || !/^<\/[\w.:-]+\s*>$/u.test(raw)) throw Error("Unbalanced ICML elements.");
      if (!["Content","CharacterStyleRange","Properties"].includes(name) && !propertiesDepth) flush();
      continue;
    }
    if (stack.at(-1)?.name === "Content") throw Error("Unexpected element inside Content; spacing must not flatten inline markup.");
    const attrs = {};
    const attributeText = raw.slice(1 + name.length, selfClosing ? -2 : -1);
    let consumed = 0;
    const attribute = /\s+([\w.:-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
    // Equivalent to attributeText.slice(consumed).trim() without copying the rest.
    const remaining = () => { NONSPACE.lastIndex = consumed; return NONSPACE.test(attributeText); };
    while (consumed < attributeText.length && remaining()) {
      attribute.lastIndex = consumed;
      const a = attribute.exec(attributeText);
      if (!a || Object.hasOwn(attrs,a[1])) throw Error("Malformed/duplicate XML attribute.");
      attrs[a[1]] = decodeAttribute(a[2] ?? a[3]); consumed = attribute.lastIndex;
    }
    if (!stack.length) { roots++; if (roots !== 1) throw Error("Multiple ICML roots."); }
    const inProperties = propertiesDepth > 0;
    const style = (attrs.AppliedParagraphStyle || "").split("/").at(-1);
    const blocked = ["CrossReferenceSource", "TextVariableInstance"].includes(name) ||
      (name === "ParagraphStyleRange" && styles.has(style)) ||
      (name === "Content" && protectedIds.has(idKey(attrs.id)));
    if ((!inProperties && !["Content", "CharacterStyleRange", "Properties"].includes(name)) || blocked) flush();
    if (name === "Content") {
      contentCount++;
      if (attrs.id) { const key = idKey(attrs.id); if (contentIds.has(key)) throw Error("Duplicate Content ID."); contentIds.add(key); }
      if (!stack.some(e=>e.name === "ParagraphStyleRange")) throw Error("Content outside ParagraphStyleRange.");
      if (blocked || blockedDepth) protectedContents++;
    }
    if (!selfClosing) {
      stack.push({ name, blocked });
      if (blocked) blockedDepth++;
      if (name === "Properties") propertiesDepth++;
    }
    if (stack.length > 256) throw Error("ICML nesting limit exceeded.");
  }
  flush();
  if (stack.length || roots !== 1 || !contentCount) throw Error("Incomplete ICML document.");
  return { scopes, contentCount, protectedContents, contentIdCount: contentIds.size };
}
function applyIcmlGrep(xml, language, options = {}) {
  const stringKey = stringListKey(options.protectedStrings);
  const cached = stringKey !== null && protectedStringCache?.key === stringKey ? protectedStringCache : null;
  options = { ...options, protectedStrings: cached ? cached.expanded : (options.protectedStrings || []).flatMap(value => {
    // Workbook locks may contain literal ICML entities; protect their rendered
    // spelling as well without re-encoding any manuscript entities.
    try { return [value,units(value).map(u=>u.char).join("")]; } catch { return [value]; }
  }) };
  const parsed = parseScopes(xml, options), policy = resolveGrepRules(language);
  const patterns = cached ? cached.patterns : protectionPatterns(options.protectedStrings);
  if (stringKey !== null && !cached) protectedStringCache = { key: stringKey, expanded: options.protectedStrings, patterns };
  const compiled = prepareRules(policy);
  const records = policy.applicable.map(rule=>({ ruleId: rule.id, scopes: parsed.scopes.length, matches: 0, changes: 0, excluded: 0 }));
  const edits = [];
  for (const scope of parsed.scopes) {
    const original = scope.map(u=>u.char).join("");
    const revised = runRules(original, compiled, patterns);
    revised.records.forEach((record,i)=>{ for (const key of ["matches","changes","excluded"]) records[i][key] += record[key]; });
    // An unchanged scope maps to no edits and cannot fail the spacing check.
    if (revised.text !== original) edits.push(...spacingEdits(scope,revised.text));
  }
  edits.sort((a,b)=>b.start-a.start);
  let text = xml;
  const ascending = edits.toReversed();
  if (ascending.every((edit,i) => i === 0 || (ascending[i-1].start < edit.start && ascending[i-1].end <= edit.start))) text = spliceAscending(xml, ascending);
  else for (const edit of edits) text = text.slice(0,edit.start) + edit.text + text.slice(edit.end);
  // Parsing again validates replacements without reserializing the original.
  if (text !== xml) parseScopes(text, options);
  return { text, changed: text !== xml, method: "offline_icml_grep", policySha256: policy.sha256,
    records, notApplicable: policy.notApplicable, contentCount: parsed.contentCount,
    contentIdCount: parsed.contentIdCount, protectedContents: parsed.protectedContents };
}
module.exports = { applyIcmlGrep, transformText };

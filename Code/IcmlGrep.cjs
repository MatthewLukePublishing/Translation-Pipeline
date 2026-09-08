"use strict";
// Text-only execution of the maintained GREP matrix. Never serialize the XML:
// preserve every original byte except the exact spacing characters being edited.
const { resolveGrepRules, previewExpression, replacementForMatch } = require("./TranslationGrepRules.cjs");
const SPACE = /^[ \u00a0\u2009\u202f]$/u;
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/y;
function decodeEntity(raw) {
  const names = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
  if (names[raw]) return names[raw];
  const hex = raw.startsWith("&#x");
  const n = Number.parseInt(raw.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
  if (!Number.isInteger(n) || n > 0x10ffff || (n < 32 && ![9,10,13].includes(n)) ||
      (n >= 0xd800 && n <= 0xdfff) || [0xfffe,0xffff].includes(n)) throw Error("Invalid XML character reference.");
  return String.fromCodePoint(n);
}
function units(raw, offset = 0) {
  const out = [];
  for (let i = 0; i < raw.length;) {
    let source = String.fromCodePoint(raw.codePointAt(i)), char = source;
    if (char === "&") {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(raw);
      if (!m) throw Error("Unsupported or malformed XML entity.");
      source = m[0]; char = decodeEntity(source);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(char)) throw Error("Invalid XML text character.");
    out.push({ char, raw: source, start: offset + i, end: offset + i + source.length });
    i += source.length;
  }
  return out;
}
function protectionPatterns(strings) {
  const patterns = [/(?:https?:\/\/|www\.)[^\s<>]+|[\w.+-]+@[\w.-]+\.[A-Za-z]+|⟦[^⟧]+⟧|__lock_[A-Za-z0-9_]+__/gu];
  for (const value of new Set(strings || [])) {
    if (!value) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    patterns.push(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "gu"));
  }
  return patterns;
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
function transformText(text, language, options = {}, preparedPatterns) {
  const policy = resolveGrepRules(language), records = [];
  const patterns = preparedPatterns || protectionPatterns(options.protectedStrings);
  let result = text;
  for (const rule of policy.applicable) {
    const ranges = [];
    for (const pattern of patterns) for (const m of result.matchAll(pattern)) ranges.push([m.index, m.index + m[0].length]);
    const matches = [...result.matchAll(previewExpression(rule))];
    const edits = [];
    let excluded = 0;
    for (const match of matches) {
      const end = match.index + match[0].length;
      if (/[\t\r\n\u2028\u2029]/u.test(match[0]) || ranges.some(([a,b]) => a < end && b > match.index)) { excluded++; continue; }
      const replacement = replacementForMatch(rule, match[0]);
      // Reject any expansion of the allowed transformation beyond horizontal spaces.
      if (match[0].replace(/[ \u00a0\u2009\u202f]/gu, "") !== replacement.replace(/[ \u00a0\u2009\u202f]/gu, "")) throw Error(`Unsafe GREP replacement: ${rule.id}`);
      if (replacement !== match[0]) edits.push({ start: match.index, end, text: replacement });
    }
    for (const edit of edits.reverse()) result = result.slice(0,edit.start) + edit.text + result.slice(edit.end);
    records.push({ ruleId: rule.id, matches: matches.length, changes: edits.length, excluded });
  }
  return { text: result, records, policySha256: policy.sha256, notApplicable: policy.notApplicable };
}
function parseScopes(xml, options = {}) {
  if (Buffer.byteLength(xml, "utf8") > 8 * 1024 * 1024) throw Error("ICML exceeds the 8 MiB per-file bound.");
  const stack = [], scopes = [], contentIds = new Set();
  let scope = [], position = 0, roots = 0, contentCount = 0, protectedContents = 0;
  const flush = () => { if (scope.length) scopes.push(scope); scope = []; };
  // ICML often pads numeric IDs; QA uses the workbook's normalized identity.
  const idKey = value => { const s = String(value || "").trim(); return /^\d+$/u.test(s) ? s.replace(/^0+(?=\d)/u,"") : s; };
  const protectedIds = new Set((options.protectedContentIds || []).map(idKey));
  const styles = new Set(["Credits", ...(options.protectedStyles || [])]);
  const token = /<!\[CDATA\[[\s\S]*?\]\]>|<!--(?:[^-]|-(?!->))*-->|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w.:-]*(?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?\>/y;
  const isBlocked = () => stack.some(e => e.blocked);
  while (position < xml.length) {
    if (xml[position] !== "<") {
      const next = xml.indexOf("<", position), end = next < 0 ? xml.length : next;
      const raw = xml.slice(position,end);
      if (stack.at(-1)?.name === "Content") {
        const decoded = units(raw,position);
        if (!isBlocked()) {
          for (const u of decoded) {
            if (/[\t\r\n\u2028\u2029]/u.test(u.char)) flush(); else scope.push(u);
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
      if (stack.pop()?.name !== name || !/^<\/[\w.:-]+\s*>$/u.test(raw)) throw Error("Unbalanced ICML elements.");
      if (!["Content","CharacterStyleRange","Properties"].includes(name) && !stack.some(e=>e.name === "Properties")) flush();
      continue;
    }
    if (stack.at(-1)?.name === "Content") throw Error("Unexpected element inside Content; spacing must not flatten inline markup.");
    const attrs = {};
    const attributeText = raw.slice(1 + name.length, selfClosing ? -2 : -1);
    let consumed = 0;
    const attribute = /\s+([\w.:-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
    while (consumed < attributeText.length && attributeText.slice(consumed).trim()) {
      attribute.lastIndex = consumed;
      const a = attribute.exec(attributeText);
      if (!a || Object.hasOwn(attrs,a[1])) throw Error("Malformed/duplicate XML attribute.");
      attrs[a[1]] = units(a[2] ?? a[3]).map(u=>u.char).join(""); consumed = attribute.lastIndex;
    }
    if (!stack.length) { roots++; if (roots !== 1) throw Error("Multiple ICML roots."); }
    const inProperties = stack.some(e=>e.name === "Properties");
    const style = (attrs.AppliedParagraphStyle || "").split("/").at(-1);
    const blocked = ["CrossReferenceSource", "TextVariableInstance"].includes(name) ||
      (name === "ParagraphStyleRange" && styles.has(style)) ||
      (name === "Content" && protectedIds.has(idKey(attrs.id)));
    if ((!inProperties && !["Content", "CharacterStyleRange", "Properties"].includes(name)) || blocked) flush();
    if (name === "Content") {
      contentCount++;
      if (attrs.id) { const key = idKey(attrs.id); if (contentIds.has(key)) throw Error("Duplicate Content ID."); contentIds.add(key); }
      if (!stack.some(e=>e.name === "ParagraphStyleRange")) throw Error("Content outside ParagraphStyleRange.");
      if (blocked || isBlocked()) protectedContents++;
    }
    if (!selfClosing) stack.push({ name, blocked });
    if (stack.length > 256) throw Error("ICML nesting limit exceeded.");
  }
  flush();
  if (stack.length || roots !== 1 || !contentCount) throw Error("Incomplete ICML document.");
  return { scopes, contentCount, protectedContents, contentIdCount: contentIds.size };
}
function applyIcmlGrep(xml, language, options = {}) {
  options = { ...options, protectedStrings: (options.protectedStrings || []).flatMap(value => {
    // Workbook locks may contain literal ICML entities; protect their rendered
    // spelling as well without re-encoding any manuscript entities.
    try { return [value,units(value).map(u=>u.char).join("")]; } catch { return [value]; }
  }) };
  const parsed = parseScopes(xml, options), policy = resolveGrepRules(language);
  const patterns = protectionPatterns(options.protectedStrings);
  const records = policy.applicable.map(rule=>({ ruleId: rule.id, scopes: parsed.scopes.length, matches: 0, changes: 0, excluded: 0 }));
  const edits = [];
  for (const scope of parsed.scopes) {
    const original = scope.map(u=>u.char).join("");
    const revised = transformText(original, language, options, patterns);
    revised.records.forEach((record,i)=>{ for (const key of ["matches","changes","excluded"]) records[i][key] += record[key]; });
    edits.push(...spacingEdits(scope,revised.text));
  }
  let text = xml;
  for (const edit of edits.sort((a,b)=>b.start-a.start)) text = text.slice(0,edit.start) + edit.text + text.slice(edit.end);
  // Parsing again validates replacements without reserializing the original.
  if (text !== xml) parseScopes(text, options);
  return { text, changed: text !== xml, method: "offline_icml_grep", policySha256: policy.sha256,
    records, notApplicable: policy.notApplicable, contentCount: parsed.contentCount,
    contentIdCount: parsed.contentIdCount, protectedContents: parsed.protectedContents };
}
module.exports = { applyIcmlGrep, transformText };

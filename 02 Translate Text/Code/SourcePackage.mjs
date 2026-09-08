import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { isStrictlyInside } from "./PathSafety.mjs";

function setId(tag, id) {
  return /\sid\s*=\s*"[^"]*"/.test(tag)
    ? tag.replace(/\sid\s*=\s*"[^"]*"/, ` id="${id}"`)
    : tag.replace(/^<([A-Za-z]+)/, `<$1 id="${id}"`);
}

// Outer-paragraph/segment contract used by the Scripts-panel exporter. Nested
// table paragraphs stay in their outer group; empty segments remain explicit.
export function indexIcml(text, counters = { paragraph: 0, content: 0 }) {
  const rows = [];
  let depth = 0, group = null, last = 0, output = "";
  const tokens = /<ParagraphStyleRange\b[^>]*>|<\/ParagraphStyleRange>|<Content\b[^>]*\/?>/g;
  let match;
  while ((match = tokens.exec(text))) {
    const token = match[0];
    output += text.slice(last, match.index);
    if (token.startsWith("</Paragraph")) {
      if (--depth < 0) throw new Error("Unmatched paragraph close tag.");
      if (depth === 0) {
        if (group.rows.length) {
          group.rows[0][1] = group.rows.map(row => row[3]).join("");
          rows.push(...group.rows);
        }
        group = null;
      }
      output += token;
    } else if (token.startsWith("<Paragraph")) {
      if (token.endsWith("/>")) output += token;
      else {
        if (depth++ === 0) {
          const id = String(counters.paragraph++).padStart(5, "0");
          group = { id, rows: [] };
          output += setId(token, id);
        } else output += token;
      }
    } else {
      if (!group) throw new Error("Content outside a paragraph group.");
      const id = String(counters.content++).padStart(5, "0");
      const start = tokens.lastIndex;
      const end = token.endsWith("/>") ? start : text.indexOf("</Content>", start);
      if (end < 0) throw new Error("Unmatched Content tag.");
      const value = text.slice(start, end).replace(/\r\n/g, "\n");
      group.rows.push([group.rows.length ? "" : group.id, "", id, value]);
      output += setId(token, id) + value;
      tokens.lastIndex = end;
    }
    last = tokens.lastIndex;
  }
  if (depth) throw new Error("Unmatched paragraph start tag.");
  return { text: output + text.slice(last), rows, counters };
}

export function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

export function verifySourcePackage(root) {
  const record = JSON.parse(fs.readFileSync(path.join(root, "source_package.json"), "utf8").replace(/^\uFEFF/, ""));
  if (record.schemaVersion !== 1 || record.status !== "complete" || !Array.isArray(record.files) || !record.files.length || record.files.length > 5010) {
    throw new Error("Source package is incomplete or has an invalid inventory.");
  }
  const seen = new Set();
  for (const item of record.files) {
    const file = path.resolve(root, item.path);
    const key = file.toLowerCase();
    if (!isStrictlyInside(file, root) || seen.has(key) || !/^[A-F0-9]{64}$/.test(item.sha256 || "")) throw new Error("Invalid source package path or hash.");
    seen.add(key);
    if (sha256(file) !== item.sha256) throw new Error(`Source package file changed: ${item.path}`);
  }
  for (const name of [record.document, "content_export.xlsx", "Text.zip"]) {
    if (typeof name !== "string" || !seen.has(path.resolve(root, name).toLowerCase())) throw new Error("Required source package member is missing.");
  }
  if (!record.originalDocument || sha256(record.originalDocument) !== record.originalDocumentSha256) {
    throw new Error("The current source document changed since this package was exported. Export a fresh package.");
  }
  return record;
}

export function isProductionJobLocation(job, workspace, centralJobs) {
  return isStrictlyInside(job, workspace) || isStrictlyInside(job, centralJobs);
}

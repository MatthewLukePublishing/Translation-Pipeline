"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const { commitFileSetWithJournalSync } = require("../../Code/TransactionalFileReplacement.cjs");
const hash = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function prepareDiagramPublication(filePath) {
  const source = path.resolve(filePath);
  for (let current = source; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Error("Redirected diagram path is forbidden.");
    if (current === path.dirname(current)) break;
  }
  if (!fs.statSync(source).isFile()) throw Error("Diagram source is not a regular file.");
  const journalPath = `${source}.codex-diagram-transaction.json`;
  if (fs.existsSync(journalPath)) throw Error(`Pending diagram publication requires reconciliation before retry: ${journalPath}`);
  return { source, journalPath, sourceSha256: hash(fs.readFileSync(source)),
    outputPath: `${source}.codex-diagram-${crypto.randomUUID()}.ai` };
}

function publishDiagram(publication) {
  const bytes = fs.readFileSync(publication.outputPath);
  if (!bytes.length || !fs.lstatSync(publication.outputPath).isFile()) throw Error("Illustrator did not produce a regular, nonempty staged diagram.");
  const transaction = commitFileSetWithJournalSync(publication.journalPath, [{ filePath: publication.source,
    data: bytes, expectedSha256: publication.sourceSha256 }]);
  fs.unlinkSync(publication.outputPath);
  return { ...transaction, outputSha256: hash(bytes) };
}
module.exports = { prepareDiagramPublication, publishDiagram };

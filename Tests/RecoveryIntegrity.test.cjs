"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const test = require("node:test");
const { commitFileSetWithJournalSync: commit, recoverFileSetJournalSync: recover } = require("../Code/TransactionalFileReplacement.cjs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");

function fixture(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "translate-recovery-"));
  const journal = path.join(root, "transaction.json");
  const item = index => ({ filePath: path.join(root, `file-${index}.txt`),
    backup: path.join(root, `file-${index}.txt.codex-set-backup-fixture`),
    replacement: path.join(root, `file-${index}.txt.codex-set-new-fixture`),
    hadOriginal: true, originalSha256: hash("old"), newSha256: hash("new") });
  try { run({ root, journal, item }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("recovery preflights all files and retains post-crash edits, backups and journal", () => fixture(({ journal, item }) => {
  const items = [item(1), item(2)];
  for (const entry of items) { fs.writeFileSync(entry.backup, "old"); fs.writeFileSync(entry.filePath, "new"); }
  fs.writeFileSync(items[1].filePath, "user edit");
  fs.writeFileSync(journal, JSON.stringify({ schemaVersion: 2, transactionId: "fixture", phase: "applying", items }));
  assert.throws(() => recover(journal), /content changed/);
  assert.equal(fs.readFileSync(items[0].filePath, "utf8"), "new", "no partial rollback before detecting conflict");
  assert.equal(fs.readFileSync(items[1].filePath, "utf8"), "user edit");
  assert.ok(items.every(entry => fs.existsSync(entry.backup)) && fs.existsSync(journal));
}));

test("recovery refuses missing originals, foreign newly created files and changed committed targets", () => {
  for (const variant of ["missing-backup", "foreign-new", "committed", "legacy", "live-owner"]) fixture(({ journal, item }) => {
    const entry = item(1);
    if (variant === "foreign-new") { entry.hadOriginal = false; entry.originalSha256 = null; }
    else if (variant !== "missing-backup") fs.writeFileSync(entry.backup, "old");
    fs.writeFileSync(entry.filePath, variant === "missing-backup" ? "new" : "user edit");
    fs.writeFileSync(journal, JSON.stringify({ schemaVersion: variant === "legacy" ? 1 : 2,
      transactionId: "fixture", ownerPid: variant === "live-owner" ? process.pid : undefined,
      phase: variant === "committed" ? "committed" : "applying", items: [entry] }));
    assert.throws(() => recover(journal), /manual reconciliation|still be running/);
    assert.ok(fs.existsSync(journal) && fs.existsSync(entry.filePath));
  });
});

test("file-set publication rejects a stale source before creating a journal", () => fixture(({ journal, item }) => {
  const entry = item(1);
  fs.writeFileSync(entry.filePath, "user edit");
  assert.throws(() => commit(journal, [{ filePath: entry.filePath, data: "new", expectedSha256: hash("old") }]), /input changed/);
  assert.equal(fs.readFileSync(entry.filePath, "utf8"), "user edit");
  assert.equal(fs.existsSync(journal), false);
}));

test("a failed second replacement rolls back the first and keeps both originals", () => fixture(({ journal, item }) => {
  const first = item(1); const second = item(2);
  for (const entry of [first, second]) fs.writeFileSync(entry.filePath, "old");
  const rename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (String(from).startsWith(second.filePath + ".codex-set-new-")) throw new Error("simulated interrupted publication");
    return rename.call(fs, from, to);
  };
  try { assert.throws(() => commit(journal, [first, second].map(entry => ({ filePath: entry.filePath, data: "new" }))), /simulated/); }
  finally { fs.renameSync = rename; }
  for (const entry of [first, second]) assert.equal(fs.readFileSync(entry.filePath, "utf8"), "old");
  assert.equal(fs.existsSync(journal), false);
}));

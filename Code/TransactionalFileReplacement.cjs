"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function siblingTransactionPath(filePath, role) {
  return `${filePath}.codex-${role}-${process.pid}-${crypto.randomUUID()}`;
}

function nonBlankPath(value, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${label} must be a non-blank path.`);
  return path.resolve(text);
}

function normalizedPathKey(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function assertRegularFileIfPresent(filePath, label) {
  for (let current = path.resolve(filePath); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`${label} must not use a symbolic link or junction: ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
  if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isFile()) {
    throw new Error(`${label} must identify a file, not a directory: ${filePath}`);
  }
}

function assertTransactionArtifactPath(filePath, artifactPath, role, journalPath) {
  const targetKey = normalizedPathKey(filePath);
  const artifactKey = normalizedPathKey(artifactPath);
  const prefix = `${targetKey}.codex-${role}-`;
  if (!artifactKey.startsWith(prefix) || !/^[a-z0-9-]+$/i.test(artifactKey.slice(prefix.length))) {
    throw new Error(`Invalid ${role} path for ${filePath} in transaction journal: ${journalPath}`);
  }
}

function attachRecoveryFailure(error, recoveryError) {
  if (recoveryError) error.recoveryError = recoveryError;
  return error;
}

function restoreBackupSync(filePath, backup) {
  if (!fs.existsSync(filePath)) {
    fs.renameSync(backup, filePath);
    return;
  }
  const displaced = siblingTransactionPath(filePath, "rollback-current");
  fs.renameSync(filePath, displaced);
  try {
    fs.renameSync(backup, filePath);
  } catch (error) {
    let recoveryError;
    try {
      fs.renameSync(displaced, filePath);
    } catch (caught) {
      recoveryError = caught;
    }
    throw attachRecoveryFailure(error, recoveryError);
  }
  fs.rmSync(displaced, { force: true });
}

function commitFileReplacementSync(filePath, data, options) {
  const resolvedFilePath = nonBlankPath(filePath, "Replacement target");
  assertRegularFileIfPresent(resolvedFilePath, "Replacement target");
  if (!fs.existsSync(resolvedFilePath)) throw new Error(`Replacement target does not exist: ${resolvedFilePath}`);
  const backup = siblingTransactionPath(resolvedFilePath, "backup");
  const replacement = siblingTransactionPath(resolvedFilePath, "new");
  let originalMoved = false;
  try {
    const writeOptions = typeof options === "string"
      ? { encoding: options, flag: "wx" }
      : { ...(options || {}), flag: "wx" };
    fs.writeFileSync(replacement, data, writeOptions);
    fs.renameSync(resolvedFilePath, backup);
    originalMoved = true;
    fs.renameSync(replacement, resolvedFilePath);
    return { backup, filePath: resolvedFilePath };
  } catch (error) {
    let recoveryError;
    if (originalMoved) {
      try {
        restoreBackupSync(resolvedFilePath, backup);
      } catch (caught) {
        recoveryError = caught;
      }
    }
    try {
      fs.rmSync(replacement, { force: true });
    } catch (cleanupError) {
      recoveryError ??= cleanupError;
    }
    throw attachRecoveryFailure(error, recoveryError);
  }
}

function rollbackFileReplacementSync(transaction) {
  restoreBackupSync(transaction.filePath, transaction.backup);
}

function discardReplacementBackupSync(transaction) {
  fs.rmSync(transaction.backup, { force: true });
}

function writeJournalSync(journalPath, value, initial = false) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const temporary = initial ? journalPath : `${journalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!initial) fs.renameSync(temporary, journalPath);
}

function fileHash(filePath) {
  assertRegularFileIfPresent(filePath, "Transaction file");
  return fs.existsSync(filePath) ? crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex") : null;
}

function validateJournal(journal, journalPath) {
  if (!journal || ![1, 2].includes(journal.schemaVersion) || !Array.isArray(journal.items) || !journal.items.length) {
    throw new Error(`Invalid replacement transaction journal: ${journalPath}`);
  }
  if (typeof journal.transactionId !== "string" || !journal.transactionId.trim()) {
    throw new Error(`Invalid transactionId in transaction journal: ${journalPath}`);
  }
  if (!new Set(["preparing", "prepared", "applying", "committed"]).has(journal.phase)) {
    throw new Error(`Invalid phase in transaction journal: ${journalPath}`);
  }
  const targetPaths = new Set();
  for (const item of journal.items) {
    if (!item || typeof item !== "object" || typeof item.hadOriginal !== "boolean") {
      throw new Error(`Invalid item in transaction journal: ${journalPath}`);
    }
    for (const key of ["filePath", "backup", "replacement"]) {
      if (typeof item[key] !== "string" || !item[key].trim() || !path.isAbsolute(item[key])) {
        throw new Error(`Invalid ${key} in transaction journal: ${journalPath}`);
      }
    }
    const normalized = normalizedPathKey(item.filePath);
    if (targetPaths.has(normalized)) throw new Error(`Duplicate target in transaction journal: ${item.filePath}`);
    if (normalized === normalizedPathKey(journalPath)) {
      throw new Error(`Transaction journal cannot also be a replacement target: ${journalPath}`);
    }
    targetPaths.add(normalized);
    assertRegularFileIfPresent(item.filePath, "Transaction target");
  }

  const artifactPaths = new Set();
  for (const item of journal.items) {
    assertTransactionArtifactPath(item.filePath, item.backup, "set-backup", journalPath);
    assertTransactionArtifactPath(item.filePath, item.replacement, "set-new", journalPath);
    for (const artifactPath of [item.backup, item.replacement]) {
      const normalized = normalizedPathKey(artifactPath);
      if (targetPaths.has(normalized) || artifactPaths.has(normalized)) {
        throw new Error(`Duplicate or overlapping artifact in transaction journal: ${artifactPath}`);
      }
      artifactPaths.add(normalized);
      assertRegularFileIfPresent(artifactPath, "Transaction artifact");
    }
  }
  if (journal.schemaVersion !== 2) {
    throw new Error(`Legacy transaction has no content hashes; manual reconciliation is required. All files retained: ${journalPath}`);
  }
  for (const item of journal.items) {
    if (!/^[a-f0-9]{64}$/.test(item.newSha256) ||
        (item.hadOriginal ? !/^[a-f0-9]{64}$/.test(item.originalSha256) : item.originalSha256 !== null)) {
      throw new Error(`Invalid content hashes in transaction journal: ${journalPath}`);
    }
  }
}

function recoverFileSetJournalSync(journalPath, activeTransactionId) {
  if (!fs.existsSync(journalPath)) return { recovered: false, phase: "none" };
  assertRegularFileIfPresent(journalPath, "Transaction journal");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8").replace(/^\uFEFF/, ""));
  validateJournal(journal, journalPath);
  if (journal.ownerPid && activeTransactionId !== journal.transactionId) {
    let running = true;
    try { process.kill(journal.ownerPid, 0); } catch (error) { if (error.code === "ESRCH") running = false; }
    if (running) throw new Error(`Transaction owner may still be running; refusing concurrent recovery: ${journalPath}`);
  }

  // Validate the entire set before deleting or restoring anything. A journal is
  // not authority to overwrite a user's edits made after an interruption.
  for (const item of journal.items) {
    const current = fileHash(item.filePath);
    const backup = fileHash(item.backup);
    const staged = fileHash(item.replacement);
    const safe = (backup === null || (item.hadOriginal && backup === item.originalSha256)) &&
      (staged === null || staged === item.newSha256) &&
      (journal.phase === "committed" ? current === item.newSha256 :
        item.hadOriginal ? (backup !== null ? [null, item.originalSha256, item.newSha256].includes(current) : current === item.originalSha256) :
          [null, item.newSha256].includes(current));
    if (!safe) throw new Error(`Transaction content changed or required backup is missing; manual reconciliation required. All files retained: ${item.filePath}`);
  }

  if (journal.phase === "committed") {
    for (const item of journal.items) {
      fs.rmSync(item.backup, { force: true });
      fs.rmSync(item.replacement, { force: true });
    }
    fs.rmSync(journalPath, { force: true });
    return { recovered: true, phase: "committed-cleanup" };
  }

  const errors = [];
  for (let index = journal.items.length - 1; index >= 0; index -= 1) {
    const item = journal.items[index];
    try {
      if (fs.existsSync(item.backup)) {
        restoreBackupSync(item.filePath, item.backup);
      } else if (!item.hadOriginal) {
        fs.rmSync(item.filePath, { force: true });
      }
      fs.rmSync(item.replacement, { force: true });
    } catch (error) {
      errors.push(`${item.filePath}: ${error.message}`);
    }
  }
  if (errors.length) throw new Error(`Transaction recovery failed: ${errors.join("; ")}`);
  fs.rmSync(journalPath, { force: true });
  return { recovered: true, phase: "rolled-back" };
}

function commitFileSetWithJournalSync(journalPath, replacements) {
  if (!Array.isArray(replacements) || !replacements.length) throw new Error("A file-set transaction requires at least one replacement.");
  const resolvedJournalPath = nonBlankPath(journalPath, "Transaction journal");
  assertRegularFileIfPresent(resolvedJournalPath, "Transaction journal");
  if (fs.existsSync(resolvedJournalPath)) throw new Error(`Recover the existing transaction journal before committing: ${resolvedJournalPath}`);
  const seen = new Set();
  const items = replacements.map((replacement) => {
    const filePath = nonBlankPath(replacement && replacement.filePath, "File-set transaction target");
    const key = normalizedPathKey(filePath);
    if (key === normalizedPathKey(resolvedJournalPath)) {
      throw new Error(`Transaction journal cannot also be a replacement target: ${resolvedJournalPath}`);
    }
    if (seen.has(key)) throw new Error(`Duplicate file-set transaction target: ${filePath}`);
    assertRegularFileIfPresent(filePath, "File-set transaction target");
    seen.add(key);
    return {
      filePath,
      backup: siblingTransactionPath(filePath, "set-backup"),
      replacement: siblingTransactionPath(filePath, "set-new"),
      hadOriginal: fs.existsSync(filePath),
      originalSha256: fileHash(filePath),
      data: Buffer.isBuffer(replacement.data) ? replacement.data : Buffer.from(replacement.data,
        typeof replacement.options === "string" ? replacement.options : replacement.options?.encoding || "utf8"),
      expectedSha256: replacement.expectedSha256,
    };
  });
  for (const item of items) {
    item.newSha256 = crypto.createHash("sha256").update(item.data).digest("hex");
    if (item.expectedSha256 !== undefined && item.originalSha256 !== item.expectedSha256) {
      throw new Error(`Transaction input changed before publication: ${item.filePath}`);
    }
  }
  const journal = {
    schemaVersion: 2,
    transactionId: crypto.randomUUID(),
    ownerPid: process.pid,
    phase: "preparing",
    createdAt: new Date().toISOString(),
    items: items.map(({ data, expectedSha256, ...item }) => item),
  };

  // Exclusive creation happens outside the recovery catch: never recover a
  // different writer's journal when claiming this transaction fails.
  writeJournalSync(resolvedJournalPath, journal, true);
  try {
    for (const item of items) {
      fs.mkdirSync(path.dirname(item.filePath), { recursive: true });
      const descriptor = fs.openSync(item.replacement, "wx");
      try { fs.writeFileSync(descriptor, item.data); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
    }
    journal.phase = "prepared";
    writeJournalSync(resolvedJournalPath, journal);
    journal.phase = "applying";
    writeJournalSync(resolvedJournalPath, journal);
    for (const item of items) {
      if (fileHash(item.filePath) !== item.originalSha256) throw new Error(`Transaction input changed during publication: ${item.filePath}`);
      if (item.hadOriginal) fs.renameSync(item.filePath, item.backup);
      fs.renameSync(item.replacement, item.filePath);
    }
    journal.phase = "committed";
    journal.committedAt = new Date().toISOString();
    writeJournalSync(resolvedJournalPath, journal);
  } catch (error) {
    let recoveryError;
    try { recoverFileSetJournalSync(resolvedJournalPath, journal.transactionId); }
    catch (caught) { recoveryError = caught; }
    throw attachRecoveryFailure(error, recoveryError);
  }

  const recovery = recoverFileSetJournalSync(resolvedJournalPath, journal.transactionId);
  return { transactionId: journal.transactionId, filesCommitted: items.length, recovery };
}

module.exports = {
  commitFileReplacementSync,
  discardReplacementBackupSync,
  commitFileSetWithJournalSync,
  recoverFileSetJournalSync,
  rollbackFileReplacementSync,
};

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
  if (fs.existsSync(filePath) && !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} must identify a file, not a directory: ${filePath}`);
  }
}

function assertTransactionArtifactPath(filePath, artifactPath, role, journalPath) {
  const targetKey = normalizedPathKey(filePath);
  const artifactKey = normalizedPathKey(artifactPath);
  const prefix = `${targetKey}.codex-${role}-`;
  if (artifactKey === targetKey || !artifactKey.startsWith(prefix) || artifactKey.length === prefix.length) {
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

function writeJournalSync(journalPath, value) {
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  const temporary = `${journalPath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(temporary, "wx");
  try {
    fs.writeFileSync(descriptor, payload, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, journalPath);
}

function validateJournal(journal, journalPath) {
  if (!journal || journal.schemaVersion !== 1 || !Array.isArray(journal.items) || !journal.items.length) {
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
    }
  }
}

function recoverFileSetJournalSync(journalPath) {
  if (!fs.existsSync(journalPath)) return { recovered: false, phase: "none" };
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8").replace(/^\uFEFF/, ""));
  validateJournal(journal, journalPath);

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
        fs.rmSync(item.filePath, { force: true });
        fs.renameSync(item.backup, item.filePath);
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
      data: replacement.data,
      options: replacement.options,
    };
  });
  const journal = {
    schemaVersion: 1,
    transactionId: crypto.randomUUID(),
    phase: "preparing",
    createdAt: new Date().toISOString(),
    items: items.map(({ data, options, ...item }) => item),
  };

  try {
    writeJournalSync(resolvedJournalPath, journal);
    for (const item of items) {
      fs.mkdirSync(path.dirname(item.filePath), { recursive: true });
      const options = typeof item.options === "string"
        ? { encoding: item.options, flag: "wx" }
        : { ...(item.options || {}), flag: "wx" };
      fs.writeFileSync(item.replacement, item.data, options);
    }
    journal.phase = "prepared";
    writeJournalSync(resolvedJournalPath, journal);
    journal.phase = "applying";
    writeJournalSync(resolvedJournalPath, journal);
    for (const item of items) {
      if (item.hadOriginal) fs.renameSync(item.filePath, item.backup);
      fs.renameSync(item.replacement, item.filePath);
    }
    journal.phase = "committed";
    journal.committedAt = new Date().toISOString();
    writeJournalSync(resolvedJournalPath, journal);
  } catch (error) {
    let recoveryError;
    try { recoverFileSetJournalSync(resolvedJournalPath); }
    catch (caught) { recoveryError = caught; }
    for (const item of items) fs.rmSync(item.replacement, { force: true });
    throw attachRecoveryFailure(error, recoveryError);
  }

  const recovery = recoverFileSetJournalSync(resolvedJournalPath);
  return { transactionId: journal.transactionId, filesCommitted: items.length, recovery };
}

module.exports = {
  commitFileReplacementSync,
  discardReplacementBackupSync,
  commitFileSetWithJournalSync,
  recoverFileSetJournalSync,
  rollbackFileReplacementSync,
};

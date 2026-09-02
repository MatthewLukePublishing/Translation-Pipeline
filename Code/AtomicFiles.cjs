"use strict";

const fs = require("node:fs");
const path = require("node:path");

let temporaryCounter = 0;

function nextTemporaryPath(filePath) {
  temporaryCounter += 1;
  const extension = path.extname(filePath);
  const stem = extension ? filePath.slice(0, -extension.length) : filePath;
  return `${stem}.tmp-${process.pid}-${temporaryCounter}${extension}`;
}

function attachCleanupFailure(error, temporary) {
  try {
    fs.unlinkSync(temporary);
  } catch (cleanupError) {
    if (cleanupError && cleanupError.code !== "ENOENT") error.cleanupError = cleanupError;
  }
}

function replaceFileAtomicSync(filePath, writeTemporary) {
  const temporary = nextTemporaryPath(filePath);
  try {
    writeTemporary(temporary);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    attachCleanupFailure(error, temporary);
    throw error;
  }
}

async function replaceFileAtomic(filePath, writeTemporary) {
  const temporary = nextTemporaryPath(filePath);
  try {
    await writeTemporary(temporary);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    attachCleanupFailure(error, temporary);
    throw error;
  }
}

function writeFileAtomicSync(filePath, data, options) {
  replaceFileAtomicSync(filePath, (temporary) => {
    fs.writeFileSync(temporary, data, options);
  });
}

function writeJsonAtomicSync(filePath, value, options = {}) {
  const { space = 2, trailingNewline = false } = options;
  const serialized = JSON.stringify(value, null, space);
  writeFileAtomicSync(filePath, trailingNewline ? `${serialized}\n` : serialized, "utf8");
}

module.exports = {
  replaceFileAtomic,
  replaceFileAtomicSync,
  writeFileAtomicSync,
  writeJsonAtomicSync,
};

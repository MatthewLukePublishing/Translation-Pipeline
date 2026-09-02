"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  ensureDir,
  fileExists,
  readJsonFile,
  writeJsonFile,
} = require("./FileUtilities.cjs");

function deleteStateFileIfExists(filePath, label = "state file") {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Could not delete ${label} ${filePath}: ${error.message}`);
    }
  }
}

function createJsonStateStore({ filePath, label = "state file", createDefault, beforeSave }) {
  const directoryPath = path.dirname(filePath);
  return {
    clear() {
      deleteStateFileIfExists(filePath, label);
    },
    load() {
      if (!fileExists(filePath)) return createDefault ? createDefault() : null;
      return readJsonFile(filePath, label, "parse");
    },
    save(state) {
      ensureDir(directoryPath);
      if (beforeSave) beforeSave(state);
      writeJsonFile(filePath, state);
      return state;
    },
  };
}

function createApplyStagingStateBase(outputPath, collectionKey) {
  return {
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    output_path: outputPath,
    [collectionKey]: [],
  };
}

function createBatchStateBase({ inputPath, outputPath, targetLanguage, model, domainFields }) {
  return {
    created_at: new Date().toISOString(),
    batch_id: null,
    input_file_id: null,
    output_file_id: null,
    error_file_id: null,
    status: null,
    input_path: inputPath,
    output_path: outputPath,
    target_language: targetLanguage,
    model,
    ...domainFields,
    retry_round: 0,
  };
}

function clearStateFiles({ directoryPath, filePaths }) {
  for (const filePath of filePaths) deleteStateFileIfExists(filePath);
  try {
    fs.rmdirSync(directoryPath);
  } catch (error) {
    if (!error || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error;
  }
}

module.exports = {
  clearStateFiles,
  createApplyStagingStateBase,
  createBatchStateBase,
  createJsonStateStore,
  deleteStateFileIfExists,
};

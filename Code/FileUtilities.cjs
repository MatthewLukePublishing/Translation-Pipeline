"use strict";

const fs = require("node:fs");
const { writeFileAtomicSync, writeJsonAtomicSync } = require("./AtomicFiles.cjs");

function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFilePart(value) {
  return String(value ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 120);
}

function writeJsonFile(filePath, value) {
  writeJsonAtomicSync(filePath, value);
}

function readJsonIfExists(filePath) {
  if (!fileExists(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    console.warn(`Could not parse JSON: ${filePath}`);
    console.warn(error.message);
    return null;
  }
}

function parseJsonFile(filePath, label, errorAction) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not ${errorAction} ${label} ${filePath}: ${error.message}`);
  }
}

function readJsonFileRequired(filePath, label, errorAction = "parse") {
  if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
  return parseJsonFile(filePath, label, errorAction);
}

function readJsonFile(filePath, label, errorAction = "read") {
  return parseJsonFile(filePath, label, errorAction);
}

function deleteFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    console.warn(`Could not delete file: ${filePath}`);
    console.warn(error.message);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function removeDirIfEmpty(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) fs.rmdirSync(dirPath);
  } catch (error) {
    console.warn(`Could not remove directory: ${dirPath}`);
    console.warn(error.message);
  }
}

function writeTextFile(filePath, text) {
  writeFileAtomicSync(filePath, text, "utf8");
}

function readTextFile(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

module.exports = {
  deleteFileIfExists,
  ensureDir,
  fileExists,
  readJsonIfExists,
  readJsonFileRequired,
  readJsonFile,
  readTextFile,
  removeDirIfEmpty,
  sanitizeFilePart,
  sleep,
  writeJsonFile,
  writeTextFile,
};

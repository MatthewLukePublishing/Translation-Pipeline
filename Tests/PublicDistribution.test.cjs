"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const MAX_PUBLIC_FILE_BYTES = 1024 * 1024;
const BINARY_EXTENSIONS = new Set([
  ".7z", ".ai", ".ait", ".csv", ".doc", ".docx", ".eps", ".icml", ".idml",
  ".indd", ".pdf", ".psd", ".rar", ".tsv", ".xls", ".xlsb", ".xlsm", ".xlsx", ".zip",
]);
const PRIVATE_PATHS = [
  /^_Archive\//i,
  /^PROJECT\.md$/i,
  /^Future Languages\.txt$/i,
  /^01 Translate Glossaries\/book_glossary_map\.json$/i,
  /^01 Translate Glossaries\/[^/]+\/(?:Glossary\.xlsx|Runtime\/|README\.md)/i,
  /^02 Translate Text\/(?:Active Job\.json|Origin Files\/|Language Files\/|Jobs\/|Reference\/)/i,
  /^02 Translate Text\/Book Instructions\/.*\.json$/i,
  /^03 Translate Diagrams\/(?:Reference\/|Working Files\/|Output\/)/i,
  /^04 Translate Comic Captions\/(?:Working Files\/|Output\/)/i,
  /^Tests\/(?:DataContracts\.test\.cjs|Run-Tests\.ps1)$/i,
  /(?:^|\/)(?:node_modules|logs|reports|state|debug_payloads|subscription_state|outputs|\.tmp)(?:\/|$)/i,
];

function trackedFiles() {
  const run = spawnSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
    windowsHide: true,
  });
  assert.equal(run.status, 0, `git ls-files failed with exit code ${run.status}`);
  return run.stdout.toString("utf8").split("\0").filter(Boolean);
}

function textFile(buffer) {
  return !buffer.includes(0);
}

test("the public commit contains only maintained source and synthetic examples", () => {
  const files = trackedFiles();
  assert.ok(files.length > 0, "No tracked files were found.");
  for (const relativePath of files) {
    const normalized = relativePath.replace(/\\/g, "/");
    assert.ok(
      PRIVATE_PATHS.every((pattern) => !pattern.test(normalized)),
      `Private or generated path is tracked: ${normalized}`,
    );
    assert.ok(
      !BINARY_EXTENSIONS.has(path.extname(normalized).toLowerCase()),
      `Input/output document is tracked: ${normalized}`,
    );
    const size = fs.statSync(path.join(ROOT, relativePath)).size;
    assert.ok(size <= MAX_PUBLIC_FILE_BYTES, `Public file exceeds 1 MiB: ${normalized}`);
  }
});

test("tracked text contains no credentials or personal workstation data", () => {
  const forbidden = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/i],
    ["OpenAI secret key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/i],
    ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
    ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/],
    ["Google OAuth access token", /\bya29\.[A-Za-z0-9_-]{20,}\b/],
    ["Google API key", /\bAIza[A-Za-z0-9_-]{35}\b/],
    ["literal bearer credential", /\bBearer\s+[A-Za-z0-9._~-]{24,}/i],
    ["credential in URL", /https?:\/\/[^\s/:@]+:[^\s/@]+@/i],
    ["personal user profile", /C:\\Users\\(?!Public(?:\\|$))[^\\\s]+/i],
    ["personal account name", new RegExp(`\\b${["jo", "hnl"].join("")}\\b`, "i")],
  ];
  const allowedAccessContract = "D:\\Google Drive\\Publishing\\Code\\Admin\\Access";
  for (const relativePath of trackedFiles()) {
    const buffer = fs.readFileSync(path.join(ROOT, relativePath));
    if (!textFile(buffer)) continue;
    let source = buffer.toString("utf8");
    if (relativePath.replace(/\\/g, "/") === "README.md") {
      source = source.split(allowedAccessContract).join("");
    }
    assert.ok(!/[A-Z]:\\Google Drive\\Publishing\\(?:Products|Code\\Programs)/i.test(source),
      `Private production path is present in ${relativePath}`);
    for (const [label, pattern] of forbidden) {
      // Report the location/category only; never echo a credential-bearing source string.
      assert.ok(!pattern.test(source), `${label} pattern is present in ${relativePath}`);
    }
  }
});

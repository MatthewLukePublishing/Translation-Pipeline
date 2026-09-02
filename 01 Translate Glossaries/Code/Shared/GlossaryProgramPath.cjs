"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveGlossaryProgramPath(programRoot, relativePath, label, options = {}) {
  const root = path.resolve(programRoot);
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  const isStrictlyInside = relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative);
  if (!isStrictlyInside) {
    throw new Error(`${label} is outside the translation program: ${resolved}`);
  }
  if (options.mustExist === true && !fs.existsSync(resolved)) {
    throw new Error(`Missing ${label}: ${resolved}`);
  }
  return resolved;
}

module.exports = { resolveGlossaryProgramPath };

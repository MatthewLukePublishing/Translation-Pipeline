#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import atomicFiles from "../../../Code/AtomicFiles.cjs";
import transactionalFiles from "../../../Code/TransactionalFileReplacement.cjs";
import { buildContentGroups, compositeFromRows } from "../ContentGroups.mjs";
import { EXCEL_ERROR_LITERALS, assertLiteralXlsxWorkbook } from "../WorkbookContract.mjs";

const { writeFileAtomicSync } = atomicFiles;
const {
  commitFileReplacementSync,
  discardReplacementBackupSync,
  rollbackFileReplacementSync,
} = transactionalFiles;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STAGE_TWO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const WORKFLOW_ROOT = path.resolve(STAGE_TWO_ROOT, "..");

function parseArgs(argv) {
  const result = {
    apply: false,
    root: path.join(STAGE_TWO_ROOT, "Language Files"),
    archive: path.join(WORKFLOW_ROOT, "_Archive", "2026-09-01 Language Workbook Formula Recovery"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") result.apply = true;
    else if (argument === "--root") result.root = path.resolve(argv[++index] || "");
    else if (argument === "--archive") result.archive = path.resolve(argv[++index] || "");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
}

function isExcelErrorLiteral(value) {
  return EXCEL_ERROR_LITERALS.has(String(value).trim().toUpperCase());
}

function recoverGroup(rows, group) {
  const composite = String(rows[group.startRow]?.[1] ?? "");
  const originalSegments = group.rowIndexes.map((rowIndex) => String(rows[rowIndex]?.[3] ?? ""));
  const recoveredSegments = [...originalSegments];
  const changes = [];
  let cursor = 0;
  let pendingErrorIndexes = [];

  for (let segmentIndex = 0; segmentIndex < originalSegments.length; segmentIndex += 1) {
    const segment = originalSegments[segmentIndex];
    if (isExcelErrorLiteral(segment)) {
      pendingErrorIndexes.push(segmentIndex);
      continue;
    }

    const position = composite.indexOf(segment, cursor);
    if (position < 0) {
      throw new Error(`Could not align row ${group.rowIndexes[segmentIndex] + 1} to its column-B composite.`);
    }
    const gap = composite.slice(cursor, position);
    if (pendingErrorIndexes.length) {
      if (pendingErrorIndexes.length !== 1) {
        throw new Error(`Consecutive Excel-error cells are ambiguous at group row ${group.startRow + 1}.`);
      }
      const errorIndex = pendingErrorIndexes[0];
      if (!gap.trimStart().startsWith("=")) {
        throw new Error(`Recovered error text is not an equation at row ${group.rowIndexes[errorIndex] + 1}.`);
      }
      recoveredSegments[errorIndex] = gap;
      changes.push({
        rowIndex: group.rowIndexes[errorIndex],
        before: originalSegments[errorIndex],
        after: gap,
        reason: "excel-error-literal",
      });
      pendingErrorIndexes = [];
    } else if (gap.length) {
      if (!/^=\s*$/u.test(gap)) {
        throw new Error(`Unexpected missing prefix '${gap}' at row ${group.rowIndexes[segmentIndex] + 1}.`);
      }
      recoveredSegments[segmentIndex] = gap + segment;
      changes.push({
        rowIndex: group.rowIndexes[segmentIndex],
        before: segment,
        after: gap + segment,
        reason: "missing-equation-prefix",
      });
    }
    cursor = position + segment.length;
  }

  const tail = composite.slice(cursor);
  if (pendingErrorIndexes.length) {
    if (pendingErrorIndexes.length !== 1 || !tail.trimStart().startsWith("=")) {
      throw new Error(`Could not safely recover the trailing error at group row ${group.startRow + 1}.`);
    }
    const errorIndex = pendingErrorIndexes[0];
    recoveredSegments[errorIndex] = tail;
    changes.push({
      rowIndex: group.rowIndexes[errorIndex],
      before: originalSegments[errorIndex],
      after: tail,
      reason: "excel-error-literal",
    });
  } else if (tail.length) {
    throw new Error(`Unexpected unmatched composite suffix at group row ${group.startRow + 1}.`);
  }

  if (recoveredSegments.join("") !== composite) {
    throw new Error(`Recovered segments still disagree with column B at group row ${group.startRow + 1}.`);
  }
  return changes;
}

function loadWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, {
    cellFormula: true,
    cellText: false,
    cellDates: false,
    cellStyles: true,
  });
  if (workbook.SheetNames.length !== 1) throw new Error(`Expected one worksheet: ${filePath}`);
  const sheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: "", raw: false });
  return { workbook, worksheet, sheetName, rows };
}

function planWorkbook(filePath) {
  const loaded = loadWorkbook(filePath);
  const mismatchedGroups = buildContentGroups(loaded.rows).filter(
    (group) => String(loaded.rows[group.startRow]?.[1] ?? "") !== compositeFromRows(loaded.rows, group)
  );
  const changes = mismatchedGroups.flatMap((group) => recoverGroup(loaded.rows, group));
  if (!changes.length) return null;

  for (const change of changes) {
    const address = XLSX.utils.encode_cell({ r: change.rowIndex, c: 3 });
    const cell = loaded.worksheet[address];
    if (!cell || String(cell.v ?? "") !== change.before) {
      throw new Error(`Cell changed during repair planning: ${loaded.sheetName}!${address}`);
    }
    cell.t = "s";
    cell.v = change.after;
    delete cell.f;
    delete cell.w;
  }

  const buffer = XLSX.write(loaded.workbook, {
    type: "buffer",
    bookType: "xlsx",
    compression: true,
    bookSST: true,
    cellStyles: true,
  });
  return {
    filePath,
    beforeSha256: sha256(fs.readFileSync(filePath)),
    afterSha256: sha256(buffer),
    changes,
    buffer,
  };
}

function verifyPlan(plan) {
  const loaded = loadWorkbook(plan.filePath);
  assertLiteralXlsxWorkbook(loaded.workbook, plan.filePath, loaded.sheetName);
  const remaining = buildContentGroups(loaded.rows).filter(
    (group) => String(loaded.rows[group.startRow]?.[1] ?? "") !== compositeFromRows(loaded.rows, group)
  );
  if (remaining.length) throw new Error(`Composite mismatches remain in ${plan.filePath}: ${remaining.length}`);
  for (const change of plan.changes) {
    if (String(loaded.rows[change.rowIndex]?.[3] ?? "") !== change.after) {
      throw new Error(`Repaired value did not round-trip at row ${change.rowIndex + 1}: ${plan.filePath}`);
    }
  }
}

const cli = parseArgs(process.argv.slice(2));
if (!fs.existsSync(cli.root)) throw new Error(`Language workbook folder not found: ${cli.root}`);
const files = fs.readdirSync(cli.root)
  .filter((name) => name.toLowerCase().endsWith(".xlsx"))
  .sort((left, right) => left.localeCompare(right, "en"))
  .map((name) => path.join(cli.root, name));
const plans = files.map(planWorkbook).filter(Boolean);
const totalChanges = plans.reduce((sum, plan) => sum + plan.changes.length, 0);

for (const plan of plans) {
  for (const change of plan.changes) {
    console.log(
      `REPAIR_PLAN|file=${path.basename(plan.filePath)}|cell=D${change.rowIndex + 1}|reason=${change.reason}|before=${JSON.stringify(change.before)}|after=${JSON.stringify(change.after)}`
    );
  }
}
console.log(`REPAIR_SUMMARY|mode=${cli.apply ? "apply" : "check"}|files=${plans.length}|cells=${totalChanges}`);
if (!cli.apply || !plans.length) process.exit(0);
if (fs.existsSync(cli.archive)) throw new Error(`Archive destination already exists: ${cli.archive}`);

fs.mkdirSync(cli.archive, { recursive: true });
for (const plan of plans) fs.copyFileSync(plan.filePath, path.join(cli.archive, path.basename(plan.filePath)));
const archiveReadme = [
  "# Language Workbook Formula Recovery",
  "",
  "These are the exact pre-repair copies of Step 2 language reference workbooks whose literal equation segments had been interpreted as Excel formulas in an earlier workflow.",
  "",
  `Recovered files: ${plans.length}`,
  `Recovered cells: ${totalChanges}`,
  "",
  ...plans.map((plan) => `- ${path.basename(plan.filePath)} — SHA-256 ${plan.beforeSha256}`),
  "",
].join("\n");
writeFileAtomicSync(path.join(cli.archive, "README.md"), archiveReadme, "utf8");

const committed = [];
try {
  for (const plan of plans) {
    if (sha256(fs.readFileSync(plan.filePath)) !== plan.beforeSha256) {
      throw new Error(`Workbook changed after planning: ${plan.filePath}`);
    }
  }
  for (const plan of plans) committed.push({ plan, transaction: commitFileReplacementSync(plan.filePath, plan.buffer) });
  for (const { plan } of committed) verifyPlan(plan);
} catch (error) {
  const rollbackErrors = [];
  for (let index = committed.length - 1; index >= 0; index -= 1) {
    try { rollbackFileReplacementSync(committed[index].transaction); }
    catch (rollbackError) { rollbackErrors.push(rollbackError.message); }
  }
  throw new Error(`Language workbook repair failed; rollback attempted. ${error.message}${rollbackErrors.length ? ` | ${rollbackErrors.join("; ")}` : ""}`);
}
for (const { transaction } of committed) discardReplacementBackupSync(transaction);
console.log(`REPAIR_COMPLETE|files=${plans.length}|cells=${totalChanges}|archive=${cli.archive}`);


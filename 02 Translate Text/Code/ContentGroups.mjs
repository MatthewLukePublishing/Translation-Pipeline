const COL_A = 0;
const COL_B = 1;
const COL_D = 3;

function cellText(value) {
  return value === null || value === undefined ? "" : String(value);
}

function hasLiteralContent(value) {
  return cellText(value).length > 0;
}

/**
 * Build the ParagraphStyleRange groups encoded by the four-column content
 * export contract. Column A is the authoritative group boundary. Column B is
 * a composite value and must never be used to infer a boundary because a
 * valid group may intentionally contain whitespace only.
 */
export function buildContentGroups(rows) {
  const groups = [];
  let current = null;

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    if (hasLiteralContent(row[COL_A])) {
      if (current) groups.push(current);
      current = {
        groupId: `group_${String(groups.length + 1).padStart(6, "0")}`,
        startRow: rowIndex,
        allRowIndexes: [],
        rowIndexes: [],
        sourceComposite: cellText(row[COL_B]),
        sourceSegments: [],
      };
    }

    if (!current) continue;
    current.allRowIndexes.push(rowIndex);
    if (hasLiteralContent(row[COL_D])) {
      current.rowIndexes.push(rowIndex);
      current.sourceSegments.push(cellText(row[COL_D]));
    }
  }

  if (current) groups.push(current);
  return groups;
}

export function compositeFromRows(rows, group, columnIndex = COL_D) {
  return group.allRowIndexes
    .map((rowIndex) => cellText(rows[rowIndex]?.[columnIndex]))
    .join("");
}

export function findOrphanRows(rows) {
  const orphans = [];
  let groupStarted = false;
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    if (hasLiteralContent(row[COL_A])) groupStarted = true;
    if (!groupStarted && row.some(hasLiteralContent)) orphans.push(rowIndex);
  }
  return orphans;
}


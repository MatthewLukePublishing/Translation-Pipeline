// A blank recommendation means no replacement, not permission to erase a cell.
// Retain each source cell's boundary whitespace and the literal tab separator.
export function renderGlossaryTableRow(sourceSegment, recommendation) {
  const cells = String(sourceSegment).split("\t");
  if (cells.length !== 2) throw new Error("Expected exactly two glossary table cells.");
  const replacements = [recommendation.targetTerm, recommendation.targetDefinition];
  return cells.map((cell, index) => {
    const replacement = String(replacements[index] ?? "").trim();
    if (!replacement) return cell;
    const leading = cell.match(/^\s*/u)[0];
    const trailing = cell.match(/\s*$/u)[0];
    if (!cell.trim()) throw new Error("Cannot replace an empty source glossary cell.");
    return `${leading}${replacement}${trailing}`;
  }).join("\t");
}

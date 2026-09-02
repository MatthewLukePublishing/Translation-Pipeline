export function createIssueCollector(maxDetails) {
  if (!Number.isSafeInteger(maxDetails) || maxDetails < 1) {
    throw new Error("maxDetails must be a positive safe integer.");
  }

  const issues = [];
  let errors = 0;
  let warnings = 0;

  function addIssue(severity, code, message, location = {}) {
    if (severity === "error") errors += 1;
    else if (severity === "warning") warnings += 1;
    else throw new Error(`Unsupported issue severity: ${severity}`);

    const issue = { severity, code, message, ...location };
    if (issues.length < maxDetails) {
      issues.push(issue);
      return;
    }

    // Do not let an early flood of warnings hide the only evidence for a
    // later error. Replace the last retained warning, while keeping totals
    // independent from this bounded detail list.
    if (severity === "error") {
      for (let index = issues.length - 1; index >= 0; index -= 1) {
        if (issues[index].severity === "warning") {
          issues[index] = issue;
          return;
        }
      }
    }
  }

  return {
    addIssue,
    issues,
    get counts() {
      return {
        errors,
        warnings,
        total: errors + warnings,
        retained: issues.length,
        omitted: errors + warnings - issues.length,
      };
    },
  };
}


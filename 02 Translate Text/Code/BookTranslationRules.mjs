function normalizeStringArray(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${label} must be an array of nonblank strings.`);
  }
  return value.map((entry) => entry.trim());
}

function normalizePatternRules(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const ids = new Set();
  return value.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`${label}[${index}] must be an object.`);
    }
    const id = String(rule.id || "").trim();
    const pattern = String(rule.pattern || "");
    const flags = String(rule.flags || "gu");
    if (!id || ids.has(id)) throw new Error(`${label} contains a blank or duplicate rule id.`);
    ids.add(id);
    let compiled;
    try { compiled = new RegExp(pattern, flags); }
    catch (error) { throw new Error(`${label} rule '${id}' has an invalid regular expression: ${error.message}`); }
    if (!compiled.global) throw new Error(`${label} rule '${id}' must include the global (g) flag.`);
    return { id, pattern, flags, message: String(rule.message || "").trim() };
  });
}

export function normalizeRuleSet(value, label, promptRequired) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const promptInstructions = normalizeStringArray(value.promptInstructions, `${label}.promptInstructions`);
  if (promptRequired && !promptInstructions.length) throw new Error(`${label}.promptInstructions cannot be empty.`);
  return {
    promptInstructions,
    preferredExamples: normalizeStringArray(value.preferredExamples, `${label}.preferredExamples`),
    glossarySourceTermExclusions: normalizeStringArray(value.glossarySourceTermExclusions, `${label}.glossarySourceTermExclusions`),
    glossaryTableSourceTermExclusions: normalizeStringArray(value.glossaryTableSourceTermExclusions, `${label}.glossaryTableSourceTermExclusions`),
    preserveSourcePatterns: normalizePatternRules(value.preserveSourcePatterns, `${label}.preserveSourcePatterns`),
    forbiddenTargetPatterns: normalizePatternRules(value.forbiddenTargetPatterns, `${label}.forbiddenTargetPatterns`),
  };
}

function mergeUniqueStrings(base, exception) {
  const seen = new Set();
  return [...base, ...exception].filter((value) => {
    const key = value.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergePatternRules(base, exception) {
  const merged = new Map(base.map((rule) => [rule.id, rule]));
  for (const rule of exception) merged.set(rule.id, rule);
  return [...merged.values()];
}

export function mergeRuleSets(base, exception) {
  return {
    promptInstructions: mergeUniqueStrings(base.promptInstructions, exception.promptInstructions),
    preferredExamples: mergeUniqueStrings(base.preferredExamples, exception.preferredExamples),
    glossarySourceTermExclusions: mergeUniqueStrings(base.glossarySourceTermExclusions, exception.glossarySourceTermExclusions),
    glossaryTableSourceTermExclusions: mergeUniqueStrings(base.glossaryTableSourceTermExclusions, exception.glossaryTableSourceTermExclusions),
    preserveSourcePatterns: mergePatternRules(base.preserveSourcePatterns, exception.preserveSourcePatterns),
    forbiddenTargetPatterns: mergePatternRules(base.forbiddenTargetPatterns, exception.forbiddenTargetPatterns),
  };
}

export function resolveBookTranslationRuleSet(moduleDefinition, configured, config) {
  if (Number(moduleDefinition.schemaVersion) !== 2) {
    throw new Error("Book translation instructions must use schemaVersion 2.");
  }
  if (Number(configured.moduleSchemaVersion) !== 2 || configured.baseRulesApplied !== true) {
    throw new Error("job_config.json does not record the schema-2 book base-rule contract.");
  }
  if (String(moduleDefinition.book || "").toLocaleLowerCase("en-US") !== String(config.book || "").toLocaleLowerCase("en-US")) {
    throw new Error(`Book translation instructions are for '${moduleDefinition.book || "(blank)"}', not '${config.book || "(blank)"}'.`);
  }
  const baseRules = normalizeRuleSet(moduleDefinition.baseRules, "baseRules", true);
  const languageEntry = Object.entries(moduleDefinition.languageExceptions || {}).find(([language]) => (
    language.toLocaleLowerCase("en-US") === String(config.targetLanguage || "").toLocaleLowerCase("en-US")
  ));
  const languageException = languageEntry ? languageEntry[0] : "";
  if (String(configured.languageException || "") !== languageException) {
    throw new Error("job_config.json language exception does not match the instruction snapshot.");
  }
  const languageRules = languageEntry
    ? normalizeRuleSet(languageEntry[1], `languageExceptions.${languageEntry[0]}`, false)
    : normalizeRuleSet({}, "languageException", false);
  return {
    moduleId: String(moduleDefinition.moduleId || moduleDefinition.book || ""),
    languageException,
    rules: mergeRuleSets(baseRules, languageRules),
  };
}

export function loadBookTranslationInstructionSnapshot({
  jobPath,
  configured,
  config,
  readJson,
  sha256File,
}) {
  const snapshotPath = path.resolve(String(configured.path || ""));
  if (!isStrictlyInside(snapshotPath, jobPath)) {
    throw new Error(`Book translation instructions must be inside the translation job: ${snapshotPath}`);
  }
  const actualSha256 = sha256File(snapshotPath);
  if (actualSha256 !== String(configured.sha256 || "").toUpperCase()) {
    throw new Error("Book translation instruction snapshot hash does not match job_config.json.");
  }
  const moduleDefinition = readJson(snapshotPath, "book translation instruction snapshot");
  return {
    actualSha256,
    resolved: resolveBookTranslationRuleSet(moduleDefinition, configured, config),
    snapshotPath,
  };
}

export function configuredPattern(rule) {
  if (rule.id === "official_unit_type_abbreviation") {
    // A headquarters qualifier belongs to the same official unit name as its
    // abbreviated type. Lock the whole phrase before generic glossary matching.
    const qualifier = "(?:\\bHeadquarters(?:\\s+and\\s+(?:Headquarters|Service|Support))?\\s+)?";
    return new RegExp(`${qualifier}(?:${rule.pattern})`, rule.flags);
  }
  return new RegExp(rule.pattern, rule.flags);
}

export function countExactOccurrences(text, value) {
  if (!value) return 0;
  return String(text || "").split(value).length - 1;
}
import path from "node:path";
import { isStrictlyInside } from "./PathSafety.mjs";

import { normalizeContentId } from "./ContentIds.mjs";
import { normalizeWorkbookCell } from "./WorkbookContract.mjs";
import editorialRules from "../../Code/TranslationEditorialRules.cjs";

const COL_CONTENT_ID = 2;
const COL_SEGMENT = 3;

function applyEditorialTypography(values, protectedIds, targetLanguage, options) {
  const languageRules = editorialRules.resolveEditorialRules(targetLanguage, "text").language;
  let standardized = 0;
  for (let row = 1; row < values.length; row += 1) {
    if (protectedIds.has(normalizeContentId(values[row]?.[COL_CONTENT_ID]))) continue;
    const original = normalizeWorkbookCell(values[row]?.[COL_SEGMENT]);
    const revised = editorialRules.normalizeEditorialText(original, targetLanguage, { ...options, languageRules });
    if (revised !== original) {
      values[row][COL_SEGMENT] = revised;
      standardized += 1;
    }
  }
  return standardized;
}

export function applyLanguagePostprocessors(values, targetLanguage, options = {}) {
  const protectedIds = options.protectedContentIds instanceof Set
    ? options.protectedContentIds
    : new Set(options.protectedContentIds || []);
  const counts = { editorialSegmentsStandardized: applyEditorialTypography(values, protectedIds, targetLanguage, options) };
  return counts;
}

import { normalizeContentId } from "./ContentIds.mjs";
import { normalizeWorkbookCell } from "./WorkbookContract.mjs";

const COL_CONTENT_ID = 2;
const COL_SEGMENT = 3;

function applyFrenchDates(values, protectedIds) {
  const months = {
    Jan: "janv.", Feb: "févr.", Mar: "mars", Apr: "avr.", May: "mai", Jun: "juin",
    Jul: "juil.", Aug: "août", Sep: "sept.", Oct: "oct.", Nov: "nov.", Dec: "déc.",
  };
  const pattern = /\b(\d{1,2})([ \u00A0])(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)([ \u00A0])(\d{4})\b/g;
  let standardized = 0;
  for (let row = 1; row < values.length; row += 1) {
    if (protectedIds.has(normalizeContentId(values[row]?.[COL_CONTENT_ID]))) continue;
    const original = normalizeWorkbookCell(values[row]?.[COL_SEGMENT]);
    const revised = original.replace(pattern, (_match, day, firstSpace, month, secondSpace, year) => (
      `${day}${firstSpace}${months[month]}${secondSpace}${year}`
    ));
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
  const language = String(targetLanguage || "").trim().toLocaleLowerCase("en-US");
  const counts = { frenchDatesStandardized: 0 };
  if (language === "french") counts.frenchDatesStandardized = applyFrenchDates(values, protectedIds);
  return counts;
}

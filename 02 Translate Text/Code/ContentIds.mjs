export function normalizeContentId(value) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) return text;
  return text.replace(/^0+(?=\d)/, "");
}

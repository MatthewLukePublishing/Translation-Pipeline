"use strict";

function repairMojibake(value) {
  const text = String(value ?? "");
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    return Buffer.from(text, "latin1").toString("utf8");
  } catch {
    return text;
  }
}

function stripInvalidJsonChars(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function cleanText(value) {
  return String(value ?? "").replace(/\r\n/g, "\n");
}

function trimString(value) {
  return cleanText(value).trim();
}

function createRequestSanitizers(options = {}) {
  const shouldRepairMojibake = options.repairMojibake === true;

  function sanitizeForRequestString(value) {
    let text = String(value ?? "");
    if (shouldRepairMojibake) text = repairMojibake(text);
    return stripInvalidJsonChars(cleanText(text));
  }

  function sanitizeDeepForRequest(value) {
    if (typeof value === "string") return sanitizeForRequestString(value);
    if (Array.isArray(value)) return value.map((item) => sanitizeDeepForRequest(item));
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, child] of Object.entries(value)) output[key] = sanitizeDeepForRequest(child);
      return output;
    }
    return value;
  }

  return { sanitizeDeepForRequest, sanitizeForRequestString };
}

function assertJsonSerializable(value, label = "value") {
  try {
    JSON.stringify(value);
  } catch (error) {
    throw new Error(`Failed to serialize ${label} as JSON: ${error.message}`);
  }
}

function normalizeCellValue(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value.text != null) return String(value.text);
    if (value.result != null) return String(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part?.text ?? "").join("");
    if (value.hyperlink != null && value.text != null) return String(value.text);
    return String(value.text ?? value.result ?? "");
  }
  return String(value);
}

module.exports = {
  assertJsonSerializable,
  cleanText,
  createRequestSanitizers,
  normalizeCellValue,
  repairMojibake,
  stripInvalidJsonChars,
  trimString,
};

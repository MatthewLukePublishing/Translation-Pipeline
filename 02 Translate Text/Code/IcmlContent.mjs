const ICML_TOKEN_OR_XML_CHARACTER =
  /<\?[\s\S]*?\?>|<\/?[A-Za-z][^>]*>|&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);|[&<>]/g;

function inventory(value, pattern) {
  return String(value ?? "").match(pattern) || [];
}

function boundaryWhitespace(value) {
  const text = String(value ?? "");
  return {
    leading: text.match(/^[ \t\r\n]*/)?.[0] || "",
    trailing: text.match(/[ \t\r\n]*$/)?.[0] || "",
  };
}

export function assertIcmlReplacementStructure(source, replacement, location = "ICML replacement") {
  const invariants = [
    ["processing instructions", /<\?[\s\S]*?\?>/g],
    ["markup tags", /<\/?[A-Za-z][^>]*>/g],
    ["line breaks", /\r\n|\r|\n/g],
  ];
  for (const [label, pattern] of invariants) {
    if (JSON.stringify(inventory(source, pattern)) !== JSON.stringify(inventory(replacement, pattern))) {
      throw new Error(`${location}: ${label} changed.`);
    }
  }
  if (JSON.stringify(boundaryWhitespace(source)) !== JSON.stringify(boundaryWhitespace(replacement))) {
    throw new Error(`${location}: leading or trailing whitespace changed.`);
  }
  const value = String(replacement ?? "");
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if ((code < 0x20 && ![0x09, 0x0a, 0x0d].includes(code)) || code === 0xfffe || code === 0xffff) {
      throw new Error(`${location}: invalid XML character U+${code.toString(16).toUpperCase().padStart(4, "0")}.`);
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) throw new Error(`${location}: unpaired high surrogate.`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error(`${location}: unpaired low surrogate.`);
    }
  }
}

export function xmlEscapePreserveIcml(value) {
  return String(value ?? "").replace(ICML_TOKEN_OR_XML_CHARACTER, (match) => {
    if (match === "&") return "&amp;";
    if (match === "<") return "&lt;";
    if (match === ">") return "&gt;";
    return match;
  });
}

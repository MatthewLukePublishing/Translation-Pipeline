export function lineBreaks(value) {
  return String(value ?? "").match(/\r\n|[\r\n\u2028\u2029]/g) || [];
}

export function lockLineBreaks(value, groupId, segmentIndex) {
  const locks = [];
  const text = String(value).replace(/\r\n|[\r\n\u2028\u2029]/g, source => {
    const token = `⟦L_${groupId}_${segmentIndex + 1}_${locks.length + 1}⟧`;
    locks.push({ token, source, segmentIndex });
    return token;
  });
  return { text, locks };
}

export function restoreLockedLineBreaks(value, locks, required = true) {
  const text = String(value);
  const tokens = text.match(/⟦L_[^⟧]+⟧/g) || [];
  if (!required && !tokens.length) return text; // Previously validated pre-token responses remain resumable.
  if (JSON.stringify(tokens) !== JSON.stringify(locks.map(lock => lock.token))) {
    throw new Error("Missing, reordered, duplicated, or invented line-break token.");
  }
  let result = text;
  for (const lock of locks) result = result.replace(lock.token, () => lock.source);
  return result;
}

// Restore encoding kinds only when every separator is still present in order.
// Never guess the position of a missing break or discard an added one.
export function restoreLineBreakKinds(source, translated) {
  const sourceBreaks = lineBreaks(source);
  // Some model JSON drafts encode a soft line break as VT. It is not valid XML,
  // so normalize it only when it corresponds to an existing source separator.
  const targetPattern = /\r\n|[\r\n\u000b\u2028\u2029]/g;
  if (sourceBreaks.length !== (String(translated).match(targetPattern) || []).length) return translated;
  let index = 0;
  return String(translated).replace(targetPattern, () => sourceBreaks[index++]);
}

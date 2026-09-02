import crypto from "node:crypto";
import path from "node:path";
import { normalizeContentId } from "./ContentIds.mjs";
import { isStrictlyInside } from "./PathSafety.mjs";

export function loadProtectedSourceManifest(jobPath, configuredPath, readJson) {
  const manifestPath = path.resolve(String(configuredPath || ""));
  if (!isStrictlyInside(manifestPath, jobPath)) {
    throw new Error(`Protected source manifest must be inside the translation job: ${manifestPath}`);
  }
  const manifest = readJson(manifestPath, "protected source content manifest");
  if (Number(manifest.schemaVersion) !== 2) {
    throw new Error("Protected source manifest must use schemaVersion 2; recreate the job snapshot.");
  }
  if (String(manifest.policy || "") !== "source_language_verbatim") {
    throw new Error("Protected source manifest has an unsupported policy.");
  }
  const ids = Array.isArray(manifest.contentIds)
    ? manifest.contentIds.map(normalizeContentId).filter(Boolean)
    : [];
  const contentIds = new Set(ids);
  if (!contentIds.size || contentIds.size !== ids.length || contentIds.size !== Number(manifest.contentIdCount)) {
    throw new Error("Protected source manifest has missing or duplicate Content IDs.");
  }
  if (!Array.isArray(manifest.contentSnapshots) || manifest.contentSnapshots.length !== contentIds.size) {
    throw new Error("Protected source manifest has an invalid source-text snapshot set.");
  }
  const sourceById = new Map();
  const canonicalSnapshots = [];
  for (const snapshot of manifest.contentSnapshots) {
    const id = normalizeContentId(snapshot?.id);
    const sourceText = String(snapshot?.sourceText ?? "");
    const relativePath = String(snapshot?.relativePath ?? "");
    const appliedParagraphStyle = String(snapshot?.appliedParagraphStyle ?? "");
    if (!contentIds.has(id) || sourceById.has(id) || !relativePath || !appliedParagraphStyle) {
      throw new Error("Protected source manifest contains an invalid or duplicate source-text snapshot.");
    }
    const textHash = crypto.createHash("sha256").update(sourceText, "utf8").digest("hex").toUpperCase();
    if (textHash !== String(snapshot.sourceTextSha256 || "").toUpperCase()) {
      throw new Error(`Protected source text hash mismatch for Content ID ${id}.`);
    }
    sourceById.set(id, sourceText);
    canonicalSnapshots.push({ id, sourceText, relativePath, appliedParagraphStyle });
  }
  const sourceSetSha256 = crypto.createHash("sha256")
    .update(JSON.stringify(canonicalSnapshots), "utf8")
    .digest("hex")
    .toUpperCase();
  if (sourceSetSha256 !== String(manifest.sourceSetSha256 || "").toUpperCase()) {
    throw new Error("Protected source manifest source-set hash does not match its text snapshots.");
  }
  return { contentIds, sourceById, manifest, manifestPath };
}

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import grep from "../../Code/IcmlGrep.cjs";
import policy from "../../Code/TranslationGrepRules.cjs";
import { isStrictlyInside, pathsEqual } from "./PathSafety.mjs";

export const hash = value => crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
export const engineSha256 = () => hash(fs.readFileSync(new URL("../../Code/IcmlGrep.cjs",import.meta.url)));
const json = file => JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/u,""));

export function assertNoIcmlLocks(config) {
  const workspace = path.resolve(config.productionWorkspace.root);
  const textRoot = path.resolve(config.productionWorkspace.textFolder);
  if (!isStrictlyInside(textRoot,workspace)) throw Error("Text folder is outside the edition.");
  // Never follow junctions. Bound the scan and refuse all InDesign/InCopy locks,
  // including assignment locks, rather than guessing which open editor owns one.
  const pending = [workspace]; let entries = 0;
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory,{ withFileTypes:true })) {
      if (++entries > 25000) throw Error("Edition lock scan exceeds 25,000 entries.");
      if (entry.isSymbolicLink()) throw Error("Edition contains a redirected path; ICML write blocked.");
      if (/\.(?:idlk|iclk|lck|lock)$/iu.test(entry.name)) throw Error("InDesign/InCopy lock found. Save, check in and close the edition before writing ICML.");
      if (entry.isDirectory()) pending.push(path.join(directory,entry.name));
    }
  }
}

export function assertRegularContained(file, root) {
  if (!isStrictlyInside(file,root)) throw Error("ICML path escapes the approved root.");
  let current = file;
  for (;;) {
    if (fs.lstatSync(current).isSymbolicLink()) throw Error("Redirected ICML path is forbidden.");
    if (pathsEqual(current,root)) break;
    current = path.dirname(current);
  }
  if (!fs.statSync(file).isFile()) throw Error("ICML path is not a regular file.");
}

export function verifyIcmlGrepJob(jobPath) {
  const config = json(path.join(jobPath,"job_config.json")), manifest = json(path.join(jobPath,"job_manifest.json"));
  if (!pathsEqual(config.jobPath,jobPath) || !config.productionWorkspace) throw Error("Not the configured production job.");
  const imported = manifest.import, selected = policy.resolveGrepRules(config.targetLanguage);
  if (manifest.qa?.status !== "passed" || !manifest.qa.grepProtection ||
      imported?.grep?.method !== "offline_icml_grep" || imported.grep.status !== "passed" ||
      imported.grep.policySha256 !== selected.sha256 || imported.grep.engineSha256 !== engineSha256()) throw Error("Current offline ICML GREP import evidence is missing; validate and import first.");
  if (hash(fs.readFileSync(config.paths.outputWorkbook)) !== imported.workbookSha256 ||
      imported.workbookSha256 !== manifest.qa.hashes.outputWorkbookSha256) throw Error("Workbook changed since the accepted ICML GREP import.");
  if (imported.grep.protectionSha256 !== hash(JSON.stringify(manifest.qa.grepProtection))) throw Error("GREP protection policy changed since import.");
  const expected = manifest.icmlFiles;
  if (!Array.isArray(expected) || !expected.length || expected.length > 5000 || imported.icmlFiles.length !== expected.length) throw Error("Incomplete ICML GREP file coverage.");
  const paths = new Set(expected.map(file=>path.resolve(file.path).toLowerCase()));
  if (paths.size !== expected.length) throw Error("Duplicate ICML manifest path.");
  const records = [];
  for (const file of imported.icmlFiles) {
    const filePath = path.resolve(file.path);
    if (!paths.delete(filePath.toLowerCase())) throw Error("Duplicate/unexpected imported ICML path.");
    assertRegularContained(filePath, path.resolve(config.productionWorkspace.textFolder));
    const text = fs.readFileSync(filePath,"utf8");
    if (hash(text.replace(/^\uFEFF/u,"")) !== file.afterSha256) throw Error("ICML changed after import; offline GREP evidence is stale.");
    const result = grep.applyIcmlGrep(text,config.targetLanguage,manifest.qa.grepProtection);
    if (result.changed) throw Error("ICML still needs GREP corrections; validate and reimport.");
    records.push({ path: filePath, rules: result.records });
  }
  return { status:"passed", method:"offline_icml_grep", files:records.length, policySha256:selected.sha256, records };
}
if (process.argv[1] && pathsEqual(fileURLToPath(import.meta.url),process.argv[1])) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--job") throw Error("Usage: node IcmlGrepJob.mjs --job <job> (read-only verification)");
  const result = verifyIcmlGrepJob(path.resolve(args[1]));
  console.log(`ICML_GREP_VERIFIED|files=${result.files}|method=${result.method}|policy=${result.policySha256}`);
}

// Reopen an accepted translation for a complete, baseline-preserving rules review.
// This command does not change the translated workbook, ICML, or Adobe document.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import transactions from "../../Code/TransactionalFileReplacement.cjs";
import editorialRules from "../../Code/TranslationEditorialRules.cjs";
import { isStrictlyInside, pathsEqual } from "./PathSafety.mjs";

const digest=bytes=>crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase();
const readJson=file=>JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
const json=value=>Buffer.from(`${JSON.stringify(value,null,2)}\n`,"utf8");

export function prepareEditorialReview(requestedJobPath) {
  const jobPath=path.resolve(requestedJobPath);
  const configPath=path.join(jobPath,"job_config.json");
  const manifestPath=path.join(jobPath,"job_manifest.json");
  const journal=path.join(jobPath,"state","editorial_preparation_transaction.json");
  transactions.recoverFileSetJournalSync(journal);
  const config=readJson(configPath);
  const manifest=readJson(manifestPath);
  if(!pathsEqual(config.jobPath,jobPath)||config.jobId!==manifest.jobId) throw Error("Editorial review job identity mismatch.");
  const selected=editorialRules.resolveEditorialRules(config.targetLanguage,"text");
  if(config.baselineTranslation?.mode==="editorial_review" && config.editorialRules?.sha256===selected.sha256){
    if(!isStrictlyInside(config.editorialRules.path,jobPath)||digest(fs.readFileSync(config.editorialRules.path))!==selected.sha256) throw Error("Editorial policy snapshot changed; resume blocked.");
    if(!isStrictlyInside(config.baselineTranslation.workbookPath,jobPath)||
       digest(fs.readFileSync(config.baselineTranslation.workbookPath))!==config.baselineTranslation.workbookSha256){
      throw Error("Editorial baseline changed; resume blocked.");
    }
    return {status:"already_prepared",jobPath,policySha256:selected.sha256};
  }
  if(!["complete","imported","translated","ready_for_import","qa_failed"].includes(manifest.status)){
    throw Error(`Cannot prepare an editorial review from status ${manifest.status}.`);
  }
  const outputPath=path.resolve(String(config.paths?.outputWorkbook||""));
  if(!isStrictlyInside(outputPath,jobPath)) throw Error("Editorial baseline must be inside the job.");
  const outputBytes=fs.readFileSync(outputPath);
  const currentImport=manifest.import || manifest.invalidatedImport?.import;
  if(config.productionWorkspace && currentImport){
    const textRoot=path.resolve(config.productionWorkspace.textFolder);
    if(!isStrictlyInside(textRoot,config.productionWorkspace.root)) throw Error("Editorial Text folder is outside the edition.");
    const files=currentImport.icmlFiles;
    if(!Array.isArray(files)||!files.length||files.length>5000||files.length!==manifest.icmlFiles?.length) throw Error("Incomplete prior ICML import evidence.");
    const expected=new Set(manifest.icmlFiles.map(file=>path.resolve(file.path).toLowerCase()));
    for(const file of files){
      const key=path.resolve(file.path).toLowerCase();
      if(!isStrictlyInside(file.path,textRoot)||!expected.delete(key)) throw Error("Invalid or duplicate previous ICML path.");
      const bytes=fs.readFileSync(file.path,"utf8").replace(/^\uFEFF/,"");
      if(digest(bytes)!==file.afterSha256) throw Error(`ICML changed after the previous import: ${file.path}`);
    }
    if(expected.size) throw Error("Missing previous ICML paths.");
  }
  const baselinePath=path.join(jobPath,"input","editorial_baseline.xlsx");
  const policyPath=path.join(jobPath,"input","editorial_rules.json");
  const policyBytes=fs.readFileSync(new URL("../../Code/TranslationEditorialRules.json",import.meta.url));
  if(digest(policyBytes)!==selected.sha256) throw Error("Editorial policy changed during preparation.");
  const before={config,manifest};
  const nextConfig=structuredClone(config);
  nextConfig.baselineTranslation={mode:"editorial_review",workbookPath:baselinePath,workbookSha256:digest(outputBytes)};
  nextConfig.editorialRules={version:selected.version,sha256:selected.sha256,path:policyPath};
  nextConfig.subscriptionStateName=`codex_editorial_${selected.sha256.slice(0,12)}_${digest(outputBytes).slice(0,12)}`;
  const nextManifest=structuredClone(manifest);
  if(manifest.import){
    nextManifest.invalidatedImport={invalidatedAt:new Date().toISOString(),reason:"Authorized editorial-rule review requires re-import and a fresh layout audit.",import:manifest.import,layoutFinalization:manifest.layoutFinalization||null};
  }
  delete nextManifest.import;
  delete nextManifest.layoutFinalization;
  delete nextManifest.completion;
  nextManifest.status="exported";
  nextManifest.editorialReview={status:"prepared",policySha256:selected.sha256,baselineSha256:digest(outputBytes),requiredStages:["text","icml","layout"]};
  transactions.commitFileSetWithJournalSync(journal,[
    {filePath:path.join(jobPath,"state","editorial_review_before.json"),data:json(before)},
    {filePath:baselinePath,data:outputBytes},
    {filePath:policyPath,data:policyBytes},
    {filePath:configPath,data:json(nextConfig)},
    {filePath:manifestPath,data:json(nextManifest)},
  ]);
  return {status:"prepared",jobPath,policySha256:selected.sha256,baselineSha256:digest(outputBytes)};
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length!==4||process.argv[2]!=="--job") throw Error("Use --job <existing translation job>.");
  console.log(JSON.stringify(prepareEditorialReview(process.argv[3])));
}

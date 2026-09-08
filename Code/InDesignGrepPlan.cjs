"use strict";
const {resolveGrepRules,replacementForMatch}=require("./TranslationGrepRules.cjs");
function planGrep(audit,language){
  const policy=resolveGrepRules(language);
  if(audit.status!=="inventory_complete" || audit.policySha256!==policy.sha256)throw Error("Current complete native GREP audit required.");
  const stories=audit.stories,records=audit.records;
  if(!Array.isArray(stories) || !stories.length || stories.length>5000 || !Array.isArray(records) || new Set(stories.map(s=>String(s.id))).size!==stories.length)throw Error("Invalid story inventory.");
  const scopes=[],totals=[];
  for(const rule of policy.applicable){
    let matches=0,changes=0,excluded=0,noops=0;
    for(const story of stories){
      const runs=records.filter(r=>r.kind==="GREP_RUN" && String(r.storyId)===String(story.id) && r.ruleId===rule.id);
      const found=records.filter(r=>r.kind==="GREP_MATCH" && String(r.storyId)===String(story.id) && r.ruleId===rule.id);
      if(runs.length!==1 || Number(runs[0].matches)!==found.length)throw Error(`Incomplete native GREP run: ${rule.id}, story ${story.id}`);
      const expected=[];
      for(const row of found){
        matches++;
        if(row.reason){if(!["protected_source","panel_cross_reference"].includes(row.reason))throw Error("Unknown GREP exclusion");excluded++;continue;}
        const before=String(row.text),after=replacementForMatch(rule,before);
        expected.push({before,after});
        if(before===after)noops++;else changes++;
      }
      if(expected.some(row=>row.before!==row.after))scopes.push({storyId:story.id,referenceIds:story.referenceIds,protectedStyles:audit.protectedStyles,rules:[rule],expected});
    }
    totals.push({id:rule.id,runs:stories.length,matches,changes,excluded,noops});
  }
  if(records.filter(r=>r.kind==="GREP_RUN").length!==stories.length*policy.applicable.length)throw Error("Unexpected or duplicated GREP runs.");
  return {schemaVersion:1,method:"indesign_native_grep",status:scopes.length?"changes_required":"passed",policySha256:policy.sha256,documentPath:audit.documentPath,documentSha256:audit.documentSha256,language,storyCount:stories.length,totals,notApplicable:policy.notApplicable,scopes};
}
module.exports={planGrep};
if(require.main===module){
  try{
    const fs=require("node:fs"),path=require("node:path"),{writeJsonAtomicSync}=require("./AtomicFiles.cjs");
    const args={};for(let i=2;i<process.argv.length;i+=2){if(!["--job","--audit","--output","--verify-plan"].includes(process.argv[i]) || !process.argv[i+1])throw Error("Invalid GREP planning arguments.");args[process.argv[i].slice(2)]=process.argv[i+1];}
    if(!args.job || !(args.output || args['verify-plan']) || (args.output && args['verify-plan']))throw Error("--job and exactly one of --output or --verify-plan required.");
    const job=path.resolve(args.job),inside=file=>{const r=path.relative(job,path.resolve(file));return r && !r.startsWith("..") && !path.isAbsolute(r);};
    if(!inside(args.output || args['verify-plan']) || (args.audit && !inside(args.audit)))throw Error("GREP evidence must remain inside the job.");
    const read=file=>JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
    const config=read(path.join(job,"job_config.json"));
    if(path.resolve(config.jobPath)!==job)throw Error("GREP job path mismatch.");
    let result=resolveGrepRules(config.targetLanguage);
    if(args.audit){const audit=read(args.audit);if(path.resolve(audit.documentPath)!==path.resolve(config.productionWorkspace.documentPath))throw Error("GREP document mismatch.");result=planGrep(audit,config.targetLanguage);}
    if(args['verify-plan']){
      if(!args.audit || JSON.stringify(read(args['verify-plan']))!==JSON.stringify(result))throw Error("GREP plan differs from the native audit and current rules; re-audit before applying.");
    }else writeJsonAtomicSync(args.output,result,{trailingNewline:true});
    console.log(`GREP_PLAN|status=${result.status||"policy_ready"}|scopes=${result.scopes?.length||0}|policy=${result.policySha256||result.sha256}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}

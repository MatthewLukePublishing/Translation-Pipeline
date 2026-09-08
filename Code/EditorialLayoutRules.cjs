"use strict";
const {resolveEditorialRules}=require("./TranslationEditorialRules.cjs");

function compileTemplate(template){
  const blocks=[];
  const expression=/<fullPara delim="([^"]*)"\s*\/>|<paraText\s*\/>|<pageNum\s*\/>/gu;
  let cursor=0;
  const custom=text=>{if(text)blocks.push({type:"CUSTOM_STRING_BUILDING_BLOCK",customText:text.replace(/\^S/gu,"\u00a0")});};
  for(const match of template.matchAll(expression)){
    custom(template.slice(cursor,match.index));
    blocks.push(match[1]!==undefined ? {type:"FULL_PARAGRAPH_BUILDING_BLOCK",delimiter:match[1]} : {type:match[0].startsWith("<paraText") ? "PARAGRAPH_TEXT_BUILDING_BLOCK" : "PAGE_NUMBER_BUILDING_BLOCK"});
    cursor=match.index+match[0].length;
  }
  custom(template.slice(cursor));
  if(blocks.some(block=>/[<>]|\^[A-Za-z]/u.test(block.customText||"")))throw Error("Unsupported cross-reference template syntax.");
  return blocks;
}
function cachedTextMatchesTemplate(text,blocks){
  if(typeof text!=="string")throw Error("Cross-reference cached-text inventory is incomplete.");
  const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/gu,"\\$&");
  const pattern=blocks.map(block=>block.type==="CUSTOM_STRING_BUILDING_BLOCK"?escape(block.customText):block.type==="PAGE_NUMBER_BUILDING_BLOCK"?"[0-9A-Za-z–-]+":"[^\\r\\n]+?").join("");
  return new RegExp(`^${pattern}$`,"u").test(text);
}

function planEditorialLayout(audit,language,protectedStyleNames=[]){
  const policy=resolveEditorialRules(language,"layout");
  if(audit.status!=="inventory_complete" || !Array.isArray(audit.records))throw Error("Complete read-only editorial inventory required.");
  const layers=audit.records.filter(row=>row.kind==="LAYER");
  const expectedLayers=["KDP","Images","Body","Peripheral","Background"];
  if(JSON.stringify(layers.map(row=>row.name))!==JSON.stringify(expectedLayers))throw Error("Layer order differs from the house-style order; explicit layout review required.");
  const styles=audit.records.filter(row=>row.kind==="STYLE");
  for(const [name,indented] of [["Body Text No Indent",false],["Body Text Indented",true]]){
    const found=styles.filter(row=>row.name===name);
    if(found.length!==1 || !Number.isFinite(Number(found[0].firstLineIndent)) || (indented ? Number(found[0].firstLineIndent)<=0 : Number(found[0].firstLineIndent)!==0))throw Error(`Body indentation style requires review: ${name}`);
  }
  const references=audit.records.filter(row=>row.kind==="REFERENCE");
  if(references.some(row=>!row.paragraphStyle))throw Error("Reference paragraph-style inventory is incomplete.");
  const formats=audit.records.filter(row=>row.kind==="FORMAT");
  const protectedSet=new Set(protectedStyleNames);
  const isProtected=row=>protectedSet.has(row.paragraphStyle.split("/").at(-1)) || protectedSet.has(row.paragraphStyle);
  const formatNames={"In the text":"text","Image":"image","Credits":"credit"};
  const edits=[],updates=[],preserved=[];
  for(const format of formats){
    const used=references.filter(row=>String(row.formatId)===String(format.id));
    if(!used.length)continue;
    const protectedRefs=used.filter(isProtected);
    if(protectedRefs.length===used.length){preserved.push(...protectedRefs.map(row=>row.id));continue;}
    if(protectedRefs.length)throw Error(`Format ${format.name} is shared with protected content; separate formats require explicit review.`);
    const templateKey=formatNames[format.name];
    if(!templateKey)throw Error(`Used cross-reference format needs an explicit policy mapping: ${format.name}`);
    const expected=compileTemplate(policy.language.crossReferences[templateKey]);
    const actual=audit.records.filter(row=>row.kind==="BLOCK" && String(row.formatId)===String(format.id)).sort((a,b)=>Number(a.index)-Number(b.index));
    if(actual.length!==Number(format.blocks) || actual.length!==expected.length)throw Error(`Cross-reference block count differs: ${format.name}`);
    const blocks=expected.map((block,index)=>{
      if(block.type!==actual[index].type || (block.delimiter!==undefined && (block.delimiter!==actual[index].delimiter || String(actual[index].includeDelimiter)!=="false")))throw Error(`Cross-reference dynamic structure differs: ${format.name}`);
      return {...block,beforeText:actual[index].customText||""};
    });
    const formatChanged=blocks.some(block=>block.type==="CUSTOM_STRING_BUILDING_BLOCK" && block.beforeText!==block.customText);
    if(formatChanged){
      edits.push({id:format.id,name:format.name,definition:policy.language.crossReferences[templateKey],blocks});
    }
    for(const row of used)if(formatChanged || !cachedTextMatchesTemplate(row.text,expected))updates.push({id:row.id,formatId:row.formatId});
  }
  const formatIds=new Set(formats.map(row=>String(row.id)));
  if(references.some(row=>!formatIds.has(String(row.formatId))))throw Error("Reference uses an uninspected format.");
  return {schemaVersion:1,applicationMethod:"cross_reference_panel_encoder",policySha256:policy.sha256,language,documentSha256:audit.documentSha256,documentPath:audit.sourceDocument,
    formatEdits:edits,referenceUpdates:updates,protectedReferenceIds:preserved,
    checks:{layerOrder:"passed",bodyIndentStyles:"passed",crossReferenceTemplates:edits.length?"changes_required":"passed",crossReferenceCachedWrappers:updates.length?"panel_update_required":"passed"},
    retainedLayoutRules:policy.rules.filter(rule=>!["layer_order","paragraph_indents","cross_references"].includes(rule.id))};
}
module.exports={compileTemplate,cachedTextMatchesTemplate,planEditorialLayout};

if(require.main===module){
  try{
    const fs=require("node:fs"),path=require("node:path");
    const {writeJsonAtomicSync}=require("./AtomicFiles.cjs");
    const options={};
    for(let i=2;i<process.argv.length;i++){
      const flag=process.argv[i];
      if(flag==="--verify")options.verify=true;
      else if(["--job","--audit","--output"].includes(flag))options[flag.slice(2)]=process.argv[++i];
      else throw Error(`Unknown argument: ${flag}`);
    }
    if(!options.job || !options.audit || !options.output)throw Error("--job, --audit and --output required.");
    const job=path.resolve(options.job);
    const inside=(file,parent)=>{const relative=path.relative(parent,path.resolve(file));return relative && !relative.startsWith("..") && !path.isAbsolute(relative);};
    for(const file of [options.audit,options.output])if(!inside(file,job))throw Error("Editorial evidence must remain within the job.");
    const read=file=>JSON.parse(fs.readFileSync(file,"utf8").replace(/^\uFEFF/,""));
    const config=read(path.join(job,"job_config.json")),manifest=read(path.join(job,"job_manifest.json")),audit=read(options.audit);
    if(path.resolve(config.jobPath)!==job || !config.productionWorkspace || path.resolve(audit.sourceDocument)!==path.resolve(config.productionWorkspace.documentPath) || !inside(audit.sourceDocument,config.productionWorkspace.root))throw Error("Editorial audit does not match the isolated production job.");
    const plan=planEditorialLayout(audit,config.targetLanguage,config.protectedSourceRules?.paragraphStyleName?[config.protectedSourceRules.paragraphStyleName]:[]);
    if(manifest.status!=="imported" || manifest.qa?.editorialRules?.sha256!==plan.policySha256 || manifest.import?.editorialRules?.sha256!==plan.policySha256)throw Error("Editorial layout requires imported content and QA under the current rules.");
    if(options.verify && (plan.formatEdits.length || plan.referenceUpdates.length))throw Error("Editorial cross-reference panel changes or cached-text refreshes remain unapplied.");
    writeJsonAtomicSync(options.output,plan,{trailingNewline:true});
    console.log(`EDITORIAL_LAYOUT_PLAN|formats=${plan.formatEdits.length}|references=${plan.referenceUpdates.length}|protected=${plan.protectedReferenceIds.length}`);
  }catch(error){console.error(error.message);process.exitCode=1;}
}

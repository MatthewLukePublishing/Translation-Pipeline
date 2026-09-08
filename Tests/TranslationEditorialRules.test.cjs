"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const rules=require("../Code/TranslationEditorialRules.cjs");
const fs=require("node:fs");
const os=require("node:os");
const path=require("node:path");
const crypto=require("node:crypto");
const {spawnSync}=require("node:child_process");

test("Stage 1 supplies scoped authoring rules without requiring or editing private glossary files",()=>{
  const run=spawnSync(process.execPath,[path.join(__dirname,"../01 Translate Glossaries/Code/Shared/Build_Glossary_Runtime.cjs"),"--rules","French"],{encoding:"utf8",windowsHide:true});
  assert.equal(run.status,0,run.stderr);
  assert.match(run.stdout,/stage glossary/);
  assert.match(run.stdout,/Approved glossary entries remain authoritative/);
  assert.doesNotMatch(run.stdout,/\[layer_order\]/);
});

test("editorial rules cover English plus all nine translation languages and route by stage",()=>{
  assert.equal(rules.LANGUAGES.length,10);
  for(const language of rules.LANGUAGES){
    for(const stage of rules.STAGES){
      const selected=rules.resolveEditorialRules(language,stage);
      assert.equal(selected.language.language,language);
      assert.match(selected.sha256,/^[A-F0-9]{64}$/);
      assert.ok(selected.rules.every(rule=>rule.stages.includes(stage)));
    }
    assert.ok(rules.editorialPrompt(language,"text").includes("[unit_system]"));
    assert.ok(!rules.editorialPrompt(language,"text").includes("[layer_order]"));
    assert.ok(rules.editorialPrompt(language,"layout").includes("[layer_order]"));
  }
  assert.throws(()=>rules.resolveEditorialRules("Unknown","text"),/No editorial policy/);
  assert.throws(()=>rules.resolveEditorialRules("French","unknown"),/Unknown editorial/);
  assert.equal(rules.resolveEditorialRules("Brazilian Portuguese","caption").language.quotes,"“texto”");
  assert.throws(()=>rules.editorialPrompt("French","text","outdated"),/rules changed/);
});

test("editorial review snapshots the accepted workbook and preserves prior import evidence",async()=>{
  const {prepareEditorialReview}=await import("../02 Translate Text/Code/Prepare-EditorialReview.mjs");
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),"translation-editorial-"));
  try{
    const job=path.join(folder,"job");
    const edition=path.join(folder,"edition");
    const textRoot=path.join(edition,"Text");
    fs.mkdirSync(path.join(job,"output"),{recursive:true});
    fs.mkdirSync(textRoot,{recursive:true});
    const output=path.join(job,"output","content_import.xlsx");
    const icml=path.join(textRoot,"story.icml");
    fs.writeFileSync(output,"accepted literal workbook bytes");
    fs.writeFileSync(icml,"accepted translated ICML");
    const sha=value=>crypto.createHash("sha256").update(value).digest("hex").toUpperCase();
    const config={jobId:"synthetic",jobPath:job,targetLanguage:"French",paths:{outputWorkbook:output},productionWorkspace:{root:edition,textFolder:textRoot}};
    const previousImport={icmlFiles:[{path:icml,afterSha256:sha(fs.readFileSync(icml))}]};
    const manifest={jobId:"synthetic",status:"complete",icmlFiles:[{path:icml}],import:previousImport,completion:{status:"complete"}};
    fs.writeFileSync(path.join(job,"job_config.json"),JSON.stringify(config));
    fs.writeFileSync(path.join(job,"job_manifest.json"),JSON.stringify(manifest));
    assert.equal(prepareEditorialReview(job).status,"prepared");
    const current=JSON.parse(fs.readFileSync(path.join(job,"job_manifest.json"),"utf8"));
    assert.equal(current.status,"exported");
    assert.equal(current.import,undefined);
    assert.equal(current.completion,undefined);
    assert.deepEqual(current.invalidatedImport.import,previousImport);
    assert.equal(fs.readFileSync(output,"utf8"),"accepted literal workbook bytes");
    assert.equal(fs.readFileSync(path.join(job,"input","editorial_baseline.xlsx"),"utf8"),"accepted literal workbook bytes");
    assert.equal(fs.readFileSync(icml,"utf8"),"accepted translated ICML");
    assert.equal(prepareEditorialReview(job).status,"already_prepared");
    fs.writeFileSync(path.join(job,"input","editorial_rules.json"),"{}");
    assert.throws(()=>prepareEditorialReview(job),/policy snapshot changed/);
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
});

test("French dates have full months and nonbreaking date components",()=>{
  assert.equal(rules.normalizeEditorialText("Paris, 25 Oct 2004.","French"),"Paris, 25\u00A0octobre\u00A02004.");
  assert.equal(rules.normalizeEditorialText("1 janv. 2004; 2 févr. 2005", "French"),"1er\u00A0janvier\u00A02004\u202F; 2\u00A0février\u00A02005");
  assert.equal(rules.normalizeEditorialText("32 Oct 2004", "French"),"32 Oct 2004");
});

test("typography normalization preserves syntax, protected names, attached calibres and breaks",()=>{
  const input='«Bonjour» : 5 % et 12 km. 3 + 4 = 7.\nhttps://example.test/a?q=1&x=2 <?ACE 4?> <Content x="!"> &amp; 9mm';
  const expected='«\u202FBonjour\u202F»\u202F: 5\u202F% et 12\u00A0km. 3\u00A0+\u00A04\u00A0=\u00A07.\nhttps://example.test/a?q=1&x=2 <?ACE 4?> <Content x="!"> &amp; 9mm';
  assert.equal(rules.normalizeEditorialText(input,"French"),expected);
  assert.equal(rules.normalizeEditorialText(expected,"French"),expected);
  assert.equal(rules.normalizeEditorialText(input,"French",{protected:true}),input);
  assert.equal(rules.normalizeEditorialText("Label: 3 km", "French", {protectedStrings:["Label: 3 km"]}),"Label: 3 km");
  assert.equal(rules.normalizeEditorialText("13:45 3/4 -5 4-8", "French"),"13:45 3/4 -5 4-8");
  assert.deepEqual(rules.auditEditorialText(expected,"French"),[]);
  assert.equal(rules.auditEditorialText(input,"French")[0].severity,"error");
});

test("French spacing and apostrophe policies do not leak into other languages",()=>{
  assert.equal(rules.normalizeEditorialText("Text: 5%", "English"),"Text: 5%");
  assert.equal(rules.normalizeEditorialText("Text: 5%", "German"),"Text: 5\u00A0%");
  assert.equal(rules.normalizeEditorialText("Text: 5%", "Swedish"),"Text: 5\u00A0%");
  assert.ok(!rules.editorialPrompt("French","text").includes("house-style acronym plural is MWD’s"));
  assert.match(rules.editorialPrompt("French","text"),/month.*year/);
});

test("date spacing covers every language and does not consume paragraph breaks",()=>{
  for(const language of rules.LANGUAGES){
    const {dateExample}=rules.resolveEditorialRules(language,"text").language;
    assert.equal(rules.normalizeEditorialText(dateExample.replaceAll("\u00A0"," "),language),dateExample);
    const broken=dateExample.replace("\u00A0","\n");
    assert.equal(rules.normalizeEditorialText(broken,language),broken);
  }
});

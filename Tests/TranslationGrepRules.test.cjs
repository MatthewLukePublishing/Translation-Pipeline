const test=require("node:test"),assert=require("node:assert/strict");
const grep=require("../Code/TranslationGrepRules.cjs");
const {LANGUAGES,resolveEditorialRules}=require("../Code/TranslationEditorialRules.cjs");
test("all supplied GREP formulas have executable language-scoped entries",()=>{
  assert.equal(grep.rules.length,17,"four French, units, math before/after and ten date expressions");
  assert.equal(new Set(grep.rules.map(rule=>rule.id)).size,17);
  for(const rule of grep.rules)assert.doesNotThrow(()=>grep.previewExpression(rule));
  for(const language of LANGUAGES){
    const selected=grep.resolveGrepRules(language);
    assert.equal(selected.applicable.length,language==="French"?8:4);
    assert.equal(selected.applicable.length+selected.notApplicable.length,17);
    const date=selected.applicable.find(rule=>rule.id.startsWith("date_"));
    const example=resolveEditorialRules(language,"text").language.dateExample;
    assert.equal(example.replace(/\u00a0/gu," ").replace(grep.previewExpression(date),grep.previewReplacement(date)),example);
    assert.equal(example.replace(/\u00a0/u,"\n").replace(grep.previewExpression(date),grep.previewReplacement(date)),example.replace(/\u00a0/u,"\n"));
  }
});
test("literal math operators and French replacements preserve nonwhitespace characters",()=>{
  const apply=(id,text)=>{const rule=grep.rules.find(rule=>rule.id===id);return text.replace(grep.previewExpression(rule),grep.previewReplacement(rule));};
  assert.equal(apply("math_before","2 + 3"),"2\u00a0+ 3");
  assert.equal(apply("math_after","2\u00a0+ 3"),"2\u00a0+\u00a03");
  assert.equal(apply("unit_nbsp","12 km"),"12\u00a0km");
  assert.equal(apply("unit_nbsp","9mm"),"9mm");
  assert.equal(apply("fr_open_quote","« texte"),"«\u202ftexte");
  assert.equal(apply("fr_close_quote","texte »"),"texte\u202f»");
  assert.equal(apply("fr_punctuation","texte :"),"texte\u202f:");
  assert.equal(apply("fr_em_dash","texte — suite"),"texte —\u202fsuite");
});
test("native scoped replacement keeps capture groups without lookaround context",()=>{
  for(const rule of grep.rules){
    const samples=['12 km','2 + 3','« texte »','texte :','texte — suite',...LANGUAGES.map(language=>resolveEditorialRules(language,'text').language.dateExample.replace(/\u00a0/gu,' '))];
    let count=0;
    for(const sample of samples)for(const match of sample.matchAll(grep.previewExpression(rule))){
      const expected=sample.replace(grep.previewExpression(rule),grep.previewReplacement(rule));
      assert.equal(sample.slice(0,match.index)+grep.replacementForMatch(rule,match[0])+sample.slice(match.index+match[0].length),expected);
      count++;
    }
    assert.ok(count>0,rule.id);
  }
});
test("GREP coverage fails closed for missing runs, excludes protected text and ignores no-op dates",()=>{
  const {planGrep}=require('../Code/InDesignGrepPlan.cjs');
  const policy=grep.resolveGrepRules('French');
  const audit={status:'inventory_complete',policySha256:policy.sha256,stories:[{id:'1',referenceIds:[]}],protectedStyles:['Credits'],records:policy.applicable.map(rule=>({kind:'GREP_RUN',storyId:'1',ruleId:rule.id,matches:0}))};
  assert.equal(planGrep(audit,'French').status,'passed');
  assert.throws(()=>planGrep({...audit,stories:[]},'French'),/Invalid story/);
  audit.records.find(r=>r.ruleId==='date_french').matches=1;
  assert.throws(()=>planGrep(audit,'French'),/Incomplete/);
  audit.records.push({kind:'GREP_MATCH',storyId:'1',ruleId:'date_french',text:'3\u00a0mai\u00a02026',reason:''});
  assert.equal(planGrep(audit,'French').status,'passed');
  audit.records.at(-1).text='3 mai 2026';
  assert.equal(planGrep(audit,'French').scopes.length,1);
  audit.records.at(-1).reason='panel_cross_reference';
  assert.equal(planGrep(audit,'French').status,'passed');
  audit.records.pop();audit.records.pop();
  assert.throws(()=>planGrep(audit,'French'),/Incomplete/);
});
test("GREP apply-plan validation rejects changed commands without touching the plan",()=>{
  const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
  const {planGrep}=require('../Code/InDesignGrepPlan.cjs');
  const job=fs.mkdtempSync(path.join(os.tmpdir(),'grep-plan-'));
  try{
    const documentPath=path.join(job,'edition','synthetic.indd'),policy=grep.resolveGrepRules('French');
    const audit={status:'inventory_complete',documentPath,policySha256:policy.sha256,documentSha256:'A'.repeat(64),stories:[{id:'1',referenceIds:[]}],protectedStyles:[],records:policy.applicable.map(rule=>({kind:'GREP_RUN',storyId:'1',ruleId:rule.id,matches:0}))};
    const auditFile=path.join(job,'audit.json'),planFile=path.join(job,'plan.json');
    fs.writeFileSync(path.join(job,'job_config.json'),JSON.stringify({jobPath:job,targetLanguage:'French',productionWorkspace:{documentPath}}));
    fs.writeFileSync(auditFile,JSON.stringify(audit));fs.writeFileSync(planFile,JSON.stringify(planGrep(audit,'French')));
    const run=()=>spawnSync(process.execPath,[path.join(__dirname,'../Code/InDesignGrepPlan.cjs'),'--job',job,'--audit',auditFile,'--verify-plan',planFile],{encoding:'utf8',windowsHide:true});
    assert.equal(run().status,0);
    const changed=JSON.parse(fs.readFileSync(planFile,'utf8'));changed.scopes=[{storyId:1,rules:[{find:'.+',change:'unexpected'}]}];
    fs.writeFileSync(planFile,JSON.stringify(changed));
    const blocked=run();assert.notEqual(blocked.status,0);assert.match(blocked.stderr,/differs from the native audit/);
    assert.deepEqual(JSON.parse(fs.readFileSync(planFile,'utf8')),changed);
  }finally{fs.rmSync(job,{recursive:true,force:true});}
});

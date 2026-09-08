"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {rules,previewExpression,previewReplacement,replacementForMatch}=require('../Code/TranslationGrepRules.cjs');
const source=fs.readFileSync(path.join(__dirname,'../02 Translate Text/Code/InDesign/Run_Translation_Grep.jsx'),'utf8').replace(/^#target[^\n]*\n/u,'');
function harness(initial){
  let text=initial,changes=0;
  const special={NONBREAKING_SPACE:{toString:()=>"NONBREAKING_SPACE"},FIXED_WIDTH_NONBREAKING_SPACE:{toString:()=>"FIXED_WIDTH_NONBREAKING_SPACE"},THIN_SPACE:{toString:()=>"THIN_SPACE"}};
  const app={backgroundTasks:[],scriptPreferences:{userInteractionLevel:'original'}};
  for(const name of ['findGrepPreferences','changeGrepPreferences','findChangeGrepOptions']){
    let preferences;
    Object.defineProperty(app,name,{get:()=>preferences,set:value=>{
      preferences={...(typeof value==='object'?value:{})};
      Object.defineProperty(preferences,'properties',{get:()=>({...preferences}),set:value=>Object.assign(preferences,value),enumerable:false});
    }});
    app[name]={original:name};
  }
  const story={id:1,isValid:true,reflect:{name:'Story'},footnotes:[],endnotes:[],get characters(){return {length:text.length};}};
  const doc={fullName:{fsName:'C:/Synthetic/book.indd'},modified:false,stories:{itemByID:id=>id===1?story:null},crossReferenceSources:{itemByID:()=>null}};
  app.documents=[doc];
  let styleName='Body';
  function textRange(start,end){
    return {parentStory:story,get contents(){const value=text.slice(start,end);return value==='\u00a0'?special.NONBREAKING_SPACE:value==='\u202f'?special.FIXED_WIDTH_NONBREAKING_SPACE:value==='\u2009'?special.THIN_SPACE:value;},characters:{0:{index:start,parent:story},'-1':{index:end-1,parent:story}},paragraphs:[{appliedParagraphStyle:{name:styleName,parent:{reflect:{name:'Document'}}}}],
      findGrep(){return find(start,end,false);},
      changeGrep(){
        const before=text.slice(start,end),rule={find:app.findGrepPreferences.findWhat,change:app.changeGrepPreferences.changeTo};
        const after=before.replace(previewExpression(rule),previewReplacement(rule));
        if(after===before)return [];
        text=text.slice(0,start)+after+text.slice(end);changes++;doc.modified=true;
        return [textRange(start,start+after.length)];
      }};
  }
  function find(start,end,reverse){
    const expression=previewExpression({find:app.findGrepPreferences.findWhat});
    const matches=[...text.slice(start,end).matchAll(expression)].map(match=>textRange(start+match.index,start+match.index+match[0].length));
    return reverse?matches.reverse():matches;
  }
  story.findGrep=reverse=>find(0,text.length,reverse);
  const context={app,encodeURIComponent,SpecialCharacters:special,UserInteractionLevels:{NEVER_INTERACT:'none'},NothingEnum:{NOTHING:'nothing'},File:function(file){this.fsName=file;}};
  return {app,doc,story,get text(){return text;},get changes(){return changes;},set style(value){styleName=value;},reference(start,end){doc.crossReferenceSources.itemByID=id=>id===7?{isValid:true,sourceText:textRange(start,end)}:null;},
    run(action,settings,document='C:/Synthetic/book.indd'){
      return vm.runInNewContext(source.replace('__ACTION_JS__',JSON.stringify(action)).replace('__DOCUMENT_JS__',JSON.stringify(document)).replace('__SETTINGS_JS__',JSON.stringify(settings)),context);
    }};
}
const unit=rules.find(rule=>rule.id==='unit_nbsp');
function scope(rule=unit){return [{storyId:1,referenceIds:[],protectedStyles:['Credits'],rules:[rule],expected:[{before:' cm',after:'\u00a0cm'}]}];}
test('GREP audit uses original native expressions, preserves preferences and does not mutate',()=>{
  const h=harness('5 cm and 3 cm');
  const result=h.run('audit',scope());
  assert.match(result,/GREP_RUN\|storyId=1\|ruleId=unit_nbsp\|matches=2/);
  assert.equal(h.changes,0);
  assert.equal(h.app.scriptPreferences.userInteractionLevel,'original');
  for(const key of ['findGrepPreferences','changeGrepPreferences','findChangeGrepOptions'])assert.equal(h.app[key].properties.original,key);
});
test('bounded GREP applies only reviewed matches in reverse order with native replacements',()=>{
  const h=harness('5 cm and 3 cm'),settings=scope();
  settings[0].expected.push({...settings[0].expected[0]});
  assert.match(h.run('apply',settings),/GREP_CHANGED/);
  assert.equal(h.text,'5\u00a0cm and 3\u00a0cm');
  assert.equal(h.changes,2);
  assert.match(h.run('apply',settings),/^ERROR.*Unsaved/);
});
test('protected credits and cross-reference ranges cannot be changed by GREP',()=>{
  for(const protectedKind of ['style','reference']){
    const h=harness('5 cm and 3 cm'),settings=scope();
    if(protectedKind==='style'){h.style='Credits';settings[0].expected=[];}
    else{h.reference(0,4);settings[0].referenceIds=[7];}
    const result=h.run('apply',settings);
    assert.doesNotMatch(result,/^ERROR/);
    assert.match(result,protectedKind==='style'?/protected_source/:/panel_cross_reference/);
    assert.equal(h.text,protectedKind==='style'?'5 cm and 3 cm':'5 cm and 3\u00a0cm');
  }
});
test('stale, unexpected, unsaved and structurally unsafe GREP scopes fail closed',()=>{
  const h=harness('5 cm and 3 cm');
  assert.match(h.run('apply',scope()),/^ERROR.*matches changed/);
  assert.equal(h.changes,0);
  assert.match(h.run('audit',scope(),'C:/Synthetic/other.indd'),/^ERROR.*Unexpected/);
  assert.match(h.run('audit',Array(6).fill(scope()[0])),/^ERROR.*five/);
  h.doc.modified=true;assert.match(h.run('apply',scope()),/^ERROR.*Unsaved/);
  const tabs=harness('texte\t:');
  assert.match(tabs.run('audit',scope(rules.find(rule=>rule.id==='fr_punctuation'))),/^ERROR.*structural tab/);
  assert.equal(tabs.changes,0);
});
test('linked ICML is audited but never checked out or reserialized by native GREP',()=>{
  const h=harness('5 cm');
  h.story.itemLink={isValid:true};
  assert.match(h.run('audit',scope()),/GREP_MATCH/);
  assert.match(h.run('apply',scope()),/^ERROR.*translation workbook.*Content IDs/);
  assert.equal(h.changes,0);
  assert.equal(h.doc.modified,false);
});
test('single-character Adobe whitespace enumerators are decoded, never serialized as words',()=>{
  const h=harness('texte\u00a0:'),settings=scope(rules.find(rule=>rule.id==='fr_punctuation'));
  settings[0].expected=[{before:'\u00a0',after:'\u202f'}];
  const audit=h.run('audit',settings);
  assert.match(audit,/text=%C2%A0/);
  assert.doesNotMatch(audit,/NONBREAKING_SPACE/);
  assert.doesNotMatch(h.run('apply',settings),/^ERROR/);
  assert.equal(h.text,'texte\u202f:');
});
test('every expression can execute through the scoped worker without changing characters other than spacing',()=>{
  const examples={fr_punctuation:'texte :',fr_em_dash:'texte — suite',fr_open_quote:'« texte',fr_close_quote:'texte »',unit_nbsp:'12 cm',math_before:'2 + 3',math_after:'2 + 3'};
  const {LANGUAGES,resolveEditorialRules}=require('../Code/TranslationEditorialRules.cjs');
  for(const language of LANGUAGES)examples[`date_${language.toLowerCase()}`]=resolveEditorialRules(language,'text').language.dateExample.replace(/\u00a0/gu,' ');
  for(const rule of rules){
    const original=examples[rule.id],h=harness(original),settings=scope(rule);
    settings[0].expected=[...original.matchAll(previewExpression(rule))].map(match=>({before:match[0],after:replacementForMatch(rule,match[0])}));
    assert.doesNotMatch(h.run('apply',settings),/^ERROR/,rule.id);
    assert.equal(h.text,original.replace(previewExpression(rule),previewReplacement(rule)),rule.id);
  }
});

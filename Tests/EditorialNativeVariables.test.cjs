const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const worker=fs.readFileSync(path.join(__dirname,'../02 Translate Text/Code/InDesign/Run_Translation_Typography.jsx'),'utf8').replace(/^#target[^\n]*\n/u,'');
function audit(text,variables){
  const sourceText={contents:text,textVariableInstances:variables,parentStory:{id:4},paragraphs:[{appliedParagraphStyle:{name:'Body',parent:null}}]};
  const doc={fullName:{fsName:'C:/Synthetic/book.indd'},modified:false,crossReferenceSources:[{id:8,appliedFormat:{id:1},sourceText}]};
  const app={backgroundTasks:[],documents:[doc],scriptPreferences:{userInteractionLevel:'original'}};
  const script=worker.replace('__ACTION_JS__','"editorial-references"').replace('__DOCUMENT_JS__','"C:/Synthetic/book.indd"').replace('__START_JS__','0').replace('__COUNT_JS__','1').replace('__SETTINGS_JS__','[]').replace('__LANGUAGE_JS__','""');
  const result=vm.runInNewContext(script,{app,encodeURIComponent,UserInteractionLevels:{NEVER_INTERACT:'never'},File:function(value){this.fsName=value;this.exists=true;}});
  assert.equal(app.scriptPreferences.userInteractionLevel,'original');
  assert.equal(doc.modified,false);
  return result;
}
test('read-only editorial audit renders native page variables without converting or updating them',()=>{
  const result=audit('(consulter « Titre », p. \u0018)',[{get resultText(){return '175';},convertToText(){throw Error('Mutation forbidden');}}]);
  assert.match(decodeURIComponent(result),/text=\(consulter « Titre », p. 175\)/u);
  assert.doesNotMatch(result,/%18/);
  assert.match(audit('Image 1:',[]),/^REFERENCE/);
});
test('missing, extra, empty and unbounded native reference variables fail closed',()=>{
  for(const [text,variables] of [['page \u0018',[]],['page 1',[{resultText:'1'}]],['page \u0018',[{resultText:''}]],['page \u0018',Array(21).fill({resultText:'1'})]]){
    assert.match(audit(text,variables),/^ERROR/);
  }
});

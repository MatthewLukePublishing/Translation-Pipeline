const test = require("node:test"), assert = require("node:assert/strict");
const { applyIcmlGrep, transformText } = require("../Code/IcmlGrep.cjs");
const { LANGUAGES, resolveEditorialRules, normalizeEditorialText, editorialPrompt } = require("../Code/TranslationEditorialRules.cjs");
const wrap = body => `<Document><Story><ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Body" id="p1">${body}</ParagraphStyleRange></Story></Document>`;
const content = (id,text) => `<CharacterStyleRange AppliedCharacterStyle="CharacterStyle/Bold"><Content id="${id}">${text}</Content></CharacterStyleRange>`;
test("ICML GREP crosses formatting boundaries without moving letters, tags or IDs",()=>{
  const xml = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' + wrap(content("1","12 ")+content("2","km ; « ")+content("3","texte » 3 ")+content("4","mai 2026"));
  const expected = xml.replace('12 ','12\u00a0').replace('km ; « ','km\u202f; «\u202f').replace('texte » 3 ','texte\u202f» 3\u00a0').replace('mai 2026','mai\u00a02026');
  const result = applyIcmlGrep(xml,"French");
  assert.equal(result.text,expected);
  assert.equal(result.records.length,8); assert.equal(result.notApplicable.length,9);
  assert.equal(result.contentIdCount,4);
  assert.equal(applyIcmlGrep(result.text,"French").changed,false);
});
test("ICML GREP preserves protected credits, generated references, properties and variables",()=>{
  const ref = `<CrossReferenceSource Name="ref"><Content id="r">Voir : 3 mai 2026</Content><TextVariableInstance ResultText="12 km"/></CrossReferenceSource>`;
  const credits = '<ParagraphStyleRange AppliedParagraphStyle="ParagraphStyle/Group/Credits"><Content id="c">Credits : 12 km</Content></ParagraphStyleRange>';
  const xml = wrap(content("a","12 ")+ref+content("b","km ")+ '<Br/>' + content("d","3 mai 2026")+credits);
  const result = applyIcmlGrep(xml,"French");
  assert.ok(result.text.includes(ref)); assert.ok(result.text.includes(credits));
  assert.ok(result.text.includes('>12 </Content>'));
  assert.equal(result.protectedContents,2);
  assert.equal(result.text,xml.replace('>3 mai 2026<','>3\u00a0mai\u00a02026<'));
});
test("ICML GREP preserves XML entity spellings and structural tabs and works without IDs",()=>{
  const xml = wrap('<Content>2 &lt; 3 &amp; 12&#32;km&#9;«\ttexte »</Content>');
  const result = applyIcmlGrep(xml,"French");
  assert.equal(result.text,wrap('<Content>2\u00a0&lt;\u00a03 &amp; 12\u00a0km&#9;«\ttexte\u202f»</Content>'));
  assert.equal(result.contentIdCount,0);
  assert.equal(transformText('texte\t:', 'French').text,'texte\t:');
});
test("ICML GREP never joins table cells or paragraphs and preserves formatting properties",()=>{
  const props = '<Properties><AppliedFont type="string">Example Font</AppliedFont></Properties>';
  const xml = wrap(content("1","12 ")+props+content("2","km")) + '';
  assert.equal(applyIcmlGrep(xml,"French").text,xml.replace('12 ','12\u00a0'));
  const table = '<Document><Story><Table><Cell><ParagraphStyleRange><Content>12 </Content></ParagraphStyleRange></Cell><Cell><ParagraphStyleRange><Content>km</Content></ParagraphStyleRange></Cell></Table></Story></Document>';
  assert.equal(applyIcmlGrep(table,"French").text,table);
  const metadata='<Properties><GaijiRefMaps><![CDATA[/////wAAAAAAAAAA]]></GaijiRefMaps><Value Label="a>b"/></Properties>';
  const withMetadata=wrap(metadata+content("m","12 km"));
  assert.equal(applyIcmlGrep(withMetadata,"French").text,withMetadata.replace('12 km','12\u00a0km'));
});
test("official names, glossary strings and selected IDs remain exact across style boundaries",()=>{
  const xml=wrap(content("1","12 ")+content("2","km Unit — X")+content("3"," 14 km")+content("4"," !"));
  const result=applyIcmlGrep(xml,"French",{protectedStrings:["12 km Unit — X"],protectedContentIds:["4"]});
  assert.equal(result.text,xml.replace('14 km','14\u00a0km'));
  const padded=wrap(content("0004","12 km ;"));
  assert.equal(applyIcmlGrep(padded,"French",{protectedContentIds:["4"]}).text,padded);
});
test("all ten languages run every applicable formula, including zero matches",()=>{
  for(const language of LANGUAGES){
    const date=resolveEditorialRules(language,"text").language.dateExample;
    const xml=wrap(content("1",date.replace(/\u00a0/gu,' ')));
    const result=applyIcmlGrep(xml,language);
    assert.equal(result.text,wrap(content("1",date)));
    assert.equal(result.records.length,language==='French'?8:4);
    assert.equal(result.records.length+result.notApplicable.length,17);
    assert.equal(applyIcmlGrep(wrap(content("1","unchanged")),language).records.every(r=>r.matches===0),true);
  }
});
test("malformed XML, unsupported declarations and nontext content fail closed",()=>{
  for(const xml of [wrap('<Content id="a">a &unknown;</Content>'),wrap('<Content><Br/></Content>'),wrap('<Content>a</Wrong>'), '<!DOCTYPE Document>'+wrap(content("1","a")),wrap(content("1","a")+content("1","b")),wrap('<Content>&#0;</Content>')]) assert.throws(()=>applyIcmlGrep(xml,"French"));
});
test("translation prompts and postprocessing apply final spacing before export, not later UI cleanup",()=>{
  assert.match(editorialPrompt("French","text"),/during translation, before export\/import/);
  assert.equal(normalizeEditorialText("texte—suite 2 + 3", "French"), "texte —\u202fsuite 2\u00a0+\u00a03");
  const fs=require('node:fs'),path=require('node:path');
  const source=fs.readFileSync(path.join(__dirname,'../02 Translate Text/Code/Translate_ICML_Codex_Subscription.mjs'),'utf8');
  const call=source.lastIndexOf('applyLanguagePostprocessors(');
  assert.ok(call>0 && source.indexOf('XLSX',call)>call);
  const launcher=fs.readFileSync(path.join(__dirname,'../Run-Translation-Job.ps1'),'utf8');
  assert.ok(launcher.includes('Code\\IcmlGrepJob.mjs'));
  assert.ok(!launcher.includes('Invoke-InDesignGrepRules.ps1'));
});

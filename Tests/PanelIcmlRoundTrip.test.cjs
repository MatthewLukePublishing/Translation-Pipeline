const test=require('node:test'),assert=require('node:assert/strict');
const {reconcilePanelIcml}=require('../Code/PanelIcmlRoundTrip.cjs');
const base='<Document><CrossReferenceFormat Self="f" Name="In the text"><BuildingBlock CustomText="See"/></CrossReferenceFormat><Story><ParagraphStyleRange id="01" AppliedParagraphStyle="Body"><CharacterStyleRange><Content id="1">ordinary text</Content><CrossReferenceSource Self="s" Name="reference" AppliedFormat="f"><Content id="2">(See Heading, p. </Content><TextVariableInstance Self="v" ResultText="2"/><Content id="3">.)</Content></CrossReferenceSource><Br/></CharacterStyleRange></ParagraphStyleRange></Story></Document>';
const native=base.replace(/ id="[^"]*"/gu,'').replace('ordinary text','ordinary</Content><Content> text').replace('(See Heading, p. ','(consulter « Titre », p. ').replace('>.)<','>)<').replace('ResultText="2"','ResultText="3"').replace('CustomText="See"','CustomText="consulter"');
test('panel round-trip retains all IDs and original segmentation while adopting only encoded reference output',()=>{
  const result=reconcilePanelIcml(base,native,['reference']);
  assert.match(result.text,/<Content id="1">ordinary text<\/Content>/u);
  assert.match(result.text,/<Content id="2">\(consulter/u);
  assert.match(result.text,/Self="v" ResultText="3"/u);
  assert.equal(result.restoredContentIds,3);assert.equal(result.acceptedReferences,1);assert.equal(result.contentUpdates.length,2);
  assert.equal(result.protectedCachesRestored,0);
});
test('unselected and protected reference caches are restored verbatim',()=>{
  const result=reconcilePanelIcml(base,native,[]);
  assert.equal(result.text,base);assert.equal(result.protectedCachesRestored,1);assert.deepEqual(result.contentUpdates,[]);
});
test('uncertain panel round-trips fail before any file mutation',()=>{
  for(const bad of [native.replace('ordinary','changed'),native.replace('Name="reference"','Name="other"'),native.replace('<Br/>',''),native.replace('ResultText="3"','ResultText="#"'),native.replace('AppliedParagraphStyle="Body"','AppliedParagraphStyle="Other"')])assert.throws(()=>reconcilePanelIcml(base,bad,['reference']));
  assert.throws(()=>reconcilePanelIcml(base,native,['reference','reference']));
  assert.throws(()=>reconcilePanelIcml(base,native,['missing']));
  assert.throws(()=>reconcilePanelIcml('<!DOCTYPE test>'+base,native,[]));
});
test('panel reconciliation cannot silently discard style, destination or shared-format edits',()=>{
  for(const bad of [native.replace('<CharacterStyleRange>','<CharacterStyleRange AppliedCharacterStyle="Bold">'),native.replace('<Story>','<Story TrackChanges="true">'),native.replace('<Br/>','</CharacterStyleRange><CharacterStyleRange><Br/>')])assert.throws(()=>reconcilePanelIcml(base,bad,['reference']),/formatting or structure/);
  const second='<CrossReferenceSource Self="other" Name="protected" AppliedFormat="f"><Content id="4">Protected</Content></CrossReferenceSource>';
  const before=base.replace('<Br/>',second+'<Br/>'), after=native.replace('<Br/>',second.replace(' id="4"','')+'<Br/>');
  assert.throws(()=>reconcilePanelIcml(before,after,['reference']),/shared with an unselected/);
});

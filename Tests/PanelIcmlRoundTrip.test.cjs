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
test('native check-in identity renumbering preserves the same reference graph',()=>{
  const before=base.replace('Self="s"','Self="ua1"').replace('Self="v"','Self="ua2"').replace('</Document>','<Hyperlink Self="ua3" Source="ua1" Name="Link"/></Document>');
  const after=native.replace('Self="s"','Self="ub1"').replace('Self="v"','Self="ub2"').replace('</Document>','<Hyperlink Self="ub3" Source="ub1" Name="Link"/></Document>');
  const result=reconcilePanelIcml(before,after,['reference']);
  assert.match(result.text,/Self="ua3" Source="ua1"/u);
  assert.throws(()=>reconcilePanelIcml(before,after.replace('Source="ub1"','Source="ub2"'),['reference']));
  assert.throws(()=>reconcilePanelIcml(before,after.replace('Self="ub2"','Self="ub1"'),['reference']),/Duplicate/);
});
test('native preview regeneration is allowed but descriptive metadata remains exact',()=>{
  const xmp='<x:xmpmeta><rdf:RDF><rdf:Description xmlns:xmp="urn:xmp" xmlns:dc="urn:dc"><dc:title>Title</dc:title><xmp:Thumbnails><image>old</image></xmp:Thumbnails></rdf:Description></rdf:RDF></x:xmpmeta>';
  const updated=xmp.replace('xmlns:xmp="urn:xmp" xmlns:dc="urn:dc"','xmlns:dc="urn:dc" xmlns:xmp="urn:xmp"').replace('<xmp:Thumbnails><image>old</image></xmp:Thumbnails>','<xmp:PageInfo><image>new</image></xmp:PageInfo>');
  const before=base.replace('<Story>',xmp+'<Story>'),after=native.replace('<Story>',updated+'<Story>');
  assert.ok(reconcilePanelIcml(before,after,['reference']).text.includes(xmp));
  assert.throws(()=>reconcilePanelIcml(before,after.replace('>Title<','>Changed<'),['reference']),/metadata/);
});
test('only calculated table heights and new unindexed empty post-table nodes are restored',()=>{
  const table='<Table Self="ua4"><Row Self="ua4Row0" MinimumHeight="12" SingleRowHeight="12"/><Cell Self="ua4Cell0"/></Table>';
  const before=base.replace('<Br/>',table+'<Br/>');
  const after=native.replace('<Br/>',table.replaceAll('ua4','ub4').replace('SingleRowHeight="12"','SingleRowHeight="24"')+'<Content></Content><Br/>');
  assert.ok(reconcilePanelIcml(before,after,['reference']).text.includes(table));
  for(const bad of [after.replace('MinimumHeight="12"','MinimumHeight="24"'),after.replace('<Content></Content><Br/>','<Content>lost</Content><Br/>'),after.replace('SingleRowHeight="24"','SingleRowHeight="NaN"')])assert.throws(()=>reconcilePanelIcml(before,bad,['reference']));
});

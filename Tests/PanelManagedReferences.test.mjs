import test from 'node:test';
import assert from 'node:assert/strict';
import {panelManagedContent,preservePanelManagedContent} from '../02 Translate Text/Code/PanelManagedReferences.mjs';
test('panel-generated cached segments are preserved while ordinary text stays editable',()=>{
  const xml='<Content id="1">ordinary</Content><CrossReferenceSource Self="a"><Content id="002">(See </Content><Content id="03">heading, 3)</Content></CrossReferenceSource><Content id="4">tail</Content>';
  const values=panelManagedContent(xml);
  assert.deepEqual([...values],[['2','(See '],['3','heading, 3)']]);
  const rows=[['A','B','C','D'],['','','1','traduit'],['','','002','(consulter '],['','','03','titre, 3)'],['','','4','fin']];
  assert.deepEqual(preservePanelManagedContent(rows,values),{method:'cross_reference_panel_encoder_only',segments:2,discardedModelEdits:2});
  assert.deepEqual(rows.map(r=>r[3]),['D','traduit','(See ','heading, 3)','fin']);
  assert.throws(()=>preservePanelManagedContent(rows.slice(0,3),values),/missing/);
  assert.throws(()=>panelManagedContent('<CrossReferenceSource><Content id="1">x</Content>'),/Unbalanced/);
  assert.throws(()=>panelManagedContent('<CrossReferenceSource><Content>x</Content></CrossReferenceSource>'),/Missing/);
  assert.throws(()=>panelManagedContent(xml+xml),/duplicate/);
});

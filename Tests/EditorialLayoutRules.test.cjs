const test=require("node:test"),assert=require("node:assert/strict");
const {compileTemplate,planEditorialLayout}=require("../Code/EditorialLayoutRules.cjs");
const {LANGUAGES,resolveEditorialRules}=require("../Code/TranslationEditorialRules.cjs");
function fixture(){
  return {status:"inventory_complete",documentSha256:"A".repeat(64),sourceDocument:"C:/Synthetic/book.indd",records:[
    ...["KDP","Images","Body","Peripheral","Background"].map(name=>({kind:"LAYER",name})),
    ...[["Body Text No Indent","0"],["Body Text Indented","1.5"]].map(([name,firstLineIndent])=>({kind:"STYLE",name,firstLineIndent})),
    {kind:"FORMAT",id:"1",name:"In the text",blocks:"5"},
    ...compileTemplate('(See <paraText />, Pg.^S<pageNum />.)').map((block,index)=>({kind:"BLOCK",formatId:"1",index:String(index),...block})),
    {kind:"FORMAT",id:"2",name:"Credits",blocks:"2"},
    ...compileTemplate('<fullPara delim=":" />:').map((block,index)=>({kind:"BLOCK",formatId:"2",index:String(index),includeDelimiter:"false",...block})),
    {kind:"REFERENCE",id:"10",formatId:"1",paragraphStyle:"Import/Body/Body Text No Indent",text:'(See Heading, Pg. 2.)'},
    {kind:"REFERENCE",id:"11",formatId:"2",paragraphStyle:"Import/Ending/Credits"},
  ]};
}
test("all ten language cross-reference templates retain dynamic blocks",()=>{
  for(const language of LANGUAGES){
    for(const [type,template] of Object.entries(resolveEditorialRules(language,"layout").language.crossReferences)){
      const blocks=compileTemplate(template);
      assert.ok(blocks.length>=2);
      assert.ok(blocks.some(block=>block.type!=='CUSTOM_STRING_BUILDING_BLOCK'));
      if(type!=="credit")assert.ok(blocks.some(block=>block.type==="PAGE_NUMBER_BUILDING_BLOCK"));
    }
  }
  assert.throws(()=>compileTemplate('<unknown />'),/Unsupported/);
});
test("layout plan preserves protected credits and changes only used translated formats",()=>{
  const audit=fixture(),plan=planEditorialLayout(audit,"French",["Credits"]);
  assert.equal(plan.formatEdits.length,1);
  assert.deepEqual(plan.referenceUpdates,[{id:"10",formatId:"1"}]);
  assert.deepEqual(plan.protectedReferenceIds,["11"]);
  for(const row of audit.records.filter(row=>row.kind==="BLOCK" && row.formatId==="1")){
    row.customText=plan.formatEdits[0].blocks[Number(row.index)].customText||"";
  }
  assert.equal(planEditorialLayout(audit,"French",["Credits"]).formatEdits.length,0,"verified plan is idempotent");
  assert.equal(planEditorialLayout(audit,"French",["Credits"]).referenceUpdates.length,1,"saving the format does not prove cached text refreshed");
  audit.records.find(row=>row.kind==='REFERENCE' && row.id==='10').text='(consulter « Titre », p. 2)';
  assert.equal(planEditorialLayout(audit,"French",["Credits"]).referenceUpdates.length,0);
});
test("incomplete, mixed-protection and unknown format inventories fail closed",()=>{
  for(const mutate of [
    audit=>audit.status="partial",
    audit=>audit.records[0].name="Unexpected",
    audit=>audit.records.find(row=>row.kind==="REFERENCE").paragraphStyle="",
    audit=>audit.records.push({kind:"REFERENCE",id:"12",formatId:"1",paragraphStyle:"Credits"}),
    audit=>audit.records.find(row=>row.kind==="FORMAT").name="Unknown",
    audit=>audit.records.find(row=>row.kind==="BLOCK").type="PARAGRAPH_NUMBER_BUILDING_BLOCK",
  ]){
    const audit=fixture();mutate(audit);
    assert.throws(()=>planEditorialLayout(audit,"French",["Credits"]));
  }
});

test("Spanish Ver corrections remain panel-encoded and running headings remain review guidance",()=>{
  const audit=fixture(),plan=planEditorialLayout(audit,"Spanish",["Credits"]);
  assert.equal(plan.applicationMethod,"cross_reference_panel_encoder");
  assert.equal(plan.formatEdits[0].definition,'(Ver <paraText />, pág.^S<pageNum />)');
  assert.deepEqual(plan.protectedReferenceIds,["11"]);
  assert.ok(plan.retainedLayoutRules.some(rule=>rule.id==="es_labels_and_headings"));
  assert.ok(!plan.retainedLayoutRules.some(rule=>rule.id==="es_caption_locations"));
  for(const row of audit.records.filter(row=>row.kind==="BLOCK" && row.formatId==="1")){
    row.customText=plan.formatEdits[0].blocks[Number(row.index)].customText||"";
  }
  const reference=audit.records.find(row=>row.kind==="REFERENCE" && row.id==="10");
  reference.text="(Véase Título, pág.\u00A02)";
  const stale=planEditorialLayout(audit,"Spanish",["Credits"]);
  assert.equal(stale.formatEdits.length,0);
  assert.deepEqual(stale.referenceUpdates,[{id:"10",formatId:"1"}]);
  reference.text="(Ver Título, pág.\u00A02)";
  assert.equal(planEditorialLayout(audit,"Spanish",["Credits"]).referenceUpdates.length,0);
});

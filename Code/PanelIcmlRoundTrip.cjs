"use strict";

// Reconcile a native panel save with its immutable, indexed ICML snapshot.
// No language string is authored here: accepted strings come verbatim from
// Adobe's saved CrossReferenceSource nodes. Ordinary/protected text and all
// original indexing/structure remain in the snapshot representation.
function attribute(tag,name){
  return new RegExp(`\\b${name}="([^"]*)"`,'u').exec(tag)?.[1];
}
function elements(text,name){
  const expression=new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`,'gu');
  return [...text.matchAll(expression)].map(match=>({text:match[0],inner:match[1],index:match.index,opening:match[0].slice(0,match[0].indexOf('>')+1)}));
}
function contentElements(text){
  return [...text.matchAll(/<Content\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Content>)/gu)].map(match=>({text:match[0],inner:match[2]||'',index:match.index,id:attribute(match[0],'id')}));
}
function applyReplacements(text,items){
  let last=text.length;
  for(const item of [...items].sort((a,b)=>b.index-a.index)){
    if(item.index+item.before.length>last || text.slice(item.index,item.index+item.before.length)!==item.before)throw Error('Overlapping or stale panel reconciliation range.');
    text=text.slice(0,item.index)+item.after+text.slice(item.index+item.before.length);last=item.index;
  }
  return text;
}
function outerParagraphs(text){
  const result=[];let depth=0,start=0;
  for(const match of text.matchAll(/<ParagraphStyleRange\b[^>]*>|<\/ParagraphStyleRange>/gu)){
    if(match[0].endsWith('/>'))continue;
    if(match[0].startsWith('</')){if(--depth<0)throw Error('Unbalanced paragraph structure.');if(!depth)result.push(text.slice(start,match.index+match[0].length));}
    else if(depth++===0)start=match.index;
  }
  if(depth)throw Error('Unbalanced paragraph structure.');
  return result;
}
function withoutReferences(text){return text.replace(/<CrossReferenceSource\b[^>]*>[\s\S]*?<\/CrossReferenceSource>/gu,'');}
function contentText(text){return contentElements(text).map(node=>node.inner).join('');}
function count(text,name){return [...text.matchAll(new RegExp(`<${name}(?=[\\s/>])`,'gu'))].length;}
function ordinaryStructure(text){
  // Native saves may remove index IDs and split Content nodes. Those are the
  // only ordinary-content representation changes this helper can reconcile.
  // Preserve style attributes, table boundaries, destinations and metadata.
  return text.replace(/<CrossReferenceFormat\b[^>]*>[\s\S]*?<\/CrossReferenceFormat>/gu,'')
    .replace(/(<CrossReferenceSource\b[^>]*>)[\s\S]*?<\/CrossReferenceSource>/gu,'$1</CrossReferenceSource>')
    .replace(/<(?:ParagraphStyleRange|Content)\b[^>]*>/gu,tag=>tag.replace(/\s+id="[^"]*"/gu,''))
    .replace(/<Content\s*\/>/gu,'<Content></Content>')
    .replace(/<\/Content>\s*<Content>/gu,'')
    .replace(/<Content>([\s\S]*?)<\/Content>/gu,(_,value)=>`<Content>${JSON.stringify(value).replace(/[<>]/gu,c=>c==='<'?'\\u003c':'\\u003e')}</Content>`)
    .replace(/>\s+</gu,'><').trim();
}
function referenceMap(text){
  const nodes=elements(text,'CrossReferenceSource'),map=new Map();
  if(count(text,'CrossReferenceSource')!==nodes.length)throw Error('Unsupported or unbalanced reference structure.');
  for(const node of nodes){const name=attribute(node.opening,'Name');if(!name||map.has(name)||count(node.inner,'CrossReferenceSource'))throw Error('Missing, duplicate or nested reference identity.');map.set(name,node);}
  return map;
}
function restoreNativeSerialization(before,native){
  // Native checkout/check-in renumbers local objects and regenerates previews.
  // Prove the same ordered, bijective identity graph before restoring the indexed
  // representation. Never discard ordinary metadata or authored style changes.
  const xmp=/<x:xmpmeta\b[^>]*>[\s\S]*?<\/x:xmpmeta>/gu;
  const oldMetadata=[...before.matchAll(xmp)],newMetadata=[...native.matchAll(xmp)];
  if(oldMetadata.length!==newMetadata.length||oldMetadata.length>1)throw Error('Native metadata inventory changed.');
  const metadataKey=value=>value.replace(/<xmp:(Thumbnails|PageInfo)\b[^>]*>[\s\S]*?<\/xmp:\1>/gu,'')
    .replace(/<rdf:Description\b[^>]*>/gu,tag=>'<rdf:Description '+[...tag.matchAll(/[\w:]+="[^"]*"/gu)].map(m=>m[0]).sort().join(' ')+'>')
    .replace(/>\s+</gu,'><');
  if(oldMetadata.length){
    if(metadataKey(oldMetadata[0][0])!==metadataKey(newMetadata[0][0]))throw Error('Non-preview metadata changed.');
    native=native.replace(xmp,()=>oldMetadata[0][0]);
  }
  const identities=value=>[...value.matchAll(/<([A-Za-z][\w:]*)\b[^>]*\bSelf="([^"]*)"[^>]*>/gu)];
  const left=identities(before),right=identities(native),mapping=new Map(),reverse=new Map();
  const renumberable=new Set(['Table','Row','Column','Cell','CrossReferenceSource','TextVariableInstance','Hyperlink']);
  if(left.length!==right.length)throw Error('Native object inventory changed.');
  for(let i=0;i<left.length;i++){
    const a=left[i],b=right[i];
    if(a[1]!==b[1])throw Error('Native object order changed.');
    if(a[2]!==b[2]&&(!renumberable.has(a[1])||!/^u[\w]+$/u.test(a[2])||!/^u[\w]+$/u.test(b[2])))throw Error('Non-local object identity changed.');
    if(mapping.has(b[2])||reverse.has(a[2]))throw Error('Duplicate native object identity.');
    mapping.set(b[2],a[2]);reverse.set(a[2],b[2]);
  }
  native=native.replace(/<(?![!?])[^>]*>/gu,tag=>tag.replace(/\b(Self|Source)="([^"]*)"/gu,(full,field,value)=>mapping.has(value)?`${field}="${mapping.get(value)}"`:full));
  const oldRows=[...before.matchAll(/<Row\b[^>]*\/>/gu)];let rowIndex=0;
  native=native.replace(/<Row\b[^>]*\/>/gu,tag=>{
    const prior=oldRows[rowIndex++]?.[0];if(!prior)throw Error('Native table row inventory changed.');
    if(attribute(prior,'Self')!==attribute(tag,'Self')||attribute(prior,'MinimumHeight')!==attribute(tag,'MinimumHeight'))throw Error('Native table row settings changed.');
    const oldHeight=attribute(prior,'SingleRowHeight'),newHeight=attribute(tag,'SingleRowHeight');
    if(oldHeight!==newHeight){
      if(!Number.isFinite(Number(newHeight))||Number(newHeight)<=0||Number(newHeight)<Number(attribute(tag,'MinimumHeight')))throw Error('Invalid native calculated row height.');
      tag=tag.replace(/\bSingleRowHeight="[^"]*"/u,`SingleRowHeight="${oldHeight}"`);
    }
    return tag;
  });
  if(rowIndex!==oldRows.length)throw Error('Native table row inventory changed.');
  // Check-in may add an unindexed empty Content immediately after a table.
  native=native.replace(/(<\/Table>)\s*<Content\s*(?:\/>|><\/Content>)(?=\s*(?:<Br\s*\/>|<\/CharacterStyleRange>))/gu,'$1');
  return native;
}
function reconcilePanelIcml(before,native,allowedReferenceNames=[]){
  for(const value of [before,native])if(typeof value!=='string'||value.length>5*1024*1024||/<!DOCTYPE|<!ENTITY/iu.test(value))throw Error('Unsafe or unbounded ICML input.');
  native=restoreNativeSerialization(before,native);
  if(!Array.isArray(allowedReferenceNames)||allowedReferenceNames.length>25||new Set(allowedReferenceNames).size!==allowedReferenceNames.length)throw Error('Invalid bounded panel reference scope.');
  const allowed=new Set(allowedReferenceNames),left=outerParagraphs(before),right=outerParagraphs(native);
  if(ordinaryStructure(before)!==ordinaryStructure(native))throw Error('Non-reference formatting or structure changed; preserve and review the native file.');
  if(!left.length||left.length!==right.length)throw Error('Paragraph structure changed during the panel session.');
  for(let p=0;p<left.length;p++){
    if(attribute(left[p],'AppliedParagraphStyle')!==attribute(right[p],'AppliedParagraphStyle'))throw Error('Paragraph style changed during the panel session.');
    if(contentText(withoutReferences(left[p]))!==contentText(withoutReferences(right[p])))throw Error(`Non-reference text changed in paragraph ${p}; preserve and review the native file.`);
    for(const tag of ['ParagraphStyleRange','Br','Table','Cell','TextVariableInstance','HyperlinkTextDestination'])if(count(left[p],tag)!==count(right[p],tag))throw Error(`Structural ${tag} changed in paragraph ${p}.`);
  }
  const oldReferences=referenceMap(before),newReferences=referenceMap(native);
  if(oldReferences.size!==newReferences.size||[...oldReferences.keys()].some(name=>!newReferences.has(name)))throw Error('Reference identity set changed.');
  if([...allowed].some(name=>!oldReferences.has(name)))throw Error('Requested panel reference was not found.');
  const replacements=[],contentUpdates=[],formats=new Set();let protectedCachesRestored=0;
  for(const [name,oldNode] of oldReferences){
    const newNode=newReferences.get(name);
    if(!allowed.has(name)){if(contentText(oldNode.inner)!==contentText(newNode.inner))protectedCachesRestored++;continue;}
    const format=attribute(oldNode.opening,'AppliedFormat');
    if(!format||format!==attribute(newNode.opening,'AppliedFormat'))throw Error('Reference format identity changed.');
    const oldContents=contentElements(oldNode.inner),newContents=contentElements(newNode.inner);
    if(!oldContents.length||oldContents.length!==newContents.length)throw Error('Panel-generated segment shape changed.');
    let replacement=oldNode.text;const local=[];
    const innerStart=oldNode.opening.length;
    for(let i=0;i<oldContents.length;i++){
      const a=oldContents[i],b=newContents[i];if(!a.id)throw Error('Recovery snapshot lacks a Content ID.');
      if(/<(?!!--|\?)/u.test(b.inner))throw Error('Unexpected markup inside panel-generated text.');
      const after=a.text.replace(/^(<Content\b[^>]*>)[\s\S]*(<\/Content>)$/u,(_,open,close)=>open+b.inner+close);
      if(a.text.endsWith('/>')&&b.inner)throw Error('An empty panel segment gained content.');
      local.push({index:innerStart+a.index,before:a.text,after});
      if(a.inner!==b.inner)contentUpdates.push({id:a.id,before:a.inner,after:b.inner,referenceName:name});
    }
    const variablePattern=/<TextVariableInstance\b[^>]*\/>/gu;
    const oldVariables=[...oldNode.text.matchAll(variablePattern)],newVariables=[...newNode.text.matchAll(variablePattern)];
    if(oldVariables.length!==1||newVariables.length!==1)throw Error('Expected exactly one native page-number variable.');
    const value=attribute(newVariables[0][0],'ResultText');
    if(!/^[0-9A-Za-z–-]+$/u.test(value||''))throw Error('Unresolved native page-number result.');
    local.push({index:oldVariables[0].index,before:oldVariables[0][0],after:oldVariables[0][0].replace(/\bResultText="[^"]*"/u,`ResultText="${value}"`)});
    replacement=applyReplacements(replacement,local);
    replacements.push({index:oldNode.index,before:oldNode.text,after:replacement});formats.add(format);
  }
  for(const format of formats){
    const old=elements(before,'CrossReferenceFormat').filter(n=>attribute(n.opening,'Self')===format);
    const current=elements(native,'CrossReferenceFormat').filter(n=>attribute(n.opening,'Self')===format);
    if(old.length!==1||current.length!==1||attribute(old[0].opening,'Name')!==attribute(current[0].opening,'Name'))throw Error('Panel format inventory is incomplete.');
    if(count(old[0].text,'BuildingBlock')!==count(current[0].text,'BuildingBlock'))throw Error('Panel format dynamic structure changed.');
    if(old[0].text!==current[0].text && [...oldReferences].some(([name,node])=>!allowed.has(name)&&attribute(node.opening,'AppliedFormat')===format))throw Error('Changed panel format is shared with an unselected reference.');
    replacements.push({index:old[0].index,before:old[0].text,after:current[0].text});
  }
  const text=applyReplacements(before,replacements);
  if(JSON.stringify(contentElements(text).map(n=>n.id))!==JSON.stringify(contentElements(before).map(n=>n.id)))throw Error('Content IDs changed during reconciliation.');
  if(contentText(withoutReferences(text))!==contentText(withoutReferences(before)))throw Error('Reconciliation changed ordinary text.');
  return {text,contentUpdates,acceptedReferences:allowed.size,protectedCachesRestored,restoredContentIds:contentElements(before).length};
}
module.exports={reconcilePanelIcml};

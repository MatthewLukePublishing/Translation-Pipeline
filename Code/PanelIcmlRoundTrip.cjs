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
function referenceMap(text){
  const nodes=elements(text,'CrossReferenceSource'),map=new Map();
  if(count(text,'CrossReferenceSource')!==nodes.length)throw Error('Unsupported or unbalanced reference structure.');
  for(const node of nodes){const name=attribute(node.opening,'Name');if(!name||map.has(name)||count(node.inner,'CrossReferenceSource'))throw Error('Missing, duplicate or nested reference identity.');map.set(name,node);}
  return map;
}
function reconcilePanelIcml(before,native,allowedReferenceNames=[]){
  for(const value of [before,native])if(typeof value!=='string'||value.length>5*1024*1024||/<!DOCTYPE|<!ENTITY/iu.test(value))throw Error('Unsafe or unbounded ICML input.');
  if(!Array.isArray(allowedReferenceNames)||allowedReferenceNames.length>25||new Set(allowedReferenceNames).size!==allowedReferenceNames.length)throw Error('Invalid bounded panel reference scope.');
  const allowed=new Set(allowedReferenceNames),left=outerParagraphs(before),right=outerParagraphs(native);
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
    replacements.push({index:old[0].index,before:old[0].text,after:current[0].text});
  }
  const text=applyReplacements(before,replacements);
  if(JSON.stringify(contentElements(text).map(n=>n.id))!==JSON.stringify(contentElements(before).map(n=>n.id)))throw Error('Content IDs changed during reconciliation.');
  if(contentText(withoutReferences(text))!==contentText(withoutReferences(before)))throw Error('Reconciliation changed ordinary text.');
  return {text,contentUpdates,acceptedReferences:allowed.size,protectedCachesRestored,restoredContentIds:contentElements(before).length};
}
module.exports={reconcilePanelIcml};

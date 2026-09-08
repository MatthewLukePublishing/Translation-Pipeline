"use strict";
const crypto=require("node:crypto");
const {LANGUAGES}=require("./TranslationEditorialRules.cjs");
const H=String.raw`[ \x{00A0}\x{2009}\x{202F}]+`;
const common=[
  {id:"fr_punctuation",language:"French",source:"Sheet1!D35/G35, line 1",find:String.raw`[ \t\x{00A0}\x{2009}]+(?=[;:!?%])`,change:"\u202f"},
  {id:"fr_em_dash",language:"French",source:"Sheet1!D35/G35, line 2",find:String.raw`(\S)[ \t\x{00A0}\x{2009}\x{202F}]*—[ \t\x{00A0}\x{2009}\x{202F}]*`,change:"$1 —\u202f"},
  {id:"fr_open_quote",language:"French",source:"Sheet1!D35/G35, line 3",find:String.raw`(?<=«)[ \t\x{00A0}\x{2009}]+`,change:"\u202f"},
  {id:"fr_close_quote",language:"French",source:"Sheet1!D35/G35, line 4",find:String.raw`[ \t\x{00A0}\x{2009}]+(?=»)`,change:"\u202f"},
  {id:"unit_nbsp",language:"All",source:"Sheet1!D36/G36",find:String.raw`(?<=\d) (mm|cm|m|km|mg|g|kg|in|ft|yd|mi|s|min|MOA|mil)(?=[\s[:punct:]]|$)`,change:"~S$1"},
  {id:"math_before",language:"All",source:"Sheet1!D37/G37",find:String.raw`(?<=\d) (\+|−|×|÷|=|≠|≈|<|>|≤|≥|±|½|⅓|⅔|¼|¾|⅕|⅖|⅗|⅘|⅙|⅚|⁄)(?=[ [:punct:]]|$)`,change:"~S$1",adaptation:"Escaped the literal plus sign; a bare + cannot compile."},
  {id:"math_after",language:"All",source:"Sheet1!E15:F30: NBSP before and after math symbols",find:String.raw`(?<=[+−×÷=≠≈<>≤≥±]) (?=[+−-]?\d)`,change:"~S",adaptation:"Completes the table's explicit before-and-after spacing rule."},
];
const monthPatterns={
  English:"Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec",
  German:"Jan|Feb|Mär|Apr|Mai|Jun|Jul|Aug|Sep|Okt|Nov|Dez",
  French:"janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre",
  Spanish:"enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre",
  Portuguese:"janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro",
  Dutch:"jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec",
  Italian:"gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic",
  Turkish:"Oca|Şub|Mar|Nis|May|Haz|Tem|Ağu|Eyl|Eki|Kas|Ara",
  Polish:"sty|lut|mar|kwi|maj|cze|lip|sie|wrz|paź|lis|gru",
  Swedish:"jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec",
};
const dateOrder=["English","German","French","Spanish","Portuguese","Dutch","Italian","Turkish","Polish","Swedish"];
const rules=[...common,...dateOrder.map((language,index)=>{
  const de=["Spanish","Portuguese"].includes(language);
  return {id:`date_${language.toLowerCase()}`,language,source:`Sheet1!D38/G38, line ${index+1}`,
    find:`\\b(\\d{1,2}${language==="French"?"(?:er)?":""})${H}${de?`de${H}`:""}(${monthPatterns[language]})${H}${de?`de${H}`:""}(\\d{4})\\b`,
    change:de?"$1~Sde~S$2~Sde~S$3":"$1~S$2~S$3",
    adaptation:"Horizontal whitespace prevents joins across paragraphs/tabs. Native month names prevent nondate matches. French accepts 1er."};
})];
// InDesign cannot see lookaround context when changeGrep is invoked on a
// matched Text range. Search with the complete formula, then replace only the
// verified match using this capture-equivalent, context-free expression.
for(const rule of rules){
  rule.scopedFind=rule.find
    .replace(/^\(\?<=\\d\)/u,"")
    .replace(/\(\?=\[\\s\[:punct:\]\]\|\$\)$/u,"")
    .replace(/\(\?=\[ \[:punct:\]\]\|\$\)$/u,"");
  if(rule.id==="fr_punctuation")rule.scopedFind=String.raw`[ \t\x{00A0}\x{2009}]+`;
  if(rule.id==="fr_open_quote" || rule.id==="fr_close_quote")rule.scopedFind=String.raw`[ \t\x{00A0}\x{2009}]+`;
  if(rule.id==="math_after")rule.scopedFind=" ";
}
function resolveGrepRules(language){
  const selected=LANGUAGES.find(name=>name.toLowerCase()===String(language).trim().toLowerCase());
  if(!selected)throw Error(`Unknown GREP language: ${language}`);
  const payload={schemaVersion:1,version:"1.0.0",rules};
  return {...payload,sha256:crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex").toUpperCase(),language:selected,
    applicable:rules.filter(rule=>["All",selected].includes(rule.language)),
    notApplicable:rules.filter(rule=>!["All",selected].includes(rule.language)).map(rule=>({id:rule.id,reason:`Language-specific to ${rule.language}`}))};
}
// ICU-to-JavaScript subset used only by offline tests and match previews.
// Production execution must use InDesign's GREP engine, never claim this as that run.
function previewExpression(rule){
  return new RegExp(rule.find.replace(/\\x\{([A-Fa-f0-9]+)\}/gu,"\\u{$1}").replace(/\[:punct:\]/gu,"\\p{P}"),"gu");
}
function previewReplacement(rule){return rule.change.replace(/~S/gu,"\u00a0");}
function replacementForMatch(rule,text){
  const expression=previewExpression({...rule,find:rule.scopedFind});
  const matches=[...text.matchAll(expression)];
  if(matches.length!==1 || matches[0].index!==0 || matches[0][0]!==text)throw Error(`Scoped GREP match differs: ${rule.id}`);
  return text.replace(expression,previewReplacement(rule));
}
module.exports={rules,resolveGrepRules,previewExpression,previewReplacement,replacementForMatch};

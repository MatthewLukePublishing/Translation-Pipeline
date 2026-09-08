#target "InDesign"
(function(){
  var action=__ACTION_JS__,documentPath=__DOCUMENT_JS__,settings=__SETTINGS_JS__;
  var fp=app.findGrepPreferences.properties,cp=app.changeGrepPreferences.properties,op=app.findChangeGrepOptions.properties,ui=app.scriptPreferences.userInteractionLevel;
  function enc(value){return encodeURIComponent(String(value));}
  function key(value){return String(value).replace(/\\/g,"/").toLowerCase();}
  function type(object){return String(object.reflect.name);}
  function context(text){var parent=text.characters[0].parent;return type(parent)==="Cell"?"Cell:"+parent.parent.id+":"+parent.id:type(parent)+":"+parent.id;}
  function textContents(text){
    var value=text.contents;
    if(typeof value==="string")return value;
    // Single-character GREP matches can be Character enumerators rather than
    // strings. Never serialize their symbolic names as manuscript text.
    if(value===SpecialCharacters.NONBREAKING_SPACE)return "\u00a0";
    if(value===SpecialCharacters.FIXED_WIDTH_NONBREAKING_SPACE)return "\u202f";
    if(value===SpecialCharacters.THIN_SPACE)return "\u2009";
    throw Error("Unsupported GREP character enumerator: "+String(value));
  }
  function span(text){return {context:context(text),start:text.characters[0].index,end:text.characters[-1].index+1};}
  function bound(length,maximum,label){if(length>maximum)throw Error(label+" exceeds limit: "+length);return length;}
  function stylePath(style){var parts=[String(style.name)],parent=style.parent,guard=0;while(parent && type(parent)==="ParagraphStyleGroup"){if(++guard>20)throw Error("Style nesting exceeds limit");parts.unshift(String(parent.name));parent=parent.parent;}return parts.join("/");}
  function protectedMatch(match,refs,protectedStyles){
    if(match.paragraphs.length!==1)throw Error("GREP match crosses paragraphs.");
    var style=stylePath(match.paragraphs[0].appliedParagraphStyle);
    for(var p=0;p<protectedStyles.length;p++)if(style===protectedStyles[p] || style.split("/").pop()===protectedStyles[p])return "protected_source";
    var range=span(match);
    for(var r=0;r<refs.length;r++)if(range.context===refs[r].context && range.start<refs[r].end && range.end>refs[r].start)return "panel_cross_reference";
    return "";
  }
  try{
    app.scriptPreferences.userInteractionLevel=UserInteractionLevels.NEVER_INTERACT;
    if(app.backgroundTasks.length || app.documents.length!==1)throw Error("Expected one idle isolated document.");
    var doc=app.documents[0];
    if(key(doc.fullName.fsName)!==key(new File(documentPath).fsName))throw Error("Unexpected GREP document.");
    if(doc.modified)throw Error("Unsaved changes were preserved; each GREP call requires a saved document.");
    if(settings.length<1 || settings.length>5)throw Error("One to five explicit GREP story scopes required.");
    app.findGrepPreferences=NothingEnum.NOTHING;app.changeGrepPreferences=NothingEnum.NOTHING;
    app.findChangeGrepOptions.properties={includeFootnotes:true,includeHiddenLayers:true,includeLockedLayersForFind:true,includeLockedStoriesForFind:true,includeMasterPages:true};
    var rows=[];
    for(var scopeIndex=0;scopeIndex<settings.length;scopeIndex++){
      var scope=settings[scopeIndex],story=doc.stories.itemByID(Number(scope.storyId));
      if(!story || !story.isValid)throw Error("GREP story missing.");
      if(action==="apply" && story.itemLink && story.itemLink.isValid)throw Error("Linked ICML corrections must be made in the translation workbook and reimported. Native checkout/save discards pipeline Content IDs; no edits made.");
      bound(story.characters.length,60000,"Story characters");
      if(story.footnotes.length || story.endnotes.length)throw Error("Footnote/endnote stories need an explicit separately bounded GREP scope.");
      var refs=[],referenceIds=scope.referenceIds || [];
      bound(referenceIds.length,500,"Story references");
      for(var ri=0;ri<referenceIds.length;ri++){
        var reference=doc.crossReferenceSources.itemByID(Number(referenceIds[ri]));
        if(!reference.isValid || reference.sourceText.parentStory.id!==story.id)throw Error("GREP reference inventory changed.");
        refs.push(span(reference.sourceText));
      }
      bound(scope.rules.length,20,"GREP rules");
      if(action==="apply" && (settings.length!==1 || scope.rules.length!==1))throw Error("Apply one rule to one story per call.");
      for(var ruleIndex=0;ruleIndex<scope.rules.length;ruleIndex++){
        var rule=scope.rules[ruleIndex];
        app.findGrepPreferences=NothingEnum.NOTHING;app.changeGrepPreferences=NothingEnum.NOTHING;
        app.findGrepPreferences.findWhat=rule.find;app.changeGrepPreferences.changeTo=rule.change;
        var matches=story.findGrep(true),eligible=[];
        bound(matches.length,250,"GREP matches per story/rule");
        rows.push("GREP_RUN|storyId="+story.id+"|ruleId="+enc(rule.id)+"|matches="+matches.length);
        for(var m=0;m<matches.length;m++){
          var match=matches[m],before=textContents(match),reason=protectedMatch(match,refs,scope.protectedStyles || []);
          if(!reason && /[\t\r\n]/.test(before))throw Error("GREP would change a structural tab or paragraph break; explicit review required.");
          rows.push("GREP_MATCH|storyId="+story.id+"|ruleId="+enc(rule.id)+"|text="+enc(before)+"|reason="+enc(reason)+"|context="+enc(context(match))+"|start="+match.characters[0].index);
          if(!reason)eligible.push({match:match,before:before});
        }
        if(action==="apply"){
          // The controller supplies every eligible match, including no-ops, from
          // the preceding saved-document audit. Changes from another rule may
          // shift offsets, but may not invent or remove matching text unnoticed.
          var expected=scope.expected,actual=[];
          for(m=0;m<eligible.length;m++)actual.push(eligible[m].before);
          var sortedActual=actual.slice().sort(),sortedExpected=[];
          for(m=0;m<expected.length;m++)sortedExpected.push(String(expected[m].before));
          sortedExpected.sort();
          if(sortedActual.join("\u001f")!==sortedExpected.join("\u001f"))throw Error("GREP matches changed after audit; no edits made by this call.");
          for(m=0;m<eligible.length;m++){
            var item=eligible[m],after=null;
            for(var e=0;e<expected.length;e++)if(expected[e].before===item.before){after=expected[e].after;break;}
            if(after===null)throw Error("Missing audited GREP replacement.");
            if(after===item.before)continue;
            app.findGrepPreferences.findWhat=rule.scopedFind;
            var scoped=item.match.findGrep();
            if(scoped.length!==1 || textContents(scoped[0])!==item.before)throw Error("Scoped GREP replacement does not match the audited text.");
            var changed=item.match.changeGrep();
            if(changed.length!==1 || textContents(changed[0])!==after)throw Error("Native GREP replacement differs from the reviewed result; unsaved changes retained.");
            rows.push("GREP_CHANGED|storyId="+story.id+"|ruleId="+enc(rule.id)+"|before="+enc(item.before)+"|after="+enc(after));
          }
        }else if(action!=="audit")throw Error("Unsupported GREP action.");
      }
    }
    return rows.join("\n");
  }catch(error){return "ERROR|"+String(error).replace(/[\r\n]+/g," ");}
  finally{
    app.findGrepPreferences=NothingEnum.NOTHING;app.changeGrepPreferences=NothingEnum.NOTHING;
    app.findGrepPreferences.properties=fp;app.changeGrepPreferences.properties=cp;app.findChangeGrepOptions.properties=op;app.scriptPreferences.userInteractionLevel=ui;
  }
}());

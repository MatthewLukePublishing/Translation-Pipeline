[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$DocumentPath,
    [Parameter(Mandatory)] [string]$ReportPath,
    [string]$ProductsRoot,
    [ValidateRange(10, 100)] [int]$StoryBatchSize = 50
)

$ErrorActionPreference = 'Stop'
$javaScriptLanguage = 1246973031
$commonAutomationPath = Join-Path $PSScriptRoot 'InDesignAutomationCommon.ps1'
$pathSafetyPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'TranslationPathSafety.ps1'
if (-not (Test-Path -LiteralPath $commonAutomationPath -PathType Leaf)) { throw "Missing InDesign automation utility: $commonAutomationPath" }
. $commonAutomationPath
if (-not (Test-Path -LiteralPath $pathSafetyPath -PathType Leaf)) { throw "Missing path-safety utility: $pathSafetyPath" }
. $pathSafetyPath
$programRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$productsRoot = Resolve-TranslationProductsRoot -ExplicitPath $ProductsRoot -ProgramRoot $programRoot

$resolvedDocument = (Resolve-Path -LiteralPath $DocumentPath).Path
if ([IO.Path]::GetExtension($resolvedDocument) -ne '.indd') { throw "Expected an INDD document: $resolvedDocument" }
if ($resolvedDocument -match '(?i)(?:^|[\\/])_?Archive(?:[\\/]|$)') { throw "Archive document paths are forbidden: $resolvedDocument" }
$null = Assert-PathWithin -Path $resolvedDocument -Parent $productsRoot -Label 'InDesign document'
$resolvedReport = [IO.Path]::GetFullPath($ReportPath)
[IO.Directory]::CreateDirectory((Split-Path -Parent $resolvedReport)) | Out-Null

$mutex = [Threading.Mutex]::new($false, 'Global\PublishingStep2InDesignTranslation')
$hasMutex = $false
$app = $null
$startedInDesign = @((Get-Process -Name InDesign -ErrorAction SilentlyContinue)).Count -eq 0
$opened = $false
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw 'Another Step 2 InDesign operation is already running.' }
    $app = Get-InDesignApplication
    $openDocuments = [string]$app.DoScript(@'
(function(){
  var rows=[];
  for(var i=0;i<app.documents.length;i++){
    var d=app.documents[i],p="";
    try{p=d.saved?d.fullName.fsName:"(unsaved)";}catch(_){p="(unavailable)";}
    rows.push(d.name+"|modified="+d.modified+"|path="+p);
  }
  return rows.join("\n");
}());
'@, $javaScriptLanguage)
    if ($openDocuments) {
        throw "InDesign has open documents. Close them before the bounded audit:`n$openDocuments"
    }

    $documentLiteral = ConvertTo-JavaScriptStringLiteral $resolvedDocument
    $openScript = @"
(function(){
  function key(v){return String(v||'').replace(/\\\\/g,'/').toLowerCase();}
  if(app.documents.length!==0) throw new Error('InDesign must have no open documents before the audit.');
  var f=new File($documentLiteral);
  if(!f.exists) throw new Error('Missing document: '+f.fsName);
  var d=app.open(f,false);
  if(key(d.fullName.fsName)!==key(f.fsName)) throw new Error('InDesign opened an unexpected document.');
  return 'OPENED|path='+encodeURIComponent(d.fullName.fsName);
}());
"@
    [void]$app.DoScript($openScript, $javaScriptLanguage)
    $opened = $true

    $summaryScript = @'
(function(){
  function enc(v){try{return encodeURIComponent(String(v===undefined||v===null?'':v));}catch(_){return '';}}
  function reflectName(v){try{return String(v.reflect.name);}catch(_){return '';}}
  function stylePath(style){
    var parts=[String(style.name)], parent=style.parent, guard=0;
    while(parent && guard<20){
      var type=reflectName(parent);
      if(type!=='ParagraphStyleGroup') break;
      parts.unshift(String(parent.name)); parent=parent.parent; guard++;
    }
    return parts.join('/');
  }
  function value(v){
    try{
      if(v && v.name!==undefined && (reflectName(v)==='NothingEnum')) return String(v.name);
      return String(v);
    }catch(_){return '';}
  }
  if(app.documents.length!==1) throw new Error('Expected exactly one open document.');
  var d=app.documents[0], rows=[];
  var width='',height='';
  try{width=value(d.documentPreferences.pageWidth);}catch(_){}
  try{height=value(d.documentPreferences.pageHeight);}catch(_){}
  rows.push('SUMMARY|name='+enc(d.name)+'|path='+enc(d.fullName.fsName)+'|modified='+enc(d.modified)+'|pages='+enc(d.pages.length)+'|stories='+enc(d.stories.length)+'|links='+enc(d.links.length)+'|paragraphStyles='+enc(d.allParagraphStyles.length)+'|pageWidth='+enc(width)+'|pageHeight='+enc(height));
  var styles=d.allParagraphStyles;
  for(var i=0;i<styles.length;i++){
    var s=styles[i], basedOn='', language='', pointSize='', leading='', fontStyle='';
    try{basedOn=(s.basedOn&&s.basedOn.isValid)?stylePath(s.basedOn):'';}catch(_){}
    try{language=(s.appliedLanguage&&s.appliedLanguage.isValid)?s.appliedLanguage.name:'';}catch(_){}
    try{pointSize=value(s.pointSize);}catch(_){}
    try{leading=value(s.leading);}catch(_){}
    try{fontStyle=value(s.fontStyle);}catch(_){}
    rows.push('STYLE|id='+enc(s.id)+'|name='+enc(s.name)+'|path='+enc(stylePath(s))+'|basedOn='+enc(basedOn)+'|pointSize='+enc(pointSize)+'|leading='+enc(leading)+'|language='+enc(language)+'|fontStyle='+enc(fontStyle));
  }
  var missing=0,outdated=0,embedded=0;
  for(var j=0;j<d.links.length;j++){
    try{
      var link=d.links[j], status=value(link.status), problem=false, filePath='';
      if(link.status===LinkStatus.LINK_MISSING){missing++;problem=true;}
      else if(link.status===LinkStatus.LINK_OUT_OF_DATE){outdated++;problem=true;}
      else if(link.status===LinkStatus.LINK_EMBEDDED) embedded++;
      try{filePath=link.filePath;}catch(_){}
      if(problem) rows.push('LINK|index='+enc(j)+'|name='+enc(link.name)+'|path='+enc(filePath)+'|status='+enc(status));
    }catch(_){}
  }
  rows.push('LINKS|missing='+enc(missing)+'|outdated='+enc(outdated)+'|embedded='+enc(embedded)+'|total='+enc(d.links.length));
  return rows.join('\n');
}());
'@
    $summaryRows = @(ConvertFrom-KeyValueText ([string]$app.DoScript($summaryScript, $javaScriptLanguage)))
    $summary = @($summaryRows | Where-Object kind -eq 'SUMMARY')[0]
    $styles = @($summaryRows | Where-Object kind -eq 'STYLE')
    $links = @($summaryRows | Where-Object kind -eq 'LINKS')[0]
    $problemLinks = @($summaryRows | Where-Object kind -eq 'LINK')
    $storyCount = [int]$summary.stories

    $stories = [Collections.Generic.List[object]]::new()
    for ($start = 0; $start -lt $storyCount; $start += $StoryBatchSize) {
        $storyScript = @"
(function(){
  function enc(v){try{return encodeURIComponent(String(v===undefined||v===null?'':v));}catch(_){return '';}}
  function reflectName(v){try{return String(v.reflect.name);}catch(_){return '';}}
  function stylePath(style){
    var parts=[String(style.name)], parent=style.parent, guard=0;
    while(parent && guard<20){
      if(reflectName(parent)!=='ParagraphStyleGroup') break;
      parts.unshift(String(parent.name)); parent=parent.parent; guard++;
    }
    return parts.join('/');
  }
  if(app.documents.length!==1) throw new Error('Expected exactly one open document.');
  var d=app.documents[0], rows=[], start=$start, finish=Math.min(d.stories.length,start+$StoryBatchSize);
  for(var i=start;i<finish;i++){
    var s=d.stories[i], over=false, linkName='', linkPath='', pages=[], styleNames=[];
    try{over=Boolean(s.overflows);}catch(_){}
    try{if(s.itemLink&&s.itemLink.isValid){linkName=s.itemLink.name;linkPath=s.itemLink.filePath;}}catch(_){}
    if(over){
      try{
        for(var t=0;t<s.textContainers.length&&t<50;t++){
          var page=s.textContainers[t].parentPage;
          if(page&&page.isValid&&pages.indexOf(String(page.name))<0) pages.push(String(page.name));
        }
      }catch(_){}
      try{
        for(var p=0;p<s.paragraphs.length;p++){
          var styleName=stylePath(s.paragraphs[p].appliedParagraphStyle);
          if(styleNames.indexOf(styleName)<0) styleNames.push(styleName);
        }
      }catch(_){}
    }
    rows.push('STORY|index='+enc(i)+'|id='+enc(s.id)+'|overflows='+enc(over)+'|linkName='+enc(linkName)+'|linkPath='+enc(linkPath)+'|pages='+enc(pages.join(','))+'|styles='+enc(styleNames.join(';')));
  }
  return rows.join('\n');
}());
"@
        foreach ($record in @(ConvertFrom-KeyValueText ([string]$app.DoScript($storyScript, $javaScriptLanguage)))) {
            $stories.Add($record)
        }
        Write-Output "AUDIT_PROGRESS|document=$resolvedDocument|stories=$([Math]::Min($start + $StoryBatchSize, $storyCount))/$storyCount"
    }

    $closeResult = [string]$app.DoScript("(function(){if(app.documents.length!==1) throw new Error('Expected one document to close.');app.documents[0].close(SaveOptions.NO);return 'CLOSED';}());", $javaScriptLanguage)
    if ($closeResult -ne 'CLOSED') { throw "Unexpected close result: $closeResult" }
    $opened = $false

    $report = [ordered]@{
        schemaVersion = 1
        generatedAt = [DateTime]::UtcNow.ToString('o')
        auditMode = 'read_only_bounded'
        sourceDocument = $resolvedDocument
        summary = $summary
        linkStatus = $links
        problemLinks = $problemLinks
        paragraphStyles = $styles
        stories = $stories
        overflow = [ordered]@{
            storyCount = @($stories | Where-Object { $_.overflows -eq 'true' }).Count
            stories = @($stories | Where-Object { $_.overflows -eq 'true' })
        }
    }
    $json = $report | ConvertTo-Json -Depth 20
    Write-Utf8TextAtomic -Path $resolvedReport -Text $json
    Write-Output "AUDIT_COMPLETE|document=$resolvedDocument|styles=$($styles.Count)|stories=$storyCount|overflowStories=$($report.overflow.storyCount)|report=$resolvedReport"
} finally {
    if ($opened -and $null -ne $app) {
        try { [void]$app.DoScript("(function(){while(app.documents.length){app.documents[0].close(SaveOptions.NO);}return 'CLOSED';}());", $javaScriptLanguage) } catch {
            # Preserve the primary audit result when best-effort cleanup fails.
            [void]$_.Exception
        }
    }
    if ($null -ne $app -and $startedInDesign) {
        try {
            $openCount = [int]$app.DoScript('app.documents.length', $javaScriptLanguage)
            if ($openCount -eq 0) { [void]$app.DoScript('app.quit(SaveOptions.NO)', $javaScriptLanguage) }
        } catch {
            # Preserve the primary audit result when best-effort shutdown fails.
            [void]$_.Exception
        }
    }
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

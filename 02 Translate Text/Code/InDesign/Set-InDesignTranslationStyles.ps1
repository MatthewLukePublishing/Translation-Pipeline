[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$DocumentPath,
    [Parameter(Mandatory)] [string]$TargetLanguage,
    [Parameter(Mandatory)] [string]$SettingsPath,
    [Parameter(Mandatory)] [string]$ReportPath,
    [string]$ProductsRoot
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
$resolvedSettings = (Resolve-Path -LiteralPath $SettingsPath).Path
$resolvedReport = [IO.Path]::GetFullPath($ReportPath)
if ([IO.Path]::GetExtension($resolvedDocument) -ne '.indd') { throw "Expected an INDD document: $resolvedDocument" }
if ($resolvedDocument -match '(?i)(?:^|[\\/])_?Archive(?:[\\/]|$)') { throw "Archive document paths are forbidden: $resolvedDocument" }
$null = Assert-PathWithin -Path $resolvedDocument -Parent $productsRoot -Label 'InDesign document'
$settings = Get-Content -LiteralPath $resolvedSettings -Raw | ConvertFrom-Json
if ([int]$settings.schemaVersion -ne 1 -or -not $settings.paragraphStyles) { throw 'Invalid translation layout settings JSON.' }
if ($settings.targetLanguage -and -not ([string]$settings.targetLanguage).Equals($TargetLanguage, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Settings target language '$($settings.targetLanguage)' does not match '$TargetLanguage'."
}
[IO.Directory]::CreateDirectory((Split-Path -Parent $resolvedReport)) | Out-Null

$mutex = [Threading.Mutex]::new($false, 'Global\PublishingStep2InDesignTranslation')
$hasMutex = $false
$app = $null
$startedInDesign = @((Get-Process -Name InDesign -ErrorAction SilentlyContinue)).Count -eq 0
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
    if ($openDocuments) { throw "InDesign has open documents. Close them before the style update:`n$openDocuments" }

    $documentLiteral = ConvertTo-JavaScriptStringLiteral $resolvedDocument
    $languageLiteral = ConvertTo-JavaScriptStringLiteral $TargetLanguage
    $settingsExpression = $settings.paragraphStyles | ConvertTo-Json -Depth 10 -Compress
    $scriptText = @"
(function(){
  try{
  var documentPath=$documentLiteral, targetLanguageName=$languageLiteral;
  var requested=$settingsExpression;
  function key(v){return String(v||'').replace(/\\\\/g,'/').toLowerCase();}
  function enc(v){try{return encodeURIComponent(String(v===undefined||v===null?'':v));}catch(_){return '';}}
  function reflectName(v){try{return String(v.reflect.name);}catch(_){return '';}}
  function stylePath(style){
    var parts=[String(style.name)], parent=style.parent, guard=0;
    while(parent&&guard<20){
      if(reflectName(parent)!=='ParagraphStyleGroup') break;
      parts.unshift(String(parent.name)); parent=parent.parent; guard++;
    }
    return parts.join('/');
  }
  function value(v){try{return String(v);}catch(_){return '';}}
  if(app.documents.length!==0) throw new Error('InDesign must have no open documents before the style update.');
  var file=new File(documentPath);
  if(!file.exists) throw new Error('Missing InDesign document: '+file.fsName);
  var doc=app.open(file,false), saved=false;
  try{
    if(key(doc.fullName.fsName)!==key(file.fsName)) throw new Error('InDesign opened an unexpected document.');
    if(doc.modified) throw new Error('Document opened with pre-existing unsaved changes.');
    var language=null;
    for(var l=0;l<app.languagesWithVendors.length;l++){
      if(String(app.languagesWithVendors[l].name).toLowerCase()===String(targetLanguageName).toLowerCase()){
        language=app.languagesWithVendors[l]; break;
      }
    }
    if(!language) throw new Error('InDesign language is not installed: '+targetLanguageName);
    var styles=doc.allParagraphStyles, byPath={}, rows=[], languageChanges=0;
    for(var i=0;i<styles.length;i++) byPath[stylePath(styles[i])]=styles[i];
    for(var s=0;s<styles.length;s++){
      var currentPath=stylePath(styles[s]);
      if(/^\[.*\]$/.test(currentPath)) continue;
      var oldLanguage='';
      try{oldLanguage=styles[s].appliedLanguage.name;}catch(_){}
      if(oldLanguage!==language.name){
        styles[s].appliedLanguage=language; languageChanges++;
        rows.push('LANGUAGE|path='+enc(currentPath)+'|before='+enc(oldLanguage)+'|after='+enc(language.name));
      }
    }
    for(var r=0;r<requested.length;r++){
      var request=requested[r], requestedPath=String(request.path||'');
      var style=byPath[requestedPath];
      if(!style||!style.isValid) throw new Error('Paragraph style not found: '+requestedPath);
      var beforeSize=value(style.pointSize), beforeLeading=value(style.leading);
      if(request.pointSize!==undefined&&request.pointSize!==null) style.pointSize=Number(request.pointSize);
      if(request.leading!==undefined&&request.leading!==null) style.leading=Number(request.leading);
      rows.push('STYLE|path='+enc(requestedPath)+'|beforePointSize='+enc(beforeSize)+'|afterPointSize='+enc(value(style.pointSize))+'|beforeLeading='+enc(beforeLeading)+'|afterLeading='+enc(value(style.leading))+'|basis='+enc(request.basis||''));
    }
    doc.recompose();
    doc.save(); saved=true;
    if(doc.modified) throw new Error('Document remained modified after save.');
    rows.unshift('SUMMARY|document='+enc(doc.fullName.fsName)+'|language='+enc(language.name)+'|languageChanges='+enc(languageChanges)+'|styleSettings='+enc(requested.length));
    doc.close(SaveOptions.NO); doc=null;
    return rows.join('\n');
  }catch(error){
    try{if(doc&&doc.isValid) doc.close(saved?SaveOptions.NO:SaveOptions.NO);}catch(_){}
    throw error;
  }
  }catch(outerError){return 'ERROR|'+String(outerError).replace(/[\r\n]+/g,' ');}
}());
"@
    $rawResult = [string]$app.DoScript($scriptText, $javaScriptLanguage)
    if ($rawResult -like 'ERROR|*') { throw $rawResult }
    $records = @(ConvertFrom-KeyValueText -Text $rawResult)
    $report = [ordered]@{
        schemaVersion = 1
        completedAt = [DateTime]::UtcNow.ToString('o')
        documentPath = $resolvedDocument
        targetLanguage = $TargetLanguage
        settingsPath = $resolvedSettings
        source = $settings.source
        summary = @($records | Where-Object kind -eq 'SUMMARY')[0]
        changes = @($records | Where-Object kind -ne 'SUMMARY')
    }
    Write-Utf8TextAtomic -Path $resolvedReport -Text (($report | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    Write-Output "TRANSLATION_STYLES_APPLIED|document=$resolvedDocument|language=$TargetLanguage|settings=$(@($settings.paragraphStyles).Count)|report=$resolvedReport"
} finally {
    if ($null -ne $app) {
        try { [void]$app.DoScript("(function(){while(app.documents.length){app.documents[0].close(SaveOptions.NO);}return 'CLOSED';}());", $javaScriptLanguage) } catch {
            # Preserve the primary style result when best-effort cleanup fails.
            [void]$_.Exception
        }
    }
    if ($null -ne $app -and $startedInDesign) {
        try {
            $openCount = [int]$app.DoScript('app.documents.length', $javaScriptLanguage)
            if ($openCount -eq 0) { [void]$app.DoScript('app.quit(SaveOptions.NO)', $javaScriptLanguage) }
        } catch {
            # Preserve the primary style result when best-effort shutdown fails.
            [void]$_.Exception
        }
    }
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

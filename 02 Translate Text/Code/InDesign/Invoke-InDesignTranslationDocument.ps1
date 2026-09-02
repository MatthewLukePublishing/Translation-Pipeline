[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Audit', 'Prepare', 'Relink', 'Import', 'Refresh')]
    [string]$Action,

    [Parameter(Mandatory)]
    [string]$DocumentPath,

    [Parameter(Mandatory)]
    [string]$TextFolderPath,

    [Parameter(Mandatory)]
    [string]$JobPath
)

$ErrorActionPreference = 'Stop'
$javaScriptLanguage = 1246973031
$programRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$codeRoot = Split-Path -Parent (Split-Path -Parent $programRoot)
$templatePath = Join-Path $PSScriptRoot 'Run_Translation_Document.jsx'
$exportScriptPath = Join-Path $codeRoot 'Programs\InDesign Scripts\Adobe InDesign 2026\Scripts\Community\Scripts Panel\Translation\Export All Content to Excel.jsx'
$importScriptPath = Join-Path $codeRoot 'Programs\InDesign Scripts\Adobe InDesign 2026\Scripts\Community\Scripts Panel\Translation\Import All Content from Excel.jsx'
$commonAutomationPath = Join-Path $PSScriptRoot 'InDesignAutomationCommon.ps1'
if (-not (Test-Path -LiteralPath $commonAutomationPath -PathType Leaf)) { throw "Missing InDesign automation utility: $commonAutomationPath" }
. $commonAutomationPath

foreach ($required in @($templatePath, $exportScriptPath, $importScriptPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing Step 2 script: $required" }
}
$resolvedDocument = (Resolve-Path -LiteralPath $DocumentPath).Path
$resolvedText = (Resolve-Path -LiteralPath $TextFolderPath).Path
$resolvedJob = (Resolve-Path -LiteralPath $JobPath).Path
if ([IO.Path]::GetExtension($resolvedDocument) -ne '.indd') { throw "Expected an INDD document: $resolvedDocument" }
if ($resolvedDocument -match '(?i)(?:^|[\\/])_?Archive(?:[\\/]|$)') { throw "Archive document paths are forbidden: $resolvedDocument" }

$jobConfig = Get-Content -LiteralPath (Join-Path $resolvedJob 'job_config.json') -Raw | ConvertFrom-Json
if (-not [string]::Equals([IO.Path]::GetFullPath([string]$jobConfig.jobPath), $resolvedJob, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The job configuration does not match the requested job folder.'
}
if (-not $jobConfig.productionWorkspace) { throw 'The job is not a production-workspace job.' }
$workspaceRoot = [IO.Path]::GetFullPath([string]$jobConfig.productionWorkspace.root).TrimEnd('\') + '\'
$resolvedDiagrams = (Resolve-Path -LiteralPath ([string]$jobConfig.productionWorkspace.diagramsFolder)).Path
$documentBoundary = $workspaceRoot
if ($Action -eq 'Audit') {
    $documentBoundary = [IO.Path]::GetFullPath([string]$jobConfig.productionWorkspace.interiorsRoot).TrimEnd('\') + '\'
}
if (-not $resolvedDocument.StartsWith($documentBoundary, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The InDesign document is outside the configured production workspace: $resolvedDocument"
}
if (-not ($resolvedText.TrimEnd('\') + '\').StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Text folder is outside the configured production workspace: $resolvedText"
}
if (-not ($resolvedDiagrams.TrimEnd('\') + '\').StartsWith($workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The Diagrams folder is outside the configured production workspace: $resolvedDiagrams"
}

$mutex = [Threading.Mutex]::new($false, 'Global\PublishingStep2InDesignTranslation')
$hasMutex = $false
$app = $null
$startedInDesign = @((Get-Process -Name InDesign -ErrorAction SilentlyContinue)).Count -eq 0
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw 'Another Step 2 InDesign translation operation is already running.' }
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
        throw "InDesign has open documents. Close them before the automated Step 2 operation so no unrelated document can be affected:`n$openDocuments"
    }

    function Invoke-BoundedInDesignAction {
        param([Parameter(Mandatory)] [string]$EffectiveAction)
        $scriptText = Get-Content -LiteralPath $templatePath -Raw
        $replacements = [ordered]@{
            '__ACTION_JS__' = ConvertTo-JavaScriptStringLiteral $EffectiveAction.ToLowerInvariant()
            '__DOCUMENT_JS__' = ConvertTo-JavaScriptStringLiteral $resolvedDocument
            '__TEXT_FOLDER_JS__' = ConvertTo-JavaScriptStringLiteral $resolvedText
            '__DIAGRAMS_FOLDER_JS__' = ConvertTo-JavaScriptStringLiteral $resolvedDiagrams
            '__EXPORT_SCRIPT_JS__' = ConvertTo-JavaScriptStringLiteral $exportScriptPath
            '__IMPORT_SCRIPT_JS__' = ConvertTo-JavaScriptStringLiteral $importScriptPath
            '__JOB_PATH_JS__' = ConvertTo-JavaScriptStringLiteral $resolvedJob
        }
        foreach ($key in $replacements.Keys) { $scriptText = $scriptText.Replace($key, [string]$replacements[$key]) }
        if ($scriptText -match '__[A-Z][A-Z0-9_]+__') { throw "Unresolved JSX token: $($matches[0])" }
        $actionResult = [string]$app.DoScript($scriptText, $javaScriptLanguage)
        if ($actionResult -like 'ERROR*') { throw $actionResult }
        return $actionResult
    }

    if ($Action -eq 'Audit') {
        Write-Output (Invoke-BoundedInDesignAction -EffectiveAction 'audit')
    } elseif ($Action -in @('Prepare', 'Relink')) {
        $terminal = $false
        for ($attempt = 1; $attempt -le 200 -and -not $terminal; $attempt++) {
            $stepResult = Invoke-BoundedInDesignAction -EffectiveAction $Action
            Write-Output $stepResult
            $terminal = $stepResult -notlike 'RELINK_PROGRESS*'
        }
        if (-not $terminal) { throw 'Relink did not complete within 200 bounded calls.' }
        if ($Action -eq 'Prepare') {
            $refreshComplete = $false
            for ($attempt = 1; $attempt -le 200 -and -not $refreshComplete; $attempt++) {
                $refreshResult = Invoke-BoundedInDesignAction -EffectiveAction 'refresh'
                Write-Output $refreshResult
                $refreshComplete = $refreshResult -notlike 'REFRESH_PROGRESS*'
            }
            if (-not $refreshComplete) { throw 'Post-export link refresh did not complete within 200 bounded calls.' }
        }
    } elseif ($Action -eq 'Import') {
        Write-Output (Invoke-BoundedInDesignAction -EffectiveAction 'import')
        $refreshComplete = $false
        for ($attempt = 1; $attempt -le 200 -and -not $refreshComplete; $attempt++) {
            $refreshResult = Invoke-BoundedInDesignAction -EffectiveAction 'refresh'
            Write-Output $refreshResult
            $refreshComplete = $refreshResult -notlike 'REFRESH_PROGRESS*'
        }
        if (-not $refreshComplete) { throw 'Post-import link refresh did not complete within 200 bounded calls.' }
    } elseif ($Action -eq 'Refresh') {
        $refreshComplete = $false
        for ($attempt = 1; $attempt -le 200 -and -not $refreshComplete; $attempt++) {
            $refreshResult = Invoke-BoundedInDesignAction -EffectiveAction 'refresh'
            Write-Output $refreshResult
            $refreshComplete = $refreshResult -notlike 'REFRESH_PROGRESS*'
        }
        if (-not $refreshComplete) { throw 'Link refresh did not complete within 200 bounded calls.' }
    }
} finally {
    if ($null -ne $app -and $startedInDesign) {
        try {
            $openCount = [int]$app.DoScript('app.documents.length', $javaScriptLanguage)
            if ($openCount -eq 0) { [void]$app.DoScript('app.quit(SaveOptions.NO)', $javaScriptLanguage) }
        } catch {
            # Preserve the primary operation result when best-effort shutdown fails.
            [void]$_.Exception
        }
    }
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

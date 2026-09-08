[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$DocumentPath,
    [Parameter(Mandatory)] [string]$DestinationPath,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'InDesignAutomationCommon.ps1')
$source = (Resolve-Path -LiteralPath $DocumentPath).Path
$destination = [IO.Path]::GetFullPath($DestinationPath)
if ([IO.Path]::GetExtension($source) -ne '.indd') { throw 'Source must be an INDD document.' }
if ((Test-Path -LiteralPath $destination) -and -not $Resume) { throw 'Source package destination already exists; it will not be overwritten.' }
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
$documentName = [IO.Path]::GetFileName($source)
$copiedDocument = Join-Path $destination $documentName
$textFolder = Join-Path $destination 'Text'
$manifestPath = Join-Path $destination 'source_package.json'
$mutex = [Threading.Mutex]::new($false, 'Global\PublishingStep2InDesignTranslation')
$locked = $false
$app = $null
$record = $null


function Invoke-SourceCall {
    param([Parameter(Mandatory)] [string]$Body)
    $script = '(function(){try{var p=' + (ConvertTo-JavaScriptStringLiteral $copiedDocument) + ';if(app.documents.length!==1)throw Error("Unexpected open documents");var d=app.documents[0];if(!d.isValid||d.fullName.fsName.replace(/\\/g,"/").toLowerCase()!==p.toLowerCase())throw Error("Wrong source copy");if(app.backgroundTasks.length)throw Error("Background work is active");' + $Body + '}catch(e){return "SOURCE_ERROR|"+e.message;}}());'
    $result = [string]$app.DoScript($script, 1246973031)
    if ($result -like 'SOURCE_ERROR|*') { throw $result }
    return $result
}

try {
    $locked = $mutex.WaitOne(0)
    if (-not $locked) { throw 'Another Adobe translation operation is running.' }
    $app = Get-InDesignApplication
    $preflight = [string]$app.DoScript('app.documents.length+"|"+app.backgroundTasks.length', 1246973031)
    if ($Resume) {
        if ($preflight -notin @('0|0','1|0')) { throw 'Resuming requires no documents or only the unchanged package copy, with no background tasks.' }
        $previous = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
        if ($previous.status -notin @('exporting','failed') -or $previous.originalDocumentSha256 -ne $sourceHash -or
            [IO.Path]::GetFullPath([string]$previous.originalDocument) -ne $source -or
            @(Get-ChildItem -LiteralPath $textFolder -File).Count -ne 0) {
            throw 'Only an unchanged package interrupted before the first story export can resume here.'
        }
        if ($preflight -eq '1|0') {
            $null = Invoke-SourceCall 'if(d.modified)throw Error("Source copy has unsaved changes");return "RESUME_PREFLIGHT_OK";'
        } elseif ((Get-FileHash -LiteralPath $copiedDocument -Algorithm SHA256).Hash -ne $sourceHash) {
            throw 'Closed package copy differs from the source; inspect it before resuming.'
        }
    } else {
        if ($preflight -ne '0|0') { throw 'Close all InDesign documents and allow background tasks to finish before source export.' }
        [IO.Directory]::CreateDirectory($textFolder) | Out-Null
        Copy-Item -LiteralPath $source -Destination $copiedDocument
    }
    $record = [ordered]@{ schemaVersion=1; status='exporting'; createdAt=[DateTime]::UtcNow.ToString('o'); originalDocument=$source; originalDocumentSha256=$sourceHash; document=$documentName }
    Write-Utf8Json -Path $manifestPath -Value $record
    $openScript = '(function(){var old=app.scriptPreferences.userInteractionLevel;try{app.scriptPreferences.userInteractionLevel=UserInteractionLevels.NEVER_INTERACT;var d=app.open(new File('+(ConvertTo-JavaScriptStringLiteral $copiedDocument)+'),false);return "SOURCE_COPY_OPEN|pages="+d.pages.length+"|stories="+d.stories.length;}finally{app.scriptPreferences.userInteractionLevel=old;}}());'
    if (-not $Resume -or $preflight -eq '0|0') { Write-Output ([string]$app.DoScript($openScript,1246973031)) }
    Wait-InDesignUiIdle
    $counts = (Invoke-SourceCall 'if(d.modified)throw Error("Source copy opened modified");return d.pages.length+"|"+d.stories.length;') -split '\|'
    $pages = [int]$counts[0]; $storyCount = [int]$counts[1]
    if ($pages -lt 1 -or $pages -gt 2000 -or $storyCount -lt 1 -or $storyCount -gt 5000) { throw 'Source exceeds the bounded export limits.' }
    $plan = [Collections.Generic.List[object]]::new()
    for ($offset=0; $offset -lt $storyCount; $offset+=25) {
        $body='var rows=[];for(var i='+$offset+';i<Math.min('+($offset+25)+',d.stories.length);i++){var s=d.stories[i],l=s.itemLink;var n=(l&&l.isValid)?decodeURI(l.name):("Page_0_Story_"+s.id+".icml");rows.push(s.id+"|"+encodeURIComponent(n));}return rows.join("\n");'
        foreach ($line in ((Invoke-SourceCall $body) -split "`n")) {
            $parts=$line -split '\|';$name=[Uri]::UnescapeDataString($parts[1])
            if ([IO.Path]::GetFileName($name) -ne $name -or [IO.Path]::GetExtension($name) -ne '.icml') { throw 'Unexpected source story filename.' }
            $plan.Add([pscustomobject]@{ id=[int]$parts[0]; name=$name })
        }
    }
    if (@($plan.name | Sort-Object -Unique).Count -ne $storyCount) { throw 'Duplicate story export filename.' }
    $record['storyCount']=$storyCount;$record['pages']=$pages;$record['storyPlan']=$plan
    Write-Utf8Json -Path $manifestPath -Value $record
    Write-Output "SOURCE_AUDIT_OK|pages=$pages|stories=$storyCount|originalUnchanged=true|target=$destination"
    for ($offset=0; $offset -lt $storyCount; $offset+=5) {
        $body='var old=app.scriptPreferences.userInteractionLevel;try{app.scriptPreferences.userInteractionLevel=UserInteractionLevels.NEVER_INTERACT;'
        for($index=$offset;$index -lt [Math]::Min($offset+5,$storyCount);$index++) {
            $item=$plan[$index]
            # Already-managed stories cannot be exported twice. Detach only
            # this story in the isolated copy, leaving its original ICML intact.
            $body+='var s=d.stories.itemByID('+$item.id+');if(!s.isValid)throw Error("Story missing");var l=s.itemLink;if(l&&l.isValid)l.unlink();s.exportFile(ExportFormat.INCOPY_MARKUP,new File('+(ConvertTo-JavaScriptStringLiteral (Join-Path $textFolder $item.name))+'),false);'
        }
        $body+='return "SOURCE_EXPORT_PROGRESS|completed='+[Math]::Min($offset+5,$storyCount)+'|total='+$storyCount+'";}finally{app.scriptPreferences.userInteractionLevel=old;}'
        Write-Output (Invoke-SourceCall $body)
    }
    Write-Output (Invoke-SourceCall 'd.save();return "SOURCE_COPY_SAVED";')
    Write-Output (Invoke-SourceCall 'if(d.modified)throw Error("Source copy is modified");d.close(SaveOptions.NO);return "SOURCE_COPY_CLOSED";')
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $sourceHash) { throw 'Original source changed during export.' }
    $record.status='exported'
    Write-Utf8Json -Path $manifestPath -Value $record
} catch {
    # Leave an explicitly incomplete package for diagnosis/recovery, never a
    # usable partial source. Do not close or poll an app that may still be busy.
    if($record){$record.status='failed';$record['error']=$_.Exception.Message;Write-Utf8Json -Path $manifestPath -Value $record}
    throw
} finally {
    if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()
}
$nodeRoot=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$priorModules=$env:CODEX_ARTIFACT_NODE_MODULES
try{
    $env:CODEX_ARTIFACT_NODE_MODULES=Join-Path $nodeRoot 'node_modules'
    & (Join-Path $nodeRoot 'bin\node.exe') (Join-Path (Split-Path -Parent $PSScriptRoot) 'Build-SourcePackage.mjs') $destination
    if($LASTEXITCODE -ne 0){throw 'Source package indexing failed; the incomplete package cannot be prepared.'}
}finally{$env:CODEX_ARTIFACT_NODE_MODULES=$priorModules}

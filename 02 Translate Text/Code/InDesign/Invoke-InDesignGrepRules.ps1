[CmdletBinding()]
param([Parameter(Mandatory)][string]$JobPath,[Parameter(Mandatory)][string]$NodePath,[ValidateSet('Audit','Apply','Verify')][string]$Mode='Audit',[string]$ProductsRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'InDesignTypographyCommon.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'TranslationPathSafety.ps1')
$programRoot=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$job=Assert-PathWithin -Path $JobPath -Parent $programRoot -Label 'GREP job'
$config=Get-Content -LiteralPath (Join-Path $job 'job_config.json') -Raw | ConvertFrom-Json
$document=(Resolve-Path -LiteralPath $config.productionWorkspace.documentPath).Path
$products=Resolve-TranslationProductsRoot -ExplicitPath $ProductsRoot -ProgramRoot $programRoot
$null=Assert-PathWithin -Path $document -Parent $products -Label 'GREP document'
$null=Assert-PathWithin -Path $document -Parent $config.productionWorkspace.root -Label 'GREP isolated document'
if([IO.Path]::GetExtension($document) -ne '.indd' -or $document -match '(?i)(?:^|[\\/])_?Archive(?:[\\/]|$)'){throw 'Invalid GREP document.'}
$policyPath=Join-Path $job 'state\grep_policy.json'
$auditPath=Join-Path $job 'reports\grep_audit.json'
$planPath=Join-Path $job 'state\grep_plan.json'
$reportPath=Join-Path $job 'reports\grep_verification.json'
$journalPath=Join-Path $job 'state\grep_transaction.json'
& $NodePath (Join-Path $programRoot 'Code\InDesignGrepPlan.cjs') --job $job --output $policyPath
if($LASTEXITCODE -ne 0){throw 'GREP policy resolution failed.'}
$policy=Get-Content -LiteralPath $policyPath -Raw | ConvertFrom-Json
$beforeHash=(Get-FileHash -LiteralPath $document -Algorithm SHA256).Hash
$protectedStyles=@();if($config.protectedSourceRules.paragraphStyleName){$protectedStyles=@([string]$config.protectedSourceRules.paragraphStyleName)}
function Invoke-GrepStep([string]$Action,[object[]]$Settings){
    Wait-InDesignUiIdle
    $script=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Run_Translation_Grep.jsx') -Raw
    $script=$script.Replace('__ACTION_JS__',(ConvertTo-JavaScriptStringLiteral $Action)).Replace('__DOCUMENT_JS__',(ConvertTo-JavaScriptStringLiteral $document)).Replace('__SETTINGS_JS__',(ConvertTo-Json -InputObject @($Settings) -Depth 15 -Compress))
    if($script -match '__[A-Z][A-Z0-9_]+__'){throw 'Unresolved GREP JSX placeholder.'}
    $result=[string]$app.DoScript($script,1246973031)
    if($result -like 'ERROR|*'){throw $result}
    return @(ConvertFrom-KeyValueText -Text $result)
}
$mutex=[Threading.Mutex]::new($false,'Global\PublishingStep2InDesignTranslation');$hasMutex=$false
try{
    $hasMutex=$mutex.WaitOne(0);if(-not $hasMutex){throw 'Another InDesign operation is running.'}
    if($Mode -eq 'Apply'){
        $manifest=Get-Content -LiteralPath (Join-Path $job 'job_manifest.json') -Raw | ConvertFrom-Json
        if($manifest.status -ne 'imported'){throw 'GREP changes require the current workbook to be imported first.'}
        & $NodePath (Join-Path $programRoot 'Code\InDesignGrepPlan.cjs') --job $job --audit $auditPath --verify-plan $planPath
        if($LASTEXITCODE -ne 0){throw 'GREP plan verification failed before Adobe access.'}
        $plan=Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
        if($plan.documentSha256 -ne $beforeHash -or $plan.policySha256 -ne $policy.sha256){throw 'GREP plan is stale; run Audit again.'}
        $auditedStories=@((Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json).stories)
        foreach($scope in @($plan.scopes)){
            $auditedStory=@($auditedStories | Where-Object id -eq $scope.storyId)
            if($auditedStory.Count -ne 1){throw 'GREP story inventory is incomplete.'}
            if($auditedStory[0].linkPath){throw 'Linked ICML corrections must be made in the translation workbook, validated and reimported. Native checkout/save discards pipeline Content IDs; no Adobe changes made.'}
        }
        if(Test-Path -LiteralPath $journalPath){$previous=Get-Content -LiteralPath $journalPath -Raw | ConvertFrom-Json;if($previous.status -ne 'committed'){throw "Unfinished GREP transaction. Preserve unsaved changes, close InDesign, and reconcile the document with the verified recovery copy recorded in $journalPath before continuing."}}
        if(-not @($plan.scopes).Count){Write-Output 'GREP_APPLY|changes=0';return}
    }
    if(Get-Process -Name InDesign -ErrorAction SilentlyContinue){Wait-InDesignUiIdle}
    $app=Get-InDesignApplication;$step=@{Application=$app;DocumentPath=$document}
    $null=Invoke-InDesignTypographyStep @step -Action open
    if($Mode -eq 'Apply'){
        $backup=Join-Path $job ("state\grep_before_"+$beforeHash.Substring(0,12)+'.indd')
        if(-not(Test-Path -LiteralPath $backup)){Copy-Item -LiteralPath $document -Destination $backup}
        if((Get-FileHash -LiteralPath $backup -Algorithm SHA256).Hash -ne $beforeHash){throw 'GREP recovery copy differs.'}
        $journal=[ordered]@{schemaVersion=1;status='applying';documentPath=$document;beforeSha256=$beforeHash;backupPath=$backup;backupSha256=$beforeHash;policySha256=$policy.sha256;completedScopes=0;lastSavedSha256=$beforeHash}
        Write-Utf8TextAtomic -Path $journalPath -Text ($journal | ConvertTo-Json -Depth 12)
        foreach($scope in @($plan.scopes)){
            $changed=@(Invoke-GrepStep -Action apply -Settings @($scope) | Where-Object kind -eq GREP_CHANGED)
            $null=Invoke-InDesignTypographyStep @step -Action checkpoint
            $journal.completedScopes++;$journal.lastSavedSha256=(Get-FileHash -LiteralPath $document -Algorithm SHA256).Hash
            Write-Utf8TextAtomic -Path $journalPath -Text ($journal | ConvertTo-Json -Depth 12)
            Write-Output "GREP_APPLY_PROGRESS|scope=$($journal.completedScopes)/$(@($plan.scopes).Count)|changes=$($changed.Count)"
        }
        $null=Invoke-InDesignTypographyStep @step -Action close
        $journal.status='committed';Write-Utf8TextAtomic -Path $journalPath -Text ($journal | ConvertTo-Json -Depth 12)
        Write-Output 'GREP_APPLY_COMPLETE|verification_required=true'
        return
    }
    $summary=@(Invoke-InDesignTypographyStep @step -Action summary)[0]
    $editorial=@(Invoke-InDesignTypographyStep @step -Action editorial-summary)[0]
    $stories=[Collections.Generic.List[object]]::new();$references=[Collections.Generic.List[object]]::new();$records=[Collections.Generic.List[object]]::new()
    for($start=0;$start -lt [int]$summary.stories;$start+=25){foreach($row in @(Invoke-InDesignTypographyStep @step -Action stories -Start $start -Count 25)){$stories.Add($row)}}
    for($start=0;$start -lt [int]$editorial.references;$start+=25){foreach($row in @(Invoke-InDesignTypographyStep @step -Action editorial-reference-scopes -Start $start -Count 25)){$references.Add($row)}}
    if($stories.Count -ne [int]$summary.stories -or $references.Count -ne [int]$editorial.references){throw 'Incomplete GREP scope inventory.'}
    foreach($story in $stories){$story | Add-Member -NotePropertyName referenceIds -NotePropertyValue @($references | Where-Object storyId -eq $story.id | ForEach-Object id)}
    for($start=0;$start -lt $stories.Count;$start+=5){
        $scopes=@();for($i=$start;$i -lt [Math]::Min($start+5,$stories.Count);$i++){$scopes+=@{storyId=$stories[$i].id;referenceIds=$stories[$i].referenceIds;protectedStyles=$protectedStyles;rules=@($policy.applicable)}}
        foreach($row in @(Invoke-GrepStep -Action audit -Settings $scopes)){$records.Add($row)}
        Write-Output "GREP_AUDIT_PROGRESS|stories=$([Math]::Min($start+5,$stories.Count))/$($stories.Count)|rules=$(@($policy.applicable).Count)"
    }
    $null=Invoke-InDesignTypographyStep @step -Action close
    if((Get-FileHash -LiteralPath $document -Algorithm SHA256).Hash -ne $beforeHash){throw 'Read-only GREP audit changed the document.'}
    $audit=[ordered]@{schemaVersion=1;status='inventory_complete';method='indesign_native_grep';documentPath=$document;documentSha256=$beforeHash;policySha256=$policy.sha256;protectedStyles=$protectedStyles;stories=@($stories.ToArray());records=@($records.ToArray());generatedAt=[DateTime]::UtcNow.ToString('o')}
    Write-Utf8TextAtomic -Path $auditPath -Text ($audit | ConvertTo-Json -Depth 15)
    & $NodePath (Join-Path $programRoot 'Code\InDesignGrepPlan.cjs') --job $job --audit $auditPath --output $planPath
    if($LASTEXITCODE -ne 0){throw 'Native GREP result validation failed.'}
    $plan=Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
    if($Mode -eq 'Verify' -and $plan.status -ne 'passed'){throw 'Unapplied GREP changes remain. Review the plan, Apply, then Verify.'}
    if($plan.status -eq 'passed'){Write-Utf8TextAtomic -Path $reportPath -Text ($plan | ConvertTo-Json -Depth 15)}
    Write-Output "GREP_AUDIT_COMPLETE|status=$($plan.status)|plan=$planPath"
}finally{if($hasMutex){$mutex.ReleaseMutex()};$mutex.Dispose()}

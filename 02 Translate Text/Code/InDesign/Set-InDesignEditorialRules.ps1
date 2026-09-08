# Language-specific cross-reference edits belong exclusively to the panel encoder.
# This entry point generates its exact definitions and verifies the saved result.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$JobPath,[Parameter(Mandatory)][string]$NodePath,[string]$ProductsRoot)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'InDesignTypographyCommon.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'TranslationPathSafety.ps1')
$programRoot=Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$resolvedJob=Assert-PathWithin -Path $JobPath -Parent $programRoot -Label 'Editorial job'
$config=Get-Content -LiteralPath (Join-Path $resolvedJob 'job_config.json') -Raw | ConvertFrom-Json
$document=[string]$config.productionWorkspace.documentPath
$auditPath=Join-Path $resolvedJob 'reports\editorial_layout_after.json'
$planPath=Join-Path $resolvedJob 'state\editorial_layout_plan.json'
$reportPath=Join-Path $resolvedJob 'reports\editorial_layout_application.json'
& (Join-Path $PSScriptRoot 'Get-InDesignEditorialAudit.ps1') -DocumentPath $document -ReportPath $auditPath -ProductsRoot $ProductsRoot
& $NodePath (Join-Path $programRoot 'Code\EditorialLayoutRules.cjs') '--job' $resolvedJob '--audit' $auditPath '--output' $planPath
if ($LASTEXITCODE -ne 0) { throw 'Editorial layout planning failed; no document changes were made.' }
$plan=Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
if ((Get-FileHash -LiteralPath $document -Algorithm SHA256).Hash -ne $plan.documentSha256) { throw 'Document changed after the editorial audit.' }
if (@($plan.formatEdits).Count -or @($plan.referenceUpdates).Count) {
    throw "CROSS_REFERENCE_PANEL_REQUIRED: Apply each plan definition using Cross-References > Define Cross-Reference Formats > Definition. Update only the indicated references in that panel, save and close the document, then rerun Finalize. Plan: $planPath. Scripted format edits are forbidden."
}
$report=[ordered]@{schemaVersion=1;status='passed';method='cross_reference_panel_encoder_verified_read_only';policySha256=$plan.policySha256;documentPath=$document;documentSha256=$plan.documentSha256;completedAt=[DateTime]::UtcNow.ToString('o');protectedReferenceIds=@($plan.protectedReferenceIds);checks=$plan.checks;preservedLayoutGuidance=$plan.retainedLayoutRules}
Write-Utf8TextAtomic -Path $reportPath -Text ($report | ConvertTo-Json -Depth 20)
Write-Output "EDITORIAL_LAYOUT_PASSED|method=panel_encoder|protected=$(@($plan.protectedReferenceIds).Count)|report=$reportPath"

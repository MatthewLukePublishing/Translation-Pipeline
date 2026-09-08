[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root 'Run-Translation-Job.ps1') -Raw
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-SubscriptionTranslator'},$true)
. ([scriptblock]::Create($definition.Extent.Text))
$codexNodePath='Invoke-SyntheticTranslator'
$artifactToolPackagePath='synthetic-package'
$artifactNodeModulesPath='synthetic-modules'
$subscriptionTranslatorPath='synthetic-translator'
$script:maxBatchesSpecified=$false
$script:syntheticExit=0
function Test-Path {param($LiteralPath) return $true}
function Invoke-SyntheticTranslator {
    Write-Output 'SYNTHETIC_PROGRESS'
    $global:LASTEXITCODE=$script:syntheticExit
}
$completed=Invoke-SubscriptionTranslator -JobPath 'synthetic-job' 6>$null
if($completed -isnot [bool] -or -not $completed){throw 'Completion must be a Boolean, not captured progress output.'}
$script:syntheticExit=2
$paused=Invoke-SubscriptionTranslator -JobPath 'synthetic-job' 6>$null
if($paused -isnot [bool] -or $paused){throw 'A paused run must return only false and never validate partial output.'}
Write-Output 'TRANSLATION_LAUNCHER_PROGRESS_TEST_OK|cases=2'

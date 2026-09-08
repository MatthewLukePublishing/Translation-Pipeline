[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$activeRoots = @(
    (Join-Path $root 'Code'),
    (Join-Path $root '01 Translate Glossaries'),
    (Join-Path $root '02 Translate Text'),
    (Join-Path $root '03 Translate Diagrams'),
    (Join-Path $root '04 Translate Comic Captions')
)

$scripts = Get-ChildItem -LiteralPath $activeRoots -Recurse -File |
    Where-Object { $_.Extension -in @('.js', '.cjs', '.mjs') }
foreach ($script in $scripts) {
    & $node --check $script.FullName
    if ($LASTEXITCODE -ne 0) { throw "Node syntax check failed: $($script.FullName)" }
}

$powerShellScripts = @(
    Get-ChildItem -LiteralPath $activeRoots -Recurse -File -Filter '*.ps1'
    Get-ChildItem -LiteralPath $root -File -Filter '*.ps1'
    Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.ps1'
) | Sort-Object -Property FullName -Unique
foreach ($script in $powerShellScripts) {
    try {
        [void][ScriptBlock]::Create((Get-Content -LiteralPath $script.FullName -Raw))
    } catch {
        throw "PowerShell syntax check failed: $($script.FullName) | $($_.Exception.Message)"
    }
}

$contractTests = @(
    'SharedContracts.test.cjs'
    'TranslationEditorialRules.test.cjs'
    'EditorialLayoutRules.test.cjs'
    'EditorialNativeVariables.test.cjs'
    'TranslationGrepRules.test.cjs'
    'IcmlGrep.test.cjs'
    'PanelManagedReferences.test.mjs'
    'PanelIcmlRoundTrip.test.cjs'
    'NativeGrepSafety.test.cjs'
    'LiveModelPolicy.test.cjs'
    'SourcePackage.test.cjs'
    'InDesignLifecycle.test.cjs'
    'PipelineRegression.test.cjs'
    'PublicDistribution.test.cjs'
) | ForEach-Object { Join-Path $PSScriptRoot $_ }
& $node --test $contractTests
if ($LASTEXITCODE -ne 0) { throw 'Public Node contract tests failed.' }

$powerShellTests = @(Get-ChildItem -LiteralPath $PSScriptRoot -File -Filter '*.test.ps1')
foreach ($testScript in $powerShellTests) {
    & $testScript.FullName
}

Write-Output "TRANSLATE_PUBLIC_TESTS_OK|nodeSyntax=$($scripts.Count)|powerShellSyntax=$($powerShellScripts.Count)|nodeTestFiles=$($contractTests.Count)|powerShellTestFiles=$($powerShellTests.Count)"

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '02 Translate Text\Code\TranslationPathSafety.ps1')

function Assert-Equal {
    param([Parameter(Mandatory)] [string]$Actual, [Parameter(Mandatory)] [string]$Expected, [Parameter(Mandatory)] [string]$Message)
    if (-not [string]::Equals($Actual, $Expected, [StringComparison]::OrdinalIgnoreCase)) { throw $Message }
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('translate-products-root-' + [Guid]::NewGuid().ToString('N'))
$priorEnvironmentValue = [Environment]::GetEnvironmentVariable('TRANSLATION_PRODUCTS_ROOT')
try {
    $publishingRoot = Join-Path $temporaryRoot 'Publishing'
    $programRoot = Join-Path $publishingRoot 'Code\Programs\Translate'
    $derivedProducts = Join-Path $publishingRoot 'Products'
    $explicitProducts = Join-Path $temporaryRoot 'Explicit Products'
    [IO.Directory]::CreateDirectory($programRoot) | Out-Null
    [IO.Directory]::CreateDirectory($derivedProducts) | Out-Null
    [IO.Directory]::CreateDirectory($explicitProducts) | Out-Null

    $derived = Resolve-TranslationProductsRoot -ProgramRoot $programRoot
    Assert-Equal $derived ([IO.Path]::GetFullPath($derivedProducts)) 'Products root was not derived from the canonical sibling layout.'

    [Environment]::SetEnvironmentVariable('TRANSLATION_PRODUCTS_ROOT', $explicitProducts)
    $fromEnvironment = Resolve-TranslationProductsRoot -ProgramRoot $programRoot
    Assert-Equal $fromEnvironment ([IO.Path]::GetFullPath($explicitProducts)) 'Products root did not honor TRANSLATION_PRODUCTS_ROOT.'

    $missingRejected = $false
    try { Resolve-TranslationProductsRoot -ExplicitPath (Join-Path $temporaryRoot 'Missing') -ProgramRoot $programRoot | Out-Null }
    catch { $missingRejected = $_.Exception.Message -match 'does not exist' }
    if (-not $missingRejected) { throw 'A missing explicit Products root was not rejected.' }

    Write-Output 'TRANSLATION_PATH_SAFETY_TEST_OK|cases=3'
} finally {
    [Environment]::SetEnvironmentVariable('TRANSLATION_PRODUCTS_ROOT', $priorEnvironmentValue)
    if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}

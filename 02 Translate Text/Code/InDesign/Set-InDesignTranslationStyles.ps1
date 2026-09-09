[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$DocumentPath,
    [Parameter(Mandatory)] [string]$TargetLanguage,
    [Parameter(Mandatory)] [string]$SettingsPath,
    [Parameter(Mandatory)] [string]$ReportPath,
    [string]$ProductsRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'InDesignTypographyCommon.ps1')
$nativeLanguage = Resolve-InDesignTranslationLanguage -TargetLanguage $TargetLanguage
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'TranslationPathSafety.ps1')
$programRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$productsRoot = Resolve-TranslationProductsRoot -ExplicitPath $ProductsRoot -ProgramRoot $programRoot
$resolvedDocument = (Resolve-Path -LiteralPath $DocumentPath).Path
$resolvedSettings = (Resolve-Path -LiteralPath $SettingsPath).Path
$resolvedReport = [IO.Path]::GetFullPath($ReportPath)
if ([IO.Path]::GetExtension($resolvedDocument) -ne '.indd') { throw "Expected an INDD document: $resolvedDocument" }
if ($resolvedDocument -match '(?i)(?:^|[\\/])_?Archive(?:[\\/]|$)') { throw "Archive document paths are forbidden: $resolvedDocument" }
$null = Assert-PathWithin -Path $resolvedDocument -Parent $productsRoot -Label 'InDesign document'
$settings = Get-Content -LiteralPath $resolvedSettings -Raw | ConvertFrom-Json
if ([int]$settings.schemaVersion -ne 1 -or -not $settings.paragraphStyles -or @($settings.paragraphStyles).Count -gt 100) {
    throw 'Invalid translation layout settings JSON (1–100 paragraph style settings required).'
}
if ($settings.targetLanguage -and -not ([string]$settings.targetLanguage).Equals($TargetLanguage, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Settings target language '$($settings.targetLanguage)' does not match '$TargetLanguage'."
}
$requestedPaths = @{}
foreach ($setting in @($settings.paragraphStyles)) {
    if (-not $setting.path -or $requestedPaths.ContainsKey([string]$setting.path)) { throw 'Style paths must be nonempty and unique.' }
    $requestedPaths[[string]$setting.path] = $true
    foreach ($field in @('pointSize', 'leading')) {
        if ($null -ne $setting.$field) {
            $value = [double]$setting.$field
            if ([double]::IsNaN($value) -or [double]::IsInfinity($value) -or $value -le 0 -or $value -gt 1000) { throw "Invalid $field for $($setting.path)." }
        }
    }
}
[IO.Directory]::CreateDirectory((Split-Path -Parent $resolvedReport)) | Out-Null
$mutex = [Threading.Mutex]::new($false, 'Global\PublishingStep2InDesignTranslation')
$hasMutex = $false
$app = $null
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw 'Another Step 2 InDesign operation is already running.' }
    if (Get-Process -Name InDesign -ErrorAction SilentlyContinue) { Wait-InDesignUiIdle }
    $app = Get-InDesignApplication
    $step = @{ Application = $app; DocumentPath = $resolvedDocument }
    $null = Invoke-InDesignTypographyStep @step -Action open
    $summary = @(Invoke-InDesignTypographyStep @step -Action summary)[0]
    $styles = [Collections.Generic.List[object]]::new()
    for ($start = 0; $start -lt [int]$summary.paragraphStyles; $start += 25) {
        foreach ($row in @(Invoke-InDesignTypographyStep @step -Action styles -Start $start -Count 25)) { $styles.Add($row) }
    }
    $knownPaths = @{}
    foreach ($style in $styles) { $knownPaths[[string]$style.path] = $true }
    foreach ($path in $requestedPaths.Keys) {
        if (-not $knownPaths.ContainsKey($path)) { throw "Paragraph style not found; no styles were changed: $path" }
    }
    # Publish the read-only plan before the first mutation; interruption leaves explicit incomplete evidence.
    $changes = [Collections.Generic.List[object]]::new()
    $report = [ordered]@{
        schemaVersion = 1; status = 'audited'; documentPath = $resolvedDocument
        targetLanguage = $TargetLanguage; nativeLanguage = $nativeLanguage; settingsPath = $resolvedSettings; source = $settings.source
        summary = $summary; beforeStyles = @($styles.ToArray()); changes = @()
    }
    Write-Utf8TextAtomic -Path $resolvedReport -Text (($report | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    Write-Output "TYPOGRAPHY_PLAN|document=$resolvedDocument|styles=$($styles.Count)|settings=$($requestedPaths.Count)"
    foreach ($phase in @('language', 'apply')) {
        $limit = if ($phase -eq 'language') { $styles.Count } else { @($settings.paragraphStyles).Count }
        $batch = if ($phase -eq 'language') { 20 } else { 5 }
        for ($start = 0; $start -lt $limit; $start += $batch) {
            foreach ($row in @(Invoke-InDesignTypographyStep @step -Action $phase -Start $start -Count $batch -Settings @($settings.paragraphStyles) -TargetLanguage $TargetLanguage)) {
                if ($row.kind -ne 'UNCHANGED') { $changes.Add($row) }
            }
            $null = Invoke-InDesignTypographyStep @step -Action checkpoint
            $report.status = 'in_progress'
            $report.changes = @($changes.ToArray())
            Write-Utf8TextAtomic -Path $resolvedReport -Text (($report | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
            Write-Output "TYPOGRAPHY_PROGRESS|phase=$phase|completed=$([Math]::Min($start + $batch, $limit))/$limit"
        }
    }
    $null = Invoke-InDesignTypographyStep @step -Action recompose
    $null = Invoke-InDesignTypographyStep @step -Action checkpoint
    $null = Invoke-InDesignTypographyStep @step -Action close
    $report.status = 'complete'
    $report.completedAt = [DateTime]::UtcNow.ToString('o')
    $report.summary = [ordered]@{
        document = $resolvedDocument; language = $TargetLanguage; nativeLanguage = $nativeLanguage
        languageChanges = @($changes | Where-Object kind -eq 'LANGUAGE').Count
        styleSettings = @($settings.paragraphStyles).Count
    }
    Write-Utf8TextAtomic -Path $resolvedReport -Text (($report | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
    Write-Output "TRANSLATION_STYLES_APPLIED|document=$resolvedDocument|language=$TargetLanguage|settings=$(@($settings.paragraphStyles).Count)|report=$resolvedReport"
} finally {
    # Never issue cleanup COM calls after a failure: preserve documents and any unsaved work.
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

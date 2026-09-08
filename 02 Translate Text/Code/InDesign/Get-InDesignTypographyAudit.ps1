[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$DocumentPath,
    [Parameter(Mandatory)] [string]$ReportPath,
    [string]$ProductsRoot,
    [ValidateRange(10, 100)] [int]$StoryBatchSize = 50
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'InDesignTypographyCommon.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'TranslationPathSafety.ps1')
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
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw 'Another Step 2 InDesign operation is already running.' }
    if (Get-Process -Name InDesign -ErrorAction SilentlyContinue) { Wait-InDesignUiIdle }
    $app = Get-InDesignApplication
    $step = @{ Application = $app; DocumentPath = $resolvedDocument }
    $null = Invoke-InDesignTypographyStep @step -Action open
    $summary = @(Invoke-InDesignTypographyStep @step -Action summary)[0]
    $styles = [Collections.Generic.List[object]]::new()
    $stories = [Collections.Generic.List[object]]::new()
    $tables = [Collections.Generic.List[object]]::new()
    $cells = [Collections.Generic.List[object]]::new()
    $problemLinks = [Collections.Generic.List[object]]::new()
    $links = [ordered]@{ kind = 'LINKS'; missing = 0; outdated = 0; embedded = 0; total = 0 }
    for ($start = 0; $start -lt [int]$summary.paragraphStyles; $start += 25) {
        foreach ($row in @(Invoke-InDesignTypographyStep @step -Action styles -Start $start -Count 25)) { $styles.Add($row) }
    }
    for ($start = 0; $start -lt [int]$summary.links; $start += 100) {
        foreach ($row in @(Invoke-InDesignTypographyStep @step -Action links -Start $start -Count 100)) {
            if ($row.kind -eq 'LINK') { $problemLinks.Add($row) }
            elseif ($row.kind -eq 'LINKS') { foreach ($field in @('missing', 'outdated', 'embedded', 'total')) { $links[$field] += [int]$row.$field } }
            else { throw "Unexpected link audit row: $($row.kind)" }
        }
    }
    for ($start = 0; $start -lt [int]$summary.stories; $start += $StoryBatchSize) {
        foreach ($row in @(Invoke-InDesignTypographyStep @step -Action stories -Start $start -Count $StoryBatchSize)) { $stories.Add($row) }
        Write-Output "AUDIT_PROGRESS|document=$resolvedDocument|stories=$([Math]::Min($start + $StoryBatchSize, [int]$summary.stories))/$($summary.stories)"
    }
    if ($styles.Count -ne [int]$summary.paragraphStyles -or $stories.Count -ne [int]$summary.stories -or $links.total -ne [int]$summary.links) {
        throw 'Typography audit was incomplete; no passing report was published.'
    }
    foreach ($story in $stories) {
        $before = $tables.Count
        for ($start = 0; $start -lt [int]$story.tableCount; $start += 25) {
            foreach ($row in @(Invoke-InDesignTypographyStep @step -Action tables -Start $start -Count 25 -Settings @(@{ storyId = $story.id }))) {
                if ($row.kind -ne 'TABLE') { throw 'Unexpected table audit row.' }
                $tables.Add($row)
            }
        }
        if (($tables.Count - $before) -ne [int]$story.tableCount) { throw 'Incomplete table inventory.' }
    }
    foreach ($table in $tables) {
        $before = $cells.Count
        for ($start = 0; $start -lt [int]$table.cellCount; $start += 50) {
            foreach ($row in @(Invoke-InDesignTypographyStep @step -Action cells -Start $start -Count 50 -Settings @(@{ storyId = $table.storyId; tableId = $table.id }))) {
                if ($row.kind -ne 'CELL') { throw 'Unexpected cell audit row.' }
                $cells.Add($row)
            }
        }
        if (($cells.Count - $before) -ne [int]$table.cellCount) { throw 'Incomplete table-cell audit.' }
        Write-Output "TABLE_AUDIT_PROGRESS|table=$($table.id)|cells=$($table.cellCount)"
    }
    $null = Invoke-InDesignTypographyStep @step -Action close
    $report = [ordered]@{
        schemaVersion = 1; generatedAt = [DateTime]::UtcNow.ToString('o')
        auditMode = 'read_only_bounded'; sourceDocument = $resolvedDocument
        summary = $summary; linkStatus = $links; problemLinks = @($problemLinks.ToArray())
        paragraphStyles = @($styles.ToArray()); stories = @($stories.ToArray())
        tableAudit = [ordered]@{ status = 'complete'; tableCount = $tables.Count; cellCount = $cells.Count; tables = @($tables.ToArray()) }
        overflow = [ordered]@{
            storyCount = @($stories | Where-Object overflows -eq 'true').Count
            stories = @($stories | Where-Object overflows -eq 'true')
            cellCount = @($cells | Where-Object overflows -eq 'true').Count
            cells = @($cells | Where-Object overflows -eq 'true')
        }
    }
    Write-Utf8TextAtomic -Path $resolvedReport -Text ($report | ConvertTo-Json -Depth 20)
    Write-Output "AUDIT_COMPLETE|document=$resolvedDocument|styles=$($styles.Count)|stories=$($stories.Count)|overflowStories=$($report.overflow.storyCount)|overflowCells=$($report.overflow.cellCount)|report=$resolvedReport"
} finally {
    # An interrupted read-only audit must never save or discard any document.
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

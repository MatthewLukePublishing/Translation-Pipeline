[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$DocumentPath,
    [Parameter(Mandatory)] [string]$ReportPath,
    [string]$ProductsRoot
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'InDesignTypographyCommon.ps1')
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'TranslationPathSafety.ps1')
$programRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
$productsRoot = Resolve-TranslationProductsRoot -ExplicitPath $ProductsRoot -ProgramRoot $programRoot
$resolvedDocument = (Resolve-Path -LiteralPath $DocumentPath).Path
$null = Assert-PathWithin -Path $resolvedDocument -Parent $productsRoot -Label 'Editorial audit document'
if ([IO.Path]::GetExtension($resolvedDocument) -ne '.indd' -or $resolvedDocument -match '(?i)(?:^|[\\/])_?Archive(?:[\\/]|$)') { throw 'Invalid editorial audit document.' }
$beforeHash = (Get-FileHash -LiteralPath $resolvedDocument -Algorithm SHA256).Hash
$mutex = [Threading.Mutex]::new($false, 'Global\PublishingStep2InDesignTranslation')
$hasMutex = $false
try {
    $hasMutex = $mutex.WaitOne(0)
    if (-not $hasMutex) { throw 'Another InDesign operation is running.' }
    if (Get-Process -Name InDesign -ErrorAction SilentlyContinue) { Wait-InDesignUiIdle }
    $app = Get-InDesignApplication
    $step = @{ Application = $app; DocumentPath = $resolvedDocument }
    $null = Invoke-InDesignTypographyStep @step -Action open
    $summary = @(Invoke-InDesignTypographyStep @step -Action editorial-summary)[0]
    $records = [Collections.Generic.List[object]]::new()
    foreach ($scope in @(
        @{ Action = 'editorial-layers'; Length = [int]$summary.layers; Batch = 25 },
        @{ Action = 'editorial-formats'; Length = [int]$summary.formats; Batch = 10 },
        @{ Action = 'editorial-references'; Length = [int]$summary.references; Batch = 25 },
        @{ Action = 'styles'; Length = [int]$summary.paragraphStyles; Batch = 25 }
    )) {
        for ($start = 0; $start -lt $scope.Length; $start += $scope.Batch) {
            foreach ($row in @(Invoke-InDesignTypographyStep @step -Action $scope.Action -Start $start -Count $scope.Batch)) { $records.Add($row) }
            Write-Output "EDITORIAL_AUDIT_PROGRESS|scope=$($scope.Action)|checked=$([Math]::Min($start+$scope.Batch,$scope.Length))/$($scope.Length)"
        }
    }
    foreach ($check in @(@{Kind='LAYER';Count=[int]$summary.layers},@{Kind='FORMAT';Count=[int]$summary.formats},@{Kind='REFERENCE';Count=[int]$summary.references},@{Kind='STYLE';Count=[int]$summary.paragraphStyles})) {
        if (@($records | Where-Object kind -eq $check.Kind).Count -ne $check.Count) { throw "Incomplete editorial $($check.Kind) inventory." }
    }
    $null = Invoke-InDesignTypographyStep @step -Action close
    if ((Get-FileHash -LiteralPath $resolvedDocument -Algorithm SHA256).Hash -ne $beforeHash) { throw 'Read-only editorial audit unexpectedly changed the document.' }
    $report = [ordered]@{ schemaVersion=1; auditMode='read_only_bounded'; status='inventory_complete'; sourceDocument=$resolvedDocument; documentSha256=$beforeHash; generatedAt=[DateTime]::UtcNow.ToString('o'); summary=$summary; records=@($records.ToArray()) }
    Write-Utf8TextAtomic -Path ([IO.Path]::GetFullPath($ReportPath)) -Text ($report | ConvertTo-Json -Depth 12)
    Write-Output "EDITORIAL_AUDIT_COMPLETE|document=$resolvedDocument|report=$ReportPath"
} finally {
    if ($hasMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}

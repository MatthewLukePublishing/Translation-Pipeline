[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root 'Code\TranslationFileUtilities.ps1')
. (Join-Path $root 'Code\TranslationJobArchive.ps1')

function Assert-True {
    param([Parameter(Mandatory)] [bool]$Condition, [Parameter(Mandatory)] [string]$Message)
    if (-not $Condition) { throw $Message }
}

function New-ArchiveFixture {
    param([Parameter(Mandatory)] [string]$Root, [Parameter(Mandatory)] [string]$Status)
    $source = Join-Path $Root 'Jobs\SUT\French\job-1'
    $destination = Join-Path $Root 'Archive\SUT\French\job-1'
    $active = Join-Path $Root 'Active Job.json'
    [IO.Directory]::CreateDirectory($source) | Out-Null
    Write-Utf8Json -Path (Join-Path $source 'job_config.json') -Value ([ordered]@{
        schemaVersion = 1; jobId = 'job-1'; jobPath = $source; book = 'SUT'; targetLanguage = 'French'
    })
    $manifest = [ordered]@{ schemaVersion = 1; jobId = 'job-1'; status = $Status }
    if ($Status -eq 'archived') {
        $manifest.archivedAt = [DateTime]::UtcNow.ToString('o')
        $manifest.archivePath = $destination
    }
    Write-Utf8Json -Path (Join-Path $source 'job_manifest.json') -Value $manifest
    Write-Utf8Json -Path $active -Value ([ordered]@{
        schemaVersion = 1; jobId = 'job-1'; jobPath = $source; book = 'SUT'; targetLanguage = 'French'
    })
    return [pscustomobject]@{ Source = $source; Destination = $destination; Active = $active }
}

function Invoke-FixtureArchive {
    param([Parameter(Mandatory)] $Fixture)
    Invoke-StandardTranslationJobArchive -SourcePath $Fixture.Source -DestinationPath $Fixture.Destination `
        -ActivePointerPath $Fixture.Active -ExpectedJobId 'job-1' -ExpectedBook 'SUT' -ExpectedLanguage 'French'
}

$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('translate-archive-' + [Guid]::NewGuid().ToString('N'))
try {
    $normal = New-ArchiveFixture -Root (Join-Path $temporaryRoot 'normal') -Status 'imported'
    $normalResult = Invoke-FixtureArchive -Fixture $normal
    Assert-True ($normalResult.RecoveryMode -eq 'new') 'Normal archive did not report a new transaction.'
    Assert-True (Test-Path -LiteralPath $normal.Destination -PathType Container) 'Normal archive did not create the destination.'
    Assert-True (-not (Test-Path -LiteralPath $normal.Source)) 'Normal archive left the source behind.'
    Assert-True (-not (Test-Path -LiteralPath $normal.Active)) 'Normal archive left the active pointer behind.'

    $beforeMove = New-ArchiveFixture -Root (Join-Path $temporaryRoot 'before-move') -Status 'archived'
    $beforeMoveResult = Invoke-FixtureArchive -Fixture $beforeMove
    Assert-True ($beforeMoveResult.RecoveryMode -eq 'resumed_before_move') 'Pre-move recovery mode was not detected.'
    Assert-True (Test-Path -LiteralPath $beforeMove.Destination -PathType Container) 'Pre-move recovery did not finish the move.'
    Assert-True (-not (Test-Path -LiteralPath $beforeMove.Active)) 'Pre-move recovery left the active pointer behind.'

    $afterMove = New-ArchiveFixture -Root (Join-Path $temporaryRoot 'after-move') -Status 'archived'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $afterMove.Destination)) | Out-Null
    Move-Item -LiteralPath $afterMove.Source -Destination $afterMove.Destination
    $afterMoveResult = Invoke-FixtureArchive -Fixture $afterMove
    Assert-True ($afterMoveResult.RecoveryMode -eq 'resumed_after_move') 'Post-move recovery mode was not detected.'
    Assert-True (-not (Test-Path -LiteralPath $afterMove.Active)) 'Post-move recovery left the active pointer behind.'

    $conflict = New-ArchiveFixture -Root (Join-Path $temporaryRoot 'conflict') -Status 'imported'
    [IO.Directory]::CreateDirectory($conflict.Destination) | Out-Null
    $conflictRejected = $false
    try { Invoke-FixtureArchive -Fixture $conflict | Out-Null }
    catch { $conflictRejected = $_.Exception.Message -match 'both exist' }
    Assert-True $conflictRejected 'Archive did not fail closed when source and destination both existed.'
    Assert-True (Test-Path -LiteralPath $conflict.Active -PathType Leaf) 'Conflict handling removed the active pointer.'

    Write-Output 'TRANSLATION_JOB_ARCHIVE_TEST_OK|cases=4'
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}

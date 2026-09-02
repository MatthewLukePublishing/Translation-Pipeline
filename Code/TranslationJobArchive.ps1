function Get-StandardTranslationJobArchiveState {
    param(
        [Parameter(Mandatory)] [string]$JobRoot,
        [Parameter(Mandatory)] [string]$SourcePath,
        [Parameter(Mandatory)] [string]$ExpectedJobId,
        [Parameter(Mandatory)] [string]$ExpectedBook,
        [Parameter(Mandatory)] [string]$ExpectedLanguage
    )

    $config = Read-JsonFile -Path (Join-Path $JobRoot 'job_config.json') -Label 'job configuration'
    $manifest = Read-JsonFile -Path (Join-Path $JobRoot 'job_manifest.json') -Label 'job manifest'
    if ($config.productionWorkspace) {
        throw 'Production-workspace jobs cannot be moved to the standard translation-job archive.'
    }
    if (-not [string]::Equals([string]$config.jobId, $ExpectedJobId, [StringComparison]::Ordinal) -or
        -not [string]::Equals([string]$manifest.jobId, $ExpectedJobId, [StringComparison]::Ordinal)) {
        throw "Archive job identity does not match the active pointer: $JobRoot"
    }
    if (-not [string]::Equals([string]$config.book, $ExpectedBook, [StringComparison]::OrdinalIgnoreCase) -or
        -not [string]::Equals([string]$config.targetLanguage, $ExpectedLanguage, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive job book or language does not match the active pointer: $JobRoot"
    }
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$config.jobPath), $SourcePath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Archive job configuration has an unexpected source path: $JobRoot"
    }
    return [pscustomobject]@{ Config = $config; Manifest = $manifest }
}

function Invoke-StandardTranslationJobArchive {
    param(
        [Parameter(Mandatory)] [string]$SourcePath,
        [Parameter(Mandatory)] [string]$DestinationPath,
        [Parameter(Mandatory)] [string]$ActivePointerPath,
        [Parameter(Mandatory)] [string]$ExpectedJobId,
        [Parameter(Mandatory)] [string]$ExpectedBook,
        [Parameter(Mandatory)] [string]$ExpectedLanguage,
        [switch]$Force
    )

    $source = [IO.Path]::GetFullPath($SourcePath)
    $destination = [IO.Path]::GetFullPath($DestinationPath)
    $activePointer = [IO.Path]::GetFullPath($ActivePointerPath)
    $sourceExists = Test-Path -LiteralPath $source -PathType Container
    $destinationExists = Test-Path -LiteralPath $destination -PathType Container
    if ($sourceExists -and $destinationExists) {
        throw "Archive source and destination both exist; refusing to guess which directory is authoritative: $source | $destination"
    }
    if (-not $sourceExists -and -not $destinationExists) {
        throw "Neither the archive source nor its deterministic destination exists: $source | $destination"
    }

    $jobRoot = if ($sourceExists) { $source } else { $destination }
    $state = Get-StandardTranslationJobArchiveState -JobRoot $jobRoot -SourcePath $source `
        -ExpectedJobId $ExpectedJobId -ExpectedBook $ExpectedBook -ExpectedLanguage $ExpectedLanguage
    $manifest = $state.Manifest
    $manifestPath = Join-Path $jobRoot 'job_manifest.json'
    $wasAlreadyStaged = [string]$manifest.status -eq 'archived'

    if ($wasAlreadyStaged) {
        if (-not [string]$manifest.archivedAt -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$manifest.archivePath), $destination, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The staged archive manifest is incomplete or names a different destination: $manifestPath"
        }
    } elseif ([string]$manifest.status -ne 'imported' -and -not $Force) {
        throw "Only an imported job can be archived without -Force. Current status: $($manifest.status)"
    } elseif (-not $sourceExists) {
        throw "The job was moved without a valid staged archive manifest: $destination"
    }

    if ($sourceExists) {
        if (-not $wasAlreadyStaged) {
            $manifest.status = 'archived'
            $manifest | Add-Member -NotePropertyName archivedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
            $manifest | Add-Member -NotePropertyName archivePath -NotePropertyValue $destination -Force
            Write-Utf8Json -Path $manifestPath -Value $manifest
        }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        try {
            Move-Item -LiteralPath $source -Destination $destination
        } catch {
            throw "Archive is staged but its directory move is incomplete; rerun Archive to resume. $($_.Exception.Message)"
        }
        $jobRoot = $destination
        $state = Get-StandardTranslationJobArchiveState -JobRoot $jobRoot -SourcePath $source `
            -ExpectedJobId $ExpectedJobId -ExpectedBook $ExpectedBook -ExpectedLanguage $ExpectedLanguage
        if ([string]$state.Manifest.status -ne 'archived' -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$state.Manifest.archivePath), $destination, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The moved archive failed post-move validation: $destination"
        }
    }

    if (Test-Path -LiteralPath $activePointer -PathType Leaf) {
        $active = Read-JsonFile -Path $activePointer -Label 'active-job configuration'
        if (-not [string]::Equals([string]$active.jobId, $ExpectedJobId, [StringComparison]::Ordinal) -or
            -not [string]::Equals([IO.Path]::GetFullPath([string]$active.jobPath), $source, [StringComparison]::OrdinalIgnoreCase)) {
            throw "The active-job pointer changed while the archive was being completed: $activePointer"
        }
        Remove-Item -LiteralPath $activePointer
    }

    return [pscustomobject]@{
        Destination = $destination
        RecoveryMode = if (-not $sourceExists) { 'resumed_after_move' } elseif ($wasAlreadyStaged) { 'resumed_before_move' } else { 'new' }
    }
}

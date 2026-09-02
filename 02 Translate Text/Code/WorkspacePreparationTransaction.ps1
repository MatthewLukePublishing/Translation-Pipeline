$script:WorkspacePreparationMarkerName = '.translation-workspace-prepare.json'

function Get-WorkspacePreparationFullPath {
    param([Parameter(Mandatory)] [string]$Path)
    return [IO.Path]::GetFullPath($Path)
}

function Test-WorkspacePreparationPathWithin {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Parent
    )
    $fullPath = Get-WorkspacePreparationFullPath -Path $Path
    $fullParent = (Get-WorkspacePreparationFullPath -Path $Parent).TrimEnd('\') + '\'
    return $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)
}

function Write-WorkspacePreparationJsonAtomic {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] $Value
    )
    $fullPath = Get-WorkspacePreparationFullPath -Path $Path
    $parent = Split-Path -Parent $fullPath
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = '{0}.tmp-{1}-{2}' -f $fullPath, $PID, ([Guid]::NewGuid().ToString('N'))
    try {
        $json = ($Value | ConvertTo-Json -Depth 30) + [Environment]::NewLine
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($json)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Flush($true)
        } finally {
            $stream.Dispose()
        }
        [IO.File]::Move($temporary, $fullPath, $true)
    } catch {
        $primaryError = $_
        try { [IO.File]::Delete($temporary) } catch { [void]$_.Exception }
        throw $primaryError
    }
}

function Read-WorkspacePreparationJournal {
    param([Parameter(Mandatory)] [string]$JournalPath)
    $fullPath = Get-WorkspacePreparationFullPath -Path $JournalPath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Missing workspace-preparation transaction journal: $fullPath"
    }
    try { $journal = Get-Content -LiteralPath $fullPath -Raw | ConvertFrom-Json }
    catch { throw "Invalid workspace-preparation transaction journal $fullPath`: $($_.Exception.Message)" }
    if ([int]$journal.schemaVersion -ne 1 -or -not [string]$journal.transactionId -or -not [string]$journal.phase) {
        throw "Unsupported workspace-preparation transaction journal: $fullPath"
    }
    return $journal
}

function Assert-WorkspacePreparationJournalTargets {
    param(
        [Parameter(Mandatory)] $Journal,
        [Parameter(Mandatory)] [string]$AllowedWorkspaceParent,
        [Parameter(Mandatory)] [string]$AllowedJobsRoot,
        [Parameter(Mandatory)] [string]$ExpectedActiveJobPath
    )
    $workspaceRoot = Get-WorkspacePreparationFullPath -Path ([string]$Journal.workspaceRoot)
    $jobPath = Get-WorkspacePreparationFullPath -Path ([string]$Journal.jobPath)
    $activeJobPath = Get-WorkspacePreparationFullPath -Path ([string]$Journal.activeJobPath)
    if (-not (Test-WorkspacePreparationPathWithin -Path $workspaceRoot -Parent $AllowedWorkspaceParent)) {
        throw "Workspace transaction target is outside the permitted product root: $workspaceRoot"
    }
    if (-not (Test-WorkspacePreparationPathWithin -Path $jobPath -Parent $AllowedJobsRoot)) {
        throw "Workspace transaction job is outside the permitted Jobs root: $jobPath"
    }
    if (-not [string]::Equals(
        $activeJobPath,
        (Get-WorkspacePreparationFullPath -Path $ExpectedActiveJobPath),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Workspace transaction active-job target is unexpected: $activeJobPath"
    }
    return [pscustomobject]@{
        WorkspaceRoot = $workspaceRoot
        JobPath = $jobPath
        ActiveJobPath = $activeJobPath
    }
}

function Start-WorkspacePreparationTransaction {
    param(
        [Parameter(Mandatory)] [string]$JournalPath,
        [Parameter(Mandatory)] [string]$WorkspaceRoot,
        [Parameter(Mandatory)] [string]$JobPath,
        [Parameter(Mandatory)] [string]$ActiveJobPath
    )
    $fullJournalPath = Get-WorkspacePreparationFullPath -Path $JournalPath
    if (Test-Path -LiteralPath $fullJournalPath) {
        throw "Recover the existing workspace-preparation transaction first: $fullJournalPath"
    }
    $resolvedWorkspace = Get-WorkspacePreparationFullPath -Path $WorkspaceRoot
    $resolvedJob = Get-WorkspacePreparationFullPath -Path $JobPath
    $resolvedActiveJob = Get-WorkspacePreparationFullPath -Path $ActiveJobPath
    if (Test-Path -LiteralPath $resolvedWorkspace) { throw "Translation workspace already exists: $resolvedWorkspace" }
    if (Test-Path -LiteralPath $resolvedJob) { throw "Translation job already exists: $resolvedJob" }

    $activeInitiallyExisted = Test-Path -LiteralPath $resolvedActiveJob -PathType Leaf
    $activeInitialBase64 = if ($activeInitiallyExisted) {
        [Convert]::ToBase64String([IO.File]::ReadAllBytes($resolvedActiveJob))
    } else { '' }
    $journal = [ordered]@{
        schemaVersion = 1
        transactionId = [Guid]::NewGuid().ToString('D')
        phase = 'planned'
        createdAt = [DateTime]::UtcNow.ToString('o')
        workspaceRoot = $resolvedWorkspace
        jobPath = $resolvedJob
        activeJobPath = $resolvedActiveJob
        activeJobInitiallyExisted = $activeInitiallyExisted
        activeJobInitialBase64 = $activeInitialBase64
    }
    Write-WorkspacePreparationJsonAtomic -Path $fullJournalPath -Value $journal
    return [pscustomobject]$journal
}

function Set-WorkspacePreparationTransactionPhase {
    param(
        [Parameter(Mandatory)] [string]$JournalPath,
        [Parameter(Mandatory)] [ValidateSet('planned', 'targets_initialized', 'preparing', 'committed')] [string]$Phase
    )
    $journal = Read-WorkspacePreparationJournal -JournalPath $JournalPath
    $journal.phase = $Phase
    $journal | Add-Member -NotePropertyName updatedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Write-WorkspacePreparationJsonAtomic -Path $JournalPath -Value $journal
    return $journal
}

function Initialize-WorkspacePreparationTargets {
    param([Parameter(Mandatory)] [string]$JournalPath)
    $journal = Read-WorkspacePreparationJournal -JournalPath $JournalPath
    if ([string]$journal.phase -ne 'planned') {
        throw "Workspace-preparation targets require the planned phase; found '$($journal.phase)'."
    }
    $marker = [ordered]@{
        schemaVersion = 1
        transactionId = [string]$journal.transactionId
        createdAt = [DateTime]::UtcNow.ToString('o')
    }
    foreach ($target in @([string]$journal.workspaceRoot, [string]$journal.jobPath)) {
        [IO.Directory]::CreateDirectory($target) | Out-Null
        $markerPath = Join-Path $target $script:WorkspacePreparationMarkerName
        if (Test-Path -LiteralPath $markerPath) { throw "Workspace-preparation marker already exists: $markerPath" }
        Write-WorkspacePreparationJsonAtomic -Path $markerPath -Value $marker
    }
    [void](Set-WorkspacePreparationTransactionPhase -JournalPath $JournalPath -Phase 'targets_initialized')
    return $journal
}

function Test-WorkspacePreparationOwnedTarget {
    param(
        [Parameter(Mandatory)] [string]$TargetPath,
        [Parameter(Mandatory)] [string]$TransactionId
    )
    if (-not (Test-Path -LiteralPath $TargetPath -PathType Container)) { return $true }
    $markerPath = Join-Path $TargetPath $script:WorkspacePreparationMarkerName
    if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
        try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json }
        catch { throw "Invalid workspace-preparation ownership marker: $markerPath" }
        return [string]::Equals([string]$marker.transactionId, $TransactionId, [StringComparison]::Ordinal)
    }
    return @(Get-ChildItem -LiteralPath $TargetPath -Force).Count -eq 0
}

function Restore-WorkspacePreparationActiveJob {
    param(
        [Parameter(Mandatory)] $Journal,
        [Parameter(Mandatory)] [string]$ActiveJobPath
    )
    if ([bool]$Journal.activeJobInitiallyExisted) {
        $bytes = [Convert]::FromBase64String([string]$Journal.activeJobInitialBase64)
        $temporary = '{0}.restore-{1}-{2}' -f $ActiveJobPath, $PID, ([Guid]::NewGuid().ToString('N'))
        try {
            [IO.File]::WriteAllBytes($temporary, $bytes)
            [IO.File]::Move($temporary, $ActiveJobPath, $true)
        } finally {
            try { [IO.File]::Delete($temporary) } catch { [void]$_.Exception }
        }
        return
    }
    if (-not (Test-Path -LiteralPath $ActiveJobPath -PathType Leaf)) { return }
    try { $active = Get-Content -LiteralPath $ActiveJobPath -Raw | ConvertFrom-Json }
    catch { throw "Cannot safely remove an unreadable active-job file during recovery: $ActiveJobPath" }
    if (-not [string]::Equals(
        (Get-WorkspacePreparationFullPath -Path ([string]$active.jobPath)),
        (Get-WorkspacePreparationFullPath -Path ([string]$Journal.jobPath)),
        [StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Active-job file belongs to another job and cannot be removed during recovery: $ActiveJobPath"
    }
    Remove-Item -LiteralPath $ActiveJobPath -Force
}

function Recover-WorkspacePreparationTransaction {
    param(
        [Parameter(Mandatory)] [string]$JournalPath,
        [Parameter(Mandatory)] [string]$AllowedWorkspaceParent,
        [Parameter(Mandatory)] [string]$AllowedJobsRoot,
        [Parameter(Mandatory)] [string]$ExpectedActiveJobPath
    )
    if (-not (Test-Path -LiteralPath $JournalPath -PathType Leaf)) {
        return [pscustomobject]@{ Recovered = $false; Phase = 'none'; TransactionId = '' }
    }
    $journal = Read-WorkspacePreparationJournal -JournalPath $JournalPath
    $targets = Assert-WorkspacePreparationJournalTargets `
        -Journal $journal `
        -AllowedWorkspaceParent $AllowedWorkspaceParent `
        -AllowedJobsRoot $AllowedJobsRoot `
        -ExpectedActiveJobPath $ExpectedActiveJobPath

    if ([string]$journal.phase -eq 'committed') {
        foreach ($target in @($targets.WorkspaceRoot, $targets.JobPath)) {
            $markerPath = Join-Path $target $script:WorkspacePreparationMarkerName
            if (Test-Path -LiteralPath $markerPath) {
                Remove-Item -LiteralPath $markerPath -Force -ErrorAction Stop
            }
        }
        Remove-Item -LiteralPath $JournalPath -Force
        return [pscustomobject]@{ Recovered = $true; Phase = 'committed-cleanup'; TransactionId = [string]$journal.transactionId }
    }

    Restore-WorkspacePreparationActiveJob -Journal $journal -ActiveJobPath $targets.ActiveJobPath
    foreach ($target in @($targets.JobPath, $targets.WorkspaceRoot)) {
        if (-not (Test-WorkspacePreparationOwnedTarget -TargetPath $target -TransactionId ([string]$journal.transactionId))) {
            throw "Refusing to remove a workspace-preparation target without its ownership marker: $target"
        }
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
    }
    Remove-Item -LiteralPath $JournalPath -Force
    return [pscustomobject]@{ Recovered = $true; Phase = 'rolled-back'; TransactionId = [string]$journal.transactionId }
}

function Complete-WorkspacePreparationTransaction {
    param([Parameter(Mandatory)] [string]$JournalPath)
    $journal = Set-WorkspacePreparationTransactionPhase -JournalPath $JournalPath -Phase 'committed'
    $cleanupErrors = @()
    foreach ($target in @([string]$journal.workspaceRoot, [string]$journal.jobPath)) {
        $markerPath = Join-Path $target $script:WorkspacePreparationMarkerName
        try {
            if (Test-Path -LiteralPath $markerPath) {
                Remove-Item -LiteralPath $markerPath -Force -ErrorAction Stop
            }
        }
        catch { $cleanupErrors += $_.Exception.Message }
    }
    try { Remove-Item -LiteralPath $JournalPath -Force }
    catch { $cleanupErrors += $_.Exception.Message }
    if ($cleanupErrors.Count) {
        Write-Warning (
            'Workspace preparation committed; cleanup is deferred to the next run: ' +
            ($cleanupErrors -join '; ')
        )
    }
    return [pscustomobject]@{
        TransactionId = [string]$journal.transactionId
        Phase = if ($cleanupErrors.Count) { 'committed-pending-cleanup' } else { 'committed' }
    }
}

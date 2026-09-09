$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$modulePath = Join-Path $projectRoot '02 Translate Text\Code\WorkspacePreparationTransaction.ps1'
. $modulePath

function Assert-Condition {
    param([Parameter(Mandatory)] [bool]$Condition, [Parameter(Mandatory)] [string]$Message)
    if (-not $Condition) { throw $Message }
}

$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('translate-workspace-transaction-' + [Guid]::NewGuid().ToString('N'))
$productsRoot = Join-Path $testRoot 'Products'
$jobsRoot = Join-Path $testRoot 'Jobs'
$stateRoot = Join-Path $testRoot 'State'
$activeJobPath = Join-Path $stateRoot 'Active Job.json'
$journalPath = Join-Path $stateRoot 'prepare.transaction.json'
[IO.Directory]::CreateDirectory($productsRoot) | Out-Null
[IO.Directory]::CreateDirectory($jobsRoot) | Out-Null
[IO.Directory]::CreateDirectory($stateRoot) | Out-Null

try {
    $workspace = Join-Path $productsRoot 'Book\Interiors\French'
    $job = Join-Path $jobsRoot 'Book\French\job-1'
    [void](Start-WorkspacePreparationTransaction -JournalPath $journalPath -WorkspaceRoot $workspace -JobPath $job -ActiveJobPath $activeJobPath)
    [void](Initialize-WorkspacePreparationTargets -JournalPath $journalPath)
    [void](Set-WorkspacePreparationTransactionPhase -JournalPath $journalPath -Phase 'preparing')
    [IO.File]::WriteAllText((Join-Path $workspace 'partial.indd'), 'partial')
    [IO.File]::WriteAllText((Join-Path $job 'partial.json'), '{}')
    Write-WorkspacePreparationJsonAtomic -Path $activeJobPath -Value ([ordered]@{ jobPath = $job })
    $rolledBack = Recover-WorkspacePreparationTransaction `
        -JournalPath $journalPath `
        -AllowedWorkspaceParent $productsRoot `
        -AllowedJobsRoot $jobsRoot `
        -ExpectedActiveJobPath $activeJobPath
    Assert-Condition ($rolledBack.Phase -eq 'rolled-back') 'Interrupted preparation did not report rollback.'
    Assert-Condition (-not (Test-Path -LiteralPath $workspace)) 'Interrupted workspace survived rollback.'
    Assert-Condition (-not (Test-Path -LiteralPath $job)) 'Interrupted job survived rollback.'
    Assert-Condition (-not (Test-Path -LiteralPath $activeJobPath)) 'Interrupted active-job pointer survived rollback.'

    $workspace = Join-Path $productsRoot 'Book\Interiors\Spanish'
    $job = Join-Path $jobsRoot 'Book\Spanish\job-2'
    [void](Start-WorkspacePreparationTransaction -JournalPath $journalPath -WorkspaceRoot $workspace -JobPath $job -ActiveJobPath $activeJobPath)
    [void](Initialize-WorkspacePreparationTargets -JournalPath $journalPath)
    [IO.File]::WriteAllText((Join-Path $workspace 'complete.indd'), 'complete')
    [IO.File]::WriteAllText((Join-Path $job 'job_config.json'), '{}')
    $committed = Complete-WorkspacePreparationTransaction -JournalPath $journalPath
    Assert-Condition ($committed.Phase -eq 'committed') 'Preparation did not report commit.'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $workspace 'complete.indd')) 'Committed workspace was removed.'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $job 'job_config.json')) 'Committed job was removed.'
    Assert-Condition (-not (Test-Path -LiteralPath $journalPath)) 'Committed journal was not cleaned up.'

    $workspace = Join-Path $productsRoot 'Book\Interiors\German'
    $job = Join-Path $jobsRoot 'Book\German\job-3'
    [void](Start-WorkspacePreparationTransaction -JournalPath $journalPath -WorkspaceRoot $workspace -JobPath $job -ActiveJobPath $activeJobPath)
    [void](Initialize-WorkspacePreparationTargets -JournalPath $journalPath)
    [IO.File]::WriteAllText((Join-Path $workspace 'committed-before-cleanup.indd'), 'complete')
    [void](Set-WorkspacePreparationTransactionPhase -JournalPath $journalPath -Phase 'committed')
    $cleaned = Recover-WorkspacePreparationTransaction `
        -JournalPath $journalPath `
        -AllowedWorkspaceParent $productsRoot `
        -AllowedJobsRoot $jobsRoot `
        -ExpectedActiveJobPath $activeJobPath
    Assert-Condition ($cleaned.Phase -eq 'committed-cleanup') 'Committed recovery did not enter cleanup mode.'
    Assert-Condition (Test-Path -LiteralPath (Join-Path $workspace 'committed-before-cleanup.indd')) 'Committed recovery removed workspace output.'
    Assert-Condition (Test-Path -LiteralPath $job -PathType Container) 'Committed recovery removed the job directory.'

    foreach ($variant in @('foreign-pointer', 'unowned-target', 'invalid-phase', 'foreign-committed-marker', 'appeared-target')) {
        $workspace = Join-Path $productsRoot ('review-' + $variant)
        $job = Join-Path $jobsRoot ('review-' + $variant)
        Write-WorkspacePreparationJsonAtomic -Path $activeJobPath -Value @{ jobPath = (Join-Path $jobsRoot 'previous') }
        [void](Start-WorkspacePreparationTransaction -JournalPath $journalPath -WorkspaceRoot $workspace -JobPath $job -ActiveJobPath $activeJobPath)
        if ($variant -eq 'appeared-target') {
            [IO.Directory]::CreateDirectory($job) | Out-Null
            [IO.File]::WriteAllText((Join-Path $job 'user.txt'), 'retain')
            $failed = $false
            try { Initialize-WorkspacePreparationTargets -JournalPath $journalPath | Out-Null } catch { $failed = $true }
            Assert-Condition $failed 'Initialization adopted a foreign target.'
            Assert-Condition (-not (Test-Path -LiteralPath $workspace)) 'Initialization changed the first target before checking the second.'
        } else {
            [void](Initialize-WorkspacePreparationTargets -JournalPath $journalPath)
            [IO.File]::WriteAllText((Join-Path $workspace 'user.txt'), 'retain')
            [IO.File]::WriteAllText((Join-Path $job 'user.txt'), 'retain')
            if ($variant -eq 'foreign-pointer') {
                Write-WorkspacePreparationJsonAtomic -Path $activeJobPath -Value @{ jobPath = (Join-Path $jobsRoot 'other-active') }
            } elseif ($variant -eq 'unowned-target') {
                Remove-Item -LiteralPath (Join-Path $workspace $script:WorkspacePreparationMarkerName)
            } elseif ($variant -eq 'foreign-committed-marker') {
                [void](Set-WorkspacePreparationTransactionPhase -JournalPath $journalPath -Phase 'committed')
                Write-WorkspacePreparationJsonAtomic -Path (Join-Path $job $script:WorkspacePreparationMarkerName) -Value @{ transactionId = 'another-owner' }
            } else {
                $journal = Read-WorkspacePreparationJournal -JournalPath $journalPath
                $journal.phase = 'unknown'
                Write-WorkspacePreparationJsonAtomic -Path $journalPath -Value $journal
            }
            $activeBefore = [IO.File]::ReadAllText($activeJobPath)
            $failed = $false
            try {
                Recover-WorkspacePreparationTransaction -JournalPath $journalPath -AllowedWorkspaceParent $productsRoot `
                    -AllowedJobsRoot $jobsRoot -ExpectedActiveJobPath $activeJobPath | Out-Null
            } catch { $failed = $true }
            Assert-Condition $failed "Unsafe recovery did not fail: $variant"
            Assert-Condition ([IO.File]::ReadAllText($activeJobPath) -ceq $activeBefore) "Recovery changed the active pointer: $variant"
            Assert-Condition (Test-Path -LiteralPath (Join-Path $workspace 'user.txt')) "Recovery deleted the workspace: $variant"
            Assert-Condition (Test-Path -LiteralPath (Join-Path $job 'user.txt')) "Recovery partially deleted the job: $variant"
        }
        Assert-Condition (Test-Path -LiteralPath $journalPath) "Recovery discarded evidence: $variant"
        Remove-Item -LiteralPath $journalPath
    }
    Write-Output 'WORKSPACE_TRANSACTION_TEST_OK|cases=8'
} finally {
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedTestRoot.StartsWith($resolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a test directory outside the temp root: $resolvedTestRoot"
    }
    if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}

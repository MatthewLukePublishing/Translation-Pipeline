[CmdletBinding()]
param(
    [ValidateSet('New', 'Prepare', 'Export', 'Translate', 'Validate', 'Import', 'Finalize', 'Complete', 'Activate', 'Deactivate', 'Status', 'Archive')]
    [string]$Action = 'Status',

    [string]$Book,
    [string]$Language,
    [string]$GlossaryProfile,
    [string]$GlossaryAcronymsPath,
    [string]$GlossaryWordsPath,
    [string]$JobId,
    [string]$EditionName,
    [string]$InteriorsPath,
    [string]$WorkspacePath,
    [string]$ProductsRoot,
    [string]$LayoutSettingsPath,
    [ValidateSet('CodexSubscription')]
    [string]$Provider = 'CodexSubscription',
    [string]$Model = 'latest',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')]
    [string]$ReasoningEffort = 'xhigh',
    [ValidateRange(1, 1000)]
    [int]$MaxBatches,
    [switch]$Force
)

$script:ProductsRootArgument = $ProductsRoot
$ErrorActionPreference = 'Stop'
$maxBatchesSpecified = $PSBoundParameters.ContainsKey('MaxBatches')
$programRoot = $PSScriptRoot
$stageTwoRoot = Join-Path $programRoot '02 Translate Text'
$jobsRoot = Join-Path $stageTwoRoot 'Jobs'
$activeJobPath = Join-Path $stageTwoRoot 'Active Job.json'
$subscriptionTranslatorPath = Join-Path $stageTwoRoot 'Code\Translate_ICML_Codex_Subscription.mjs'
$originManifestCreatorPath = Join-Path $stageTwoRoot 'Code\Create-OriginJobManifest.mjs'
$validatorPath = Join-Path $stageTwoRoot 'Code\Validation\Validate_Translation_Job.js'
$transactionalImporterPath = Join-Path $stageTwoRoot 'Code\Import_Translation_Workbook.mjs'
$protectedSourcePath = Join-Path $stageTwoRoot 'Code\Apply-ProtectedSourceSections.mjs'
$workspacePreparerPath = Join-Path $stageTwoRoot 'Code\Prepare-TranslationWorkspace.ps1'
$pathSafetyPath = Join-Path $stageTwoRoot 'Code\TranslationPathSafety.ps1'
$fileUtilitiesPath = Join-Path $programRoot 'Code\TranslationFileUtilities.ps1'
$jobArchivePath = Join-Path $programRoot 'Code\TranslationJobArchive.ps1'
$latestModelResolverPath = Join-Path $stageTwoRoot 'Code\Resolve-LatestSubscriptionModel.mjs'
$inDesignRunnerPath = Join-Path $stageTwoRoot 'Code\InDesign\Invoke-InDesignTranslationDocument.ps1'
$translationStyleSetterPath = Join-Path $stageTwoRoot 'Code\InDesign\Set-InDesignTranslationStyles.ps1'
$typographyAuditPath = Join-Path $stageTwoRoot 'Code\InDesign\Get-InDesignTypographyAudit.ps1'
$glossariesRoot = Join-Path $programRoot '01 Translate Glossaries'
$glossaryMapPath = Join-Path $glossariesRoot 'book_glossary_map.json'
$archiveRoot = Join-Path $programRoot '_Archive\Translation Jobs'
$requiredSubscriptionReasoningEffort = 'xhigh'
$codexDependencyRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$codexNodePath = Join-Path $codexDependencyRoot 'bin\node.exe'
$artifactNodeModulesPath = Join-Path $codexDependencyRoot 'node_modules'
$artifactToolPackagePath = Join-Path $artifactNodeModulesPath '@oai\artifact-tool\package.json'
if (-not (Test-Path -LiteralPath $pathSafetyPath -PathType Leaf)) { throw "Missing path-safety utility: $pathSafetyPath" }
. $pathSafetyPath
if (-not (Test-Path -LiteralPath $fileUtilitiesPath -PathType Leaf)) { throw "Missing file utility: $fileUtilitiesPath" }
. $fileUtilitiesPath
if (-not (Test-Path -LiteralPath $jobArchivePath -PathType Leaf)) { throw "Missing archive utility: $jobArchivePath" }
. $jobArchivePath

function Get-ConfiguredProductsRoot {
    return Resolve-TranslationProductsRoot -ExplicitPath $script:ProductsRootArgument -ProgramRoot $programRoot
}

function Resolve-LatestSubscriptionModel {
    $nodePath = Resolve-NodePath
    if (-not (Test-Path -LiteralPath $latestModelResolverPath -PathType Leaf)) {
        throw "Missing latest-model resolver: $latestModelResolverPath"
    }
    $output = & $nodePath $latestModelResolverPath
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the current official frontier model; translation will not use a stale fallback.' }
    try { $resolution = ($output -join [Environment]::NewLine) | ConvertFrom-Json }
    catch { throw "Latest-model resolver returned invalid JSON: $($_.Exception.Message)" }
    if ([string]$resolution.policy -ne 'official_latest_frontier' -or -not [string]$resolution.model) {
        throw 'Latest-model resolver returned an invalid policy or blank model.'
    }
    return $resolution
}

function Assert-LatestSubscriptionRequest {
    param(
        [Parameter(Mandatory)] [string]$SelectedProvider,
        [Parameter(Mandatory)] [string]$SelectedModel,
        [Parameter(Mandatory)] [string]$SelectedReasoningEffort
    )
    if ($SelectedProvider -ne 'CodexSubscription') { return }
    if ($SelectedModel -ne 'latest' -or $SelectedReasoningEffort -ne $requiredSubscriptionReasoningEffort) {
        throw "CodexSubscription requires model policy 'latest' with reasoning effort '$requiredSubscriptionReasoningEffort'."
    }
}

function Read-GlossaryJson {
    param([Parameter(Mandatory)] [string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing glossary JSON: $Path" }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable }
    catch { throw "Could not parse glossary JSON ${Path}: $($_.Exception.Message)" }
}

function ConvertTo-SafePathPart {
    param([Parameter(Mandatory)] [string]$Value)
    $safe = ($Value.Trim() -replace '[^A-Za-z0-9._-]+', '_').Trim('_')
    if (-not $safe) { throw "Value cannot be converted to a safe path component: $Value" }
    return $safe
}

function Get-ActiveJob {
    $active = Read-JsonFile -Path $activeJobPath -Label 'active-job configuration'
    $jobPath = [IO.Path]::GetFullPath([string]$active.jobPath)
    $configPath = Join-Path $jobPath 'job_config.json'
    $config = Read-JsonFile -Path $configPath -Label 'job configuration'
    if (-not [string]::Equals([IO.Path]::GetFullPath([string]$config.jobPath), $jobPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Active-job pointer and job configuration disagree: $activeJobPath"
    }
    if ($config.productionWorkspace) {
        $productsRoot = Get-ConfiguredProductsRoot
        $workspaceRoot = Assert-PathWithin -Path ([string]$config.productionWorkspace.root) -Parent $productsRoot -Label 'Production workspace'
        $expectedJobPath = Join-Path $workspaceRoot 'Translation Job'
        $jobsPrefix = [IO.Path]::GetFullPath($jobsRoot).TrimEnd('\') + '\'
        $isLegacyWorkspaceJob = [string]::Equals([IO.Path]::GetFullPath($expectedJobPath), $jobPath, [StringComparison]::OrdinalIgnoreCase)
        $isCentralJob = $jobPath.StartsWith($jobsPrefix, [StringComparison]::OrdinalIgnoreCase)
        if (-not $isLegacyWorkspaceJob -and -not $isCentralJob) {
            throw "Production job is outside the central Jobs folder and its configured legacy workspace: $jobPath"
        }
    } else {
        $jobPath = Assert-PathWithin -Path $jobPath -Parent $jobsRoot -Label 'Active job'
    }
    return [pscustomobject]@{ Active = $active; Config = $config; JobPath = $jobPath }
}

function Find-ProductionJobForWorkspace {
    param([Parameter(Mandatory)] [string]$WorkspacePath)
    $resolvedWorkspace = [IO.Path]::GetFullPath($WorkspacePath)
    $legacyJob = Join-Path $resolvedWorkspace 'Translation Job'
    if (Test-Path -LiteralPath (Join-Path $legacyJob 'job_config.json') -PathType Leaf) { return $legacyJob }
    $matches = @()
    if (Test-Path -LiteralPath $jobsRoot -PathType Container) {
        foreach ($candidate in Get-ChildItem -LiteralPath $jobsRoot -Recurse -File -Filter 'job_config.json') {
            try {
                $candidateConfig = Read-JsonFile -Path $candidate.FullName -Label 'candidate production job configuration'
                if ($candidateConfig.productionWorkspace -and
                    [string]::Equals([IO.Path]::GetFullPath([string]$candidateConfig.productionWorkspace.root), $resolvedWorkspace, [StringComparison]::OrdinalIgnoreCase)) {
                    $matches += $candidate.Directory.FullName
                }
            } catch {
                Write-Verbose "Skipping invalid job configuration $($candidate.FullName): $($_.Exception.Message)"
            }
        }
    }
    if ($matches.Count -ne 1) {
        throw "Expected one translation job for workspace '$resolvedWorkspace'; found $($matches.Count)."
    }
    return $matches[0]
}

function Get-ValidatedProductionWorkspace {
    param([Parameter(Mandatory)] $Config)

    $workspaceRoot = [IO.Path]::GetFullPath([string]$Config.productionWorkspace.root)
    $documentPath = [IO.Path]::GetFullPath([string]$Config.productionWorkspace.documentPath)
    if (-not [string]::Equals((Split-Path -Parent $documentPath), $workspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The production INDD must be stored at the translation workspace root: $documentPath"
    }
    foreach ($requiredFolder in @('Text', 'Diagrams')) {
        $requiredPath = Join-Path $workspaceRoot $requiredFolder
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Container)) { throw "Missing required production folder: $requiredPath" }
    }
    return [pscustomobject]@{ WorkspaceRoot = $workspaceRoot; DocumentPath = $documentPath }
}

function Resolve-NodePath {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if (-not $command) { throw 'Node.js was not found on PATH.' }
    return $command.Source
}

function Invoke-NodeScript {
    param([Parameter(Mandatory)] [string]$Script, [Parameter(Mandatory)] [string]$JobPath)
    $nodePath = Resolve-NodePath
    & $nodePath $Script '--job' $JobPath
    if ($LASTEXITCODE -ne 0) { throw "Node process failed with exit code ${LASTEXITCODE}: $Script" }
}

function Invoke-SubscriptionTranslator {
    param([Parameter(Mandatory)] [string]$JobPath)
    $codexCli = Join-Path $env:APPDATA 'npm\node_modules\@openai\codex\bin\codex.js'
    foreach ($required in @($codexNodePath, $artifactToolPackagePath, $codexCli, $subscriptionTranslatorPath)) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Missing Codex subscription runtime component: $required" }
    }

    $priorArtifactModules = $env:CODEX_ARTIFACT_NODE_MODULES
    $priorCodexCli = $env:CODEX_CLI_JS
    $priorCodexNode = $env:CODEX_NODE_EXE
    try {
        $env:CODEX_ARTIFACT_NODE_MODULES = $artifactNodeModulesPath
        $env:CODEX_CLI_JS = $codexCli
        $env:CODEX_NODE_EXE = $codexNodePath
        $arguments = @($subscriptionTranslatorPath, '--job', $JobPath)
        if ($script:maxBatchesSpecified -and $MaxBatches -gt 0) {
            $arguments += @('--max-batches', [string]$MaxBatches)
        }
        & $codexNodePath @arguments
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 2) {
            Write-Output "TRANSLATION_PAUSED|job=$JobPath"
            return $false
        }
        if ($exitCode -ne 0) { throw "Codex subscription translator failed with exit code $exitCode." }
        return $true
    } finally {
        $env:CODEX_ARTIFACT_NODE_MODULES = $priorArtifactModules
        $env:CODEX_CLI_JS = $priorCodexCli
        $env:CODEX_NODE_EXE = $priorCodexNode
    }
}

function Invoke-ProtectedSourcePolicy {
    param([Parameter(Mandatory)] [string]$JobPath)
    if (-not (Test-Path -LiteralPath $artifactNodeModulesPath -PathType Container)) {
        throw "Missing artifact-tool runtime: $artifactNodeModulesPath"
    }
    foreach ($required in @($codexNodePath, $artifactToolPackagePath, $protectedSourcePath)) {
        if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing protected-source component: $required" }
    }
    $priorArtifactModules = $env:CODEX_ARTIFACT_NODE_MODULES
    try {
        $env:CODEX_ARTIFACT_NODE_MODULES = $artifactNodeModulesPath
        & $codexNodePath $protectedSourcePath '--job' $JobPath '--workbook-only'
        if ($LASTEXITCODE -ne 0) { throw "Protected-source policy failed with exit code $LASTEXITCODE." }
    } finally {
        $env:CODEX_ARTIFACT_NODE_MODULES = $priorArtifactModules
    }
}

function Resolve-GlossaryFile {
    param(
        [string]$ExplicitPath,
        [string]$MappedPath,
        [Parameter(Mandatory)] [string]$Kind
    )
    if ($ExplicitPath) {
        $resolved = [IO.Path]::GetFullPath($ExplicitPath)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Missing $Kind glossary: $resolved" }
        return $resolved
    }
    if (-not $MappedPath) { throw "The book/glossary map has no $Kind runtime path." }
    $resolved = Assert-PathWithin -Path (Join-Path $programRoot $MappedPath) -Parent $programRoot -Label "$Kind glossary"
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { throw "Missing $Kind glossary: $resolved" }
    return $resolved
}

function Test-GlossaryProfile {
    param([Parameter(Mandatory)] [string]$Path, [Parameter(Mandatory)] [string]$TermKey)
    $payload = Read-GlossaryJson -Path $Path
    if ($payload.Count -eq 0) { return }
    $found = $false
    foreach ($entry in $payload.Values) {
        if ($entry -is [Collections.IDictionary] -and $entry.Contains($TermKey)) {
            $value = [string]$entry[$TermKey]
            if ($value.Trim()) { $found = $true; break }
        }
    }
    if (-not $found) { throw "Glossary profile field '$TermKey' was not found with a populated value in $Path" }
}

function Test-GlossaryFieldPresent {
    param([Parameter(Mandatory)] [string]$Path, [Parameter(Mandatory)] [string]$Field)
    $payload = Read-GlossaryJson -Path $Path
    foreach ($entry in $payload.Values) {
        if ($entry -is [Collections.IDictionary] -and $entry.Contains($Field)) {
            if ([string]$entry[$Field]) { return $true }
        }
    }
    return $false
}

function Get-NamedProperty {
    param(
        [Parameter(Mandatory)] $Object,
        [Parameter(Mandatory)] [string]$Name,
        [Parameter(Mandatory)] [string]$Label
    )
    $property = @($Object.PSObject.Properties | Where-Object {
        $_.Name.Equals($Name, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($property.Count -ne 1) { throw "$Label not found: $Name" }
    return [pscustomobject]@{ Name = $property[0].Name; Value = $property[0].Value }
}

function Get-GlossarySelection {
    param([Parameter(Mandatory)] [string]$RequestedBook, [Parameter(Mandatory)] [string]$RequestedLanguage)
    $map = Read-JsonFile -Path $glossaryMapPath -Label 'book/glossary map'
    if ([int]$map.schemaVersion -ne 1 -or [int]$map.glossaryContractVersion -ne 2) {
        throw "Unsupported glossary map version: $glossaryMapPath"
    }
    $bookProperty = Get-NamedProperty -Object $map.books -Name $RequestedBook -Label 'Book mapping'
    $bookConfig = $bookProperty.Value

    $effectiveProfile = $GlossaryProfile
    if (-not $effectiveProfile) {
        $defaultProperty = @($bookConfig.defaultProfiles.PSObject.Properties | Where-Object {
            $_.Name.Equals($RequestedLanguage, [StringComparison]::OrdinalIgnoreCase)
        })
        if ($defaultProperty.Count -gt 0) { $effectiveProfile = [string]$defaultProperty[0].Value }
        else { $effectiveProfile = $RequestedLanguage }
    }
    $supportedProfile = @($bookConfig.supportedProfiles | Where-Object {
        ([string]$_).Equals($effectiveProfile, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($supportedProfile.Count -ne 1) {
        throw "Glossary profile '$effectiveProfile' is not supported for $($bookProperty.Name). Supported profiles: $($bookConfig.supportedProfiles -join ', ')"
    }
    $profileProperty = Get-NamedProperty -Object $map.profiles -Name ([string]$supportedProfile[0]) -Label 'Glossary profile'
    $glossaryProfileConfig = $profileProperty.Value
    if (-not ([string]$glossaryProfileConfig.language).Equals($RequestedLanguage, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Glossary profile '$($profileProperty.Name)' is for $($glossaryProfileConfig.language), not $RequestedLanguage."
    }

    return [pscustomobject]@{
        Map = $map
        Book = $bookProperty.Name
        BookConfig = $bookConfig
        Profile = $profileProperty.Name
        TermKey = [string]$glossaryProfileConfig.termKey
        DefinitionKey = [string]$glossaryProfileConfig.definitionKey
    }
}

function Initialize-TranslationJob {
    Assert-LatestSubscriptionRequest -SelectedProvider $Provider -SelectedModel $Model -SelectedReasoningEffort $ReasoningEffort
    $modelResolution = if ($Provider -eq 'CodexSubscription') { Resolve-LatestSubscriptionModel } else { $null }
    $effectiveModel = if ($modelResolution) { [string]$modelResolution.model } else { $Model }
    if (-not $Book) { throw '-Book is required for -Action New.' }
    if (-not $Language) { throw '-Language is required for -Action New.' }

    [IO.Directory]::CreateDirectory($jobsRoot) | Out-Null
    if (Test-Path -LiteralPath $activeJobPath -PathType Leaf) {
        $existing = Read-JsonFile -Path $activeJobPath -Label 'active-job configuration'
        throw "An active translation job already exists: $($existing.jobPath). Archive it before creating another job."
    }

    $selection = Get-GlossarySelection -RequestedBook $Book -RequestedLanguage $Language
    $Book = $selection.Book
    $effectiveProfile = $selection.Profile
    $keys = [pscustomobject]@{ Term = $selection.TermKey; Definition = $selection.DefinitionKey }

    $safeBook = ConvertTo-SafePathPart $Book
    $safeLanguage = ConvertTo-SafePathPart $Language
    $effectiveJobId = $JobId
    if (-not $effectiveJobId) {
        $effectiveJobId = '{0}_{1}_{2}' -f $safeBook, $safeLanguage, (Get-Date -Format 'yyyyMMdd_HHmmss')
    }
    $effectiveJobId = ConvertTo-SafePathPart $effectiveJobId
    $jobPath = Join-Path (Join-Path (Join-Path $jobsRoot $safeBook) $safeLanguage) $effectiveJobId
    $jobPath = Assert-PathWithin -Path $jobPath -Parent $jobsRoot -Label 'New job'
    if (Test-Path -LiteralPath $jobPath) { throw "Job already exists: $jobPath" }

    $acronymSource = Resolve-GlossaryFile -ExplicitPath $GlossaryAcronymsPath `
        -MappedPath ([string]$selection.BookConfig.runtime.acronyms) -Kind 'acronym'
    $wordsSource = Resolve-GlossaryFile -ExplicitPath $GlossaryWordsPath `
        -MappedPath ([string]$selection.BookConfig.runtime.words) -Kind 'word'

    $originWorkbook = Assert-PathWithin -Path (Join-Path $programRoot ([string]$selection.BookConfig.originWorkbook)) `
        -Parent $programRoot -Label 'Origin workbook'
    $originArchive = Assert-PathWithin -Path (Join-Path $programRoot ([string]$selection.BookConfig.originArchive)) `
        -Parent $programRoot -Label 'Origin ICML archive'
    if (-not (Test-Path -LiteralPath $originWorkbook -PathType Leaf)) { throw "Missing Origin workbook: $originWorkbook" }
    if (-not (Test-Path -LiteralPath $originArchive -PathType Leaf)) { throw "Missing Origin ICML archive: $originArchive" }

    if ($acronymSource) {
        Test-GlossaryProfile -Path $acronymSource -TermKey $keys.Term
    }
    if ($wordsSource) {
        Test-GlossaryProfile -Path $wordsSource -TermKey $keys.Term
    }

    $selectedGlossaries = @($acronymSource, $wordsSource) | Where-Object { $_ }
    $definitionFound = @($selectedGlossaries | Where-Object {
        Test-GlossaryFieldPresent -Path $_ -Field $keys.Definition
    }).Count -gt 0
    if (-not $definitionFound -and
        ($effectiveProfile.Equals($Language, [StringComparison]::OrdinalIgnoreCase) -or
         $effectiveProfile.Equals("$Language Current", [StringComparison]::OrdinalIgnoreCase))) {
        $legacyDefinitionKeys = @{
            French = '_1'; Spanish = '_2'; German = '_3'; Portuguese = '_4'; Italian = '_5'
            Polish = '_6'; Dutch = '_7'; Turkish = '_8'; Swedish = '_9'
        }
        $legacyKey = [string]$legacyDefinitionKeys[$Language]
        if ($legacyKey -and @($selectedGlossaries | Where-Object {
            Test-GlossaryFieldPresent -Path $_ -Field $legacyKey
        }).Count -gt 0) {
            $keys.Definition = $legacyKey
            $definitionFound = $true
        }
    }
    if (-not $definitionFound) {
        Write-Warning "No populated glossary definition field '$($keys.Definition)' was found. Term enforcement will still be applied."
    }

    foreach ($relative in @('input', 'glossary', 'output', 'reports', 'state')) {
        [IO.Directory]::CreateDirectory((Join-Path $jobPath $relative)) | Out-Null
    }
    if ($acronymSource) {
        Copy-Item -LiteralPath $acronymSource -Destination (Join-Path $jobPath 'glossary\acronyms.json')
    }
    if ($wordsSource) {
        Copy-Item -LiteralPath $wordsSource -Destination (Join-Path $jobPath 'glossary\words.json')
    }
    if (-not $acronymSource -and -not $wordsSource) {
        Write-Warning "No JSON glossary snapshot was found for $Book. The job was created without a glossary."
    }

    $now = [DateTime]::UtcNow.ToString('o')
    $config = [ordered]@{
        schemaVersion = 1
        jobId = $effectiveJobId
        jobPath = $jobPath
        book = $Book
        targetLanguage = $Language
        glossaryFamily = [string]$selection.BookConfig.family
        glossaryContractVersion = [int]$selection.Map.glossaryContractVersion
        glossaryProfile = $effectiveProfile
        glossaryTermKey = $keys.Term
        glossaryDefinitionKey = $keys.Definition
        translationProvider = $Provider
        model = $effectiveModel
        reasoningEffort = $ReasoningEffort
        createdAt = $now
        glossarySources = [ordered]@{
            acronyms = $acronymSource
            words = $wordsSource
        }
        originSources = [ordered]@{
            contentWorkbook = $originWorkbook
            icmlArchive = $originArchive
        }
        paths = [ordered]@{
            inputWorkbook = Join-Path $jobPath 'input\content_export.xlsx'
            outputWorkbook = Join-Path $jobPath 'output\content_import.xlsx'
            reports = Join-Path $jobPath 'reports'
            state = Join-Path $jobPath 'state'
        }
    }
    if ($modelResolution) {
        $config['modelPolicy'] = 'official_latest_frontier'
        $config['modelResolution'] = $modelResolution
    }
    Write-Utf8Json -Path (Join-Path $jobPath 'job_config.json') -Value $config
    Write-Utf8Json -Path $activeJobPath -Value ([ordered]@{
        schemaVersion = 1
        jobId = $effectiveJobId
        jobPath = $jobPath
        book = $Book
        targetLanguage = $Language
        glossaryFamily = [string]$selection.BookConfig.family
        glossaryProfile = $effectiveProfile
        activatedAt = $now
    })

    Write-Output "ACTIVE_JOB_CREATED|job=$jobPath|book=$Book|language=$Language|profile=$effectiveProfile|model=$effectiveModel"
    Write-Output 'Next: save a checkpoint of the InDesign document, then run Export All Content to Excel.jsx from the Scripts panel.'
}

function Invoke-Translation {
    $job = Get-ActiveJob
    $manifestPath = Join-Path $job.JobPath 'job_manifest.json'
    $manifest = Read-JsonFile -Path $manifestPath -Label 'job manifest'
    if ([string]$manifest.status -notin @('exported', 'translating', 'translation_failed', 'qa_failed', 'ready_for_import')) {
        throw "Job is not ready for translation. Current manifest status: $($manifest.status)"
    }
    $effectiveProvider = [string]$job.Config.translationProvider
    if (-not $effectiveProvider) { $effectiveProvider = 'CodexSubscription' }
    if ($effectiveProvider -ne 'CodexSubscription') {
        throw "Unsupported translation provider '$effectiveProvider'. Paid API translation has been retired."
    }
    if ([string]$job.Config.modelPolicy -ne 'official_latest_frontier' -or [string]$job.Config.reasoningEffort -ne $requiredSubscriptionReasoningEffort) {
        throw "CodexSubscription jobs require the official latest-frontier model policy with reasoning effort '$requiredSubscriptionReasoningEffort'."
    }
    $completed = Invoke-SubscriptionTranslator -JobPath $job.JobPath
    if (-not $completed) { return }
    if ($job.Config.productionWorkspace -and [string]$job.Config.protectedSourceContentManifest) {
        Invoke-ProtectedSourcePolicy -JobPath $job.JobPath
    }
    Invoke-NodeScript -Script $validatorPath -JobPath $job.JobPath
    Write-Output "TRANSLATION_READY_FOR_IMPORT|job=$($job.JobPath)"
    if ($job.Config.productionWorkspace) {
        Write-Output 'Next: run Run-Translation-Job.ps1 -Action Import to update the isolated ICML and save the production INDD.'
    } else {
        Write-Output 'Next: run Import All Content from Excel.jsx from the InDesign Scripts panel.'
    }
}

function Initialize-ProductionWorkspace {
    if (-not $Book) { throw '-Book is required for -Action Prepare.' }
    if (-not $Language) { throw '-Language is required for -Action Prepare.' }
    if (-not $EditionName) { throw '-EditionName is required for -Action Prepare.' }
    if ($Provider -ne 'CodexSubscription') {
        throw 'Production workspaces require CodexSubscription; paid API translation is disabled for this workflow.'
    }
    $null = Assert-LatestSubscriptionRequest -SelectedProvider $Provider -SelectedModel $Model -SelectedReasoningEffort $ReasoningEffort
    if (-not (Test-Path -LiteralPath $workspacePreparerPath -PathType Leaf)) {
        throw "Missing production-workspace preparer: $workspacePreparerPath"
    }
    $arguments = @{
        Book = $Book
        Language = $Language
        EditionName = $EditionName
        GlossaryProfile = $GlossaryProfile
        Provider = $Provider
        Model = $Model
        ReasoningEffort = $ReasoningEffort
        ProductsRoot = Get-ConfiguredProductsRoot
    }
    if ($InteriorsPath) { $arguments.InteriorsPath = $InteriorsPath }
    & $workspacePreparerPath @arguments
}

function Invoke-ProductionImport {
    $job = Get-ActiveJob
    if (-not $job.Config.productionWorkspace) {
        throw 'Automated import is available only for a prepared production workspace. Use the Scripts-panel importer for a standard job.'
    }
    $manifest = Read-JsonFile -Path (Join-Path $job.JobPath 'job_manifest.json') -Label 'job manifest'
    if ([string]$manifest.status -notin @('ready_for_import', 'imported') -or [string]$manifest.qa.status -ne 'passed') {
        throw "The production job has not passed Step 2 validation or reached resumable import state. Current status: $($manifest.status)"
    }
    if ([string]$manifest.status -eq 'ready_for_import') {
        & $inDesignRunnerPath -Action Audit `
            -DocumentPath ([string]$job.Config.productionWorkspace.documentPath) `
            -TextFolderPath ([string]$job.Config.productionWorkspace.textFolder) `
            -JobPath $job.JobPath
        Invoke-NodeScript -Script $transactionalImporterPath -JobPath $job.JobPath
    }
    & $inDesignRunnerPath -Action Refresh `
        -DocumentPath ([string]$job.Config.productionWorkspace.documentPath) `
        -TextFolderPath ([string]$job.Config.productionWorkspace.textFolder) `
        -JobPath $job.JobPath
    $updatedManifest = Read-JsonFile -Path (Join-Path $job.JobPath 'job_manifest.json') -Label 'updated job manifest'
    if ([string]$updatedManifest.status -ne 'imported') { throw 'The InDesign import did not set the job manifest to imported.' }
    Write-Output "PRODUCTION_IMPORT_COMPLETE|document=$($job.Config.productionWorkspace.documentPath)|job=$($job.JobPath)"
    Write-Output 'Next: run Run-Translation-Job.ps1 -Action Finalize to apply the document language, fit typography, and require a zero-overflow audit.'
}

function Invoke-ProductionFinalize {
    $job = Get-ActiveJob
    if (-not $job.Config.productionWorkspace) { throw 'Layout finalization is available only for a prepared production workspace.' }
    $manifestPath = Join-Path $job.JobPath 'job_manifest.json'
    $manifest = Read-JsonFile -Path $manifestPath -Label 'job manifest'
    if ([string]$manifest.status -ne 'imported') { throw "Only an imported production job can be finalized. Current status: $($manifest.status)" }

    $productionWorkspace = Get-ValidatedProductionWorkspace -Config $job.Config
    $documentPath = $productionWorkspace.DocumentPath

    $settingsCandidate = $LayoutSettingsPath
    if (-not $settingsCandidate) { $settingsCandidate = [string]$job.Config.layoutProfile }
    if (-not $settingsCandidate) { throw 'No layout settings profile is configured. Supply -LayoutSettingsPath.' }
    if (-not [IO.Path]::IsPathRooted($settingsCandidate)) { $settingsCandidate = Join-Path $programRoot $settingsCandidate }
    $resolvedSettings = Assert-PathWithin -Path $settingsCandidate -Parent $programRoot -Label 'Layout settings profile'
    $settings = Read-JsonFile -Path $resolvedSettings -Label 'layout settings profile'
    if ([int]$settings.schemaVersion -ne 1 -or -not $settings.paragraphStyles) {
        throw "The finalizer requires a style-application profile with a paragraphStyles array: $resolvedSettings"
    }

    $styleReportPath = Join-Path $job.JobPath 'reports\style_application_final.json'
    $auditReportPath = Join-Path $job.JobPath 'reports\layout_audit_final.json'
    $productsRoot = Get-ConfiguredProductsRoot
    & $translationStyleSetterPath -DocumentPath $documentPath -TargetLanguage ([string]$job.Config.targetLanguage) -SettingsPath $resolvedSettings -ReportPath $styleReportPath -ProductsRoot $productsRoot
    & $typographyAuditPath -DocumentPath $documentPath -ReportPath $auditReportPath -ProductsRoot $productsRoot

    $audit = Read-JsonFile -Path $auditReportPath -Label 'final layout audit'
    $overflowCount = [int]$audit.overflow.storyCount
    $missingLinkCount = [int]$audit.linkStatus.missing
    $outdatedLinkCount = [int]$audit.linkStatus.outdated
    $languageMismatches = @($audit.paragraphStyles | Where-Object {
        ([string]$_.name) -notmatch '^\[' -and
        -not ([string]$_.language).Equals([string]$job.Config.targetLanguage, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($overflowCount -ne 0) { throw "Layout finalization found $overflowCount overset stories. Adjust only the affected style families, then rerun Finalize." }
    if ($missingLinkCount -ne 0 -or $outdatedLinkCount -ne 0) {
        throw "Layout finalization found $missingLinkCount missing and $outdatedLinkCount outdated links. Relink local Text/Diagrams assets, then rerun Finalize."
    }
    if ($languageMismatches.Count -ne 0) {
        throw "Layout finalization found $($languageMismatches.Count) custom paragraph styles outside target language '$($job.Config.targetLanguage)'."
    }

    $manifest | Add-Member -NotePropertyName layoutFinalization -NotePropertyValue ([ordered]@{
        completedAt = [DateTime]::UtcNow.ToString('o')
        settingsPath = $resolvedSettings
        auditReport = $auditReportPath
        overflowStories = 0
        languageMismatchStyles = 0
        missingLinks = 0
        outdatedLinks = 0
        documentSha256 = (Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash
    }) -Force
    Write-Utf8Json -Path $manifestPath -Value $manifest

    $workspaceManifestPath = [string]$job.Config.productionWorkspace.workspaceManifest
    $workspaceManifest = Read-JsonFile -Path $workspaceManifestPath -Label 'translation workspace manifest'
    $workspaceManifest.status = 'finalized'
    $workspaceManifest | Add-Member -NotePropertyName finalizedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $workspaceManifest | Add-Member -NotePropertyName layoutSettingsPath -NotePropertyValue $resolvedSettings -Force
    $workspaceManifest | Add-Member -NotePropertyName layoutAuditPath -NotePropertyValue $auditReportPath -Force
    $workspaceManifest | Add-Member -NotePropertyName outputDocumentSha256 -NotePropertyValue ((Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash) -Force
    Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
    Write-Output "PRODUCTION_FINALIZE_COMPLETE|document=$documentPath|overflowStories=0|missingLinks=0|outdatedLinks=0|language=$($job.Config.targetLanguage)|report=$auditReportPath"
}

function Invoke-ProductionExport {
    $job = Get-ActiveJob
    if (-not $job.Config.productionWorkspace) {
        throw 'Automated export is available only for a prepared production workspace.'
    }
    $manifestPath = Join-Path $job.JobPath 'job_manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        $inputWorkbook = [string]$job.Config.paths.inputWorkbook
        if (-not (Test-Path -LiteralPath $inputWorkbook -PathType Leaf)) {
            Copy-Item -LiteralPath ([string]$job.Config.originSources.contentWorkbook) -Destination $inputWorkbook
        }
        $priorArtifactModules = $env:CODEX_ARTIFACT_NODE_MODULES
        try {
            if (-not (Test-Path -LiteralPath $artifactToolPackagePath -PathType Leaf)) {
                throw "Missing artifact-tool runtime component: $artifactToolPackagePath"
            }
            $env:CODEX_ARTIFACT_NODE_MODULES = $artifactNodeModulesPath
            & $codexNodePath $originManifestCreatorPath '--job' $job.JobPath
            if ($LASTEXITCODE -ne 0) { throw "Origin manifest creation failed with exit code $LASTEXITCODE." }
        } finally {
            $env:CODEX_ARTIFACT_NODE_MODULES = $priorArtifactModules
        }
    }
    $manifest = Read-JsonFile -Path $manifestPath -Label 'job manifest'
    if ([string]$manifest.status -notin @('exported', 'translating', 'translated', 'translation_failed', 'ready_for_import')) {
        throw "The production job has an unexpected manifest status for relink: $($manifest.status)"
    }
    $workspaceManifestPath = [string]$job.Config.productionWorkspace.workspaceManifest
    $workspaceManifest = Read-JsonFile -Path $workspaceManifestPath -Label 'translation workspace manifest'
    if ([string]$workspaceManifest.status -eq 'exported' -and $workspaceManifest.relinkedAt) {
        Write-Output "PRODUCTION_EXPORT_ALREADY_COMPLETE|status=$($manifest.status)|job=$($job.JobPath)|relinked=true"
        return
    }
    $workspaceManifest.status = 'exported_waiting_for_relink'
    $workspaceManifest | Add-Member -NotePropertyName preparedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $workspaceManifest | Add-Member -NotePropertyName exportWorkbookSha256 -NotePropertyValue ((Get-FileHash -LiteralPath ([string]$job.Config.paths.inputWorkbook) -Algorithm SHA256).Hash) -Force
    Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
    & $inDesignRunnerPath -Action Relink `
        -DocumentPath ([string]$job.Config.productionWorkspace.documentPath) `
        -TextFolderPath ([string]$job.Config.productionWorkspace.textFolder) `
        -JobPath $job.JobPath
    $workspaceManifest.status = 'exported'
    $workspaceManifest | Add-Member -NotePropertyName relinkedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    $workspaceManifest | Add-Member -NotePropertyName preparedDocumentSha256 -NotePropertyValue ((Get-FileHash -LiteralPath ([string]$job.Config.productionWorkspace.documentPath) -Algorithm SHA256).Hash) -Force
    $workspaceManifest | Add-Member -NotePropertyName exportWorkbookSha256 -NotePropertyValue ((Get-FileHash -LiteralPath ([string]$job.Config.paths.inputWorkbook) -Algorithm SHA256).Hash) -Force
    Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
    Write-Output "PRODUCTION_WORKSPACE_EXPORTED|workspace=$($job.Config.productionWorkspace.root)|document=$($job.Config.productionWorkspace.documentPath)|job=$($job.JobPath)|relinked=true"
}

function Complete-ProductionJob {
    $job = Get-ActiveJob
    if (-not $job.Config.productionWorkspace) { throw 'Use -Action Archive for a standard job.' }
    $manifestPath = Join-Path $job.JobPath 'job_manifest.json'
    $manifest = Read-JsonFile -Path $manifestPath -Label 'job manifest'
    $manifestStatus = [string]$manifest.status
    if ($manifestStatus -notin @('imported', 'complete')) {
        throw "Only an imported production job can be completed. Current status: $($manifest.status)"
    }
    $productionWorkspace = Get-ValidatedProductionWorkspace -Config $job.Config
    $documentPath = $productionWorkspace.DocumentPath
    $layoutAuditPath = Join-Path $job.JobPath 'reports\layout_audit_final.json'
    $layoutAudit = Read-JsonFile -Path $layoutAuditPath -Label 'final layout audit'
    if ([int]$layoutAudit.overflow.storyCount -ne 0) { throw 'The final layout audit contains overset stories.' }
    if ([int]$layoutAudit.linkStatus.missing -ne 0 -or [int]$layoutAudit.linkStatus.outdated -ne 0) {
        throw 'The final layout audit contains missing or outdated links.'
    }
    $languageMismatches = @($layoutAudit.paragraphStyles | Where-Object {
        ([string]$_.name) -notmatch '^\[' -and
        -not ([string]$_.language).Equals([string]$job.Config.targetLanguage, [StringComparison]::OrdinalIgnoreCase)
    })
    if ($languageMismatches.Count -ne 0) { throw 'The final layout audit contains custom paragraph styles in the wrong language.' }
    if ($job.Config.protectedSourceRules -and -not (Test-Path -LiteralPath ([string]$job.Config.protectedSourceContentManifest) -PathType Leaf)) {
        throw 'The protected-source content manifest is missing.'
    }
    $documentSha256 = (Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash
    if ($manifestStatus -eq 'complete') {
        $completedAt = [string]$manifest.completion.completedAt
        $completedDocumentSha256 = [string]$manifest.completion.documentSha256
        if (-not $completedAt -or -not $completedDocumentSha256 -or
            -not $completedDocumentSha256.Equals($documentSha256, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The completed job manifest is incomplete or its document hash no longer matches the production INDD.'
        }
    } else {
        $completedAt = [DateTime]::UtcNow.ToString('o')
        $manifest.status = 'complete'
        $manifest.updatedAt = $completedAt
        $manifest | Add-Member -NotePropertyName completion -NotePropertyValue ([ordered]@{
            completedAt = $completedAt
            documentSha256 = $documentSha256
        }) -Force
        Write-Utf8Json -Path $manifestPath -Value $manifest
    }

    $workspaceManifestPath = Join-Path ([string]$job.Config.productionWorkspace.root) 'Translation Workspace.json'
    $workspaceManifest = Read-JsonFile -Path $workspaceManifestPath -Label 'translation workspace manifest'
    $workspaceManifest.status = 'complete'
    $workspaceManifest | Add-Member -NotePropertyName completedAt -NotePropertyValue $completedAt -Force
    $workspaceManifest | Add-Member -NotePropertyName outputDocumentSha256 -NotePropertyValue $documentSha256 -Force
    Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
    Remove-Item -LiteralPath $activeJobPath
    Write-Output "PRODUCTION_JOB_COMPLETE|workspace=$($job.Config.productionWorkspace.root)|document=$($job.Config.productionWorkspace.documentPath)"
}

function Disable-ProductionJob {
    $job = Get-ActiveJob
    if (-not $job.Config.productionWorkspace) { throw 'Only a production-workspace job can be deactivated.' }
    $manifest = Read-JsonFile -Path (Join-Path $job.JobPath 'job_manifest.json') -Label 'job manifest'
    if ([string]$manifest.status -eq 'translating') { throw 'A translating job cannot be deactivated. Wait for the current subscription batch run to finish or pause.' }
    $workspaceManifestPath = [string]$job.Config.productionWorkspace.workspaceManifest
    $workspaceManifest = Read-JsonFile -Path $workspaceManifestPath -Label 'translation workspace manifest'
    $workspaceManifest | Add-Member -NotePropertyName deactivatedAt -NotePropertyValue ([DateTime]::UtcNow.ToString('o')) -Force
    Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
    Remove-Item -LiteralPath $activeJobPath
    Write-Output "PRODUCTION_JOB_DEACTIVATED|workspace=$($job.Config.productionWorkspace.root)|status=$($manifest.status)"
}

function Enable-ProductionJob {
    if (Test-Path -LiteralPath $activeJobPath -PathType Leaf) {
        $active = Read-JsonFile -Path $activeJobPath -Label 'active-job configuration'
        throw "An active translation job already exists: $($active.jobPath)"
    }
    $requestedWorkspace = $WorkspacePath
    if (-not $requestedWorkspace -and $InteriorsPath -and $EditionName) {
        $requestedWorkspace = Join-Path $InteriorsPath $EditionName
    }
    if (-not $requestedWorkspace) { throw '-WorkspacePath is required for -Action Activate.' }
    $productsRoot = Get-ConfiguredProductsRoot
    $resolvedWorkspace = Assert-PathWithin -Path $requestedWorkspace -Parent $productsRoot -Label 'Production workspace'
    if (-not (Test-Path -LiteralPath $resolvedWorkspace -PathType Container)) { throw "Missing production workspace: $resolvedWorkspace" }
    $jobPath = Find-ProductionJobForWorkspace -WorkspacePath $resolvedWorkspace
    $config = Read-JsonFile -Path (Join-Path $jobPath 'job_config.json') -Label 'job configuration'
    if (-not $config.productionWorkspace -or -not [string]::Equals([IO.Path]::GetFullPath([string]$config.productionWorkspace.root), $resolvedWorkspace, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The requested folder is not a valid Step 2 production workspace: $resolvedWorkspace"
    }
    $manifest = Read-JsonFile -Path (Join-Path $jobPath 'job_manifest.json') -Label 'job manifest'
    Write-Utf8Json -Path $activeJobPath -Value ([ordered]@{
        schemaVersion = 2
        jobId = [string]$config.jobId
        jobPath = $jobPath
        book = [string]$config.book
        editionName = [string]$config.editionName
        targetLanguage = [string]$config.targetLanguage
        glossaryFamily = [string]$config.glossaryFamily
        glossaryProfile = [string]$config.glossaryProfile
        translationProvider = [string]$config.translationProvider
        productionWorkspace = $resolvedWorkspace
        activatedAt = [DateTime]::UtcNow.ToString('o')
    })
    Write-Output "PRODUCTION_JOB_ACTIVATED|workspace=$resolvedWorkspace|status=$($manifest.status)|job=$jobPath"
}

function Invoke-Validation {
    $job = Get-ActiveJob
    Invoke-NodeScript -Script $validatorPath -JobPath $job.JobPath
}

function Show-Status {
    if (-not (Test-Path -LiteralPath $activeJobPath -PathType Leaf)) {
        Write-Output "NO_ACTIVE_JOB|config=$activeJobPath"
        return
    }
    $job = Get-ActiveJob
    $manifestPath = Join-Path $job.JobPath 'job_manifest.json'
    $manifestStatus = 'initialized'
    if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
        $manifestStatus = [string](Read-JsonFile -Path $manifestPath -Label 'job manifest').status
    }
    [pscustomobject]@{
        JobId = $job.Config.jobId
        Book = $job.Config.book
        Language = $job.Config.targetLanguage
        GlossaryProfile = $job.Config.glossaryProfile
        Status = $manifestStatus
        JobPath = $job.JobPath
        ExportWorkbook = Test-Path -LiteralPath (Join-Path $job.JobPath 'input\content_export.xlsx')
        ImportWorkbook = Test-Path -LiteralPath (Join-Path $job.JobPath 'output\content_import.xlsx')
        QaReport = Test-Path -LiteralPath (Join-Path $job.JobPath 'reports\qa_report.json')
        TranslationProvider = [string]$job.Config.translationProvider
        Model = [string]$job.Config.model
        ModelPolicy = [string]$job.Config.modelPolicy
        ReasoningEffort = [string]$job.Config.reasoningEffort
        ProductionWorkspace = if ($job.Config.productionWorkspace) { [string]$job.Config.productionWorkspace.root } else { '' }
        ProductionDocument = if ($job.Config.productionWorkspace) { [string]$job.Config.productionWorkspace.documentPath } else { '' }
    } | Format-List
}

function Move-TranslationJobToArchive {
    $active = Read-JsonFile -Path $activeJobPath -Label 'active-job configuration'
    $source = Assert-PathWithin -Path ([string]$active.jobPath) -Parent $jobsRoot -Label 'Archive source'
    $safeBook = ConvertTo-SafePathPart ([string]$active.book)
    $safeLanguage = ConvertTo-SafePathPart ([string]$active.targetLanguage)
    $safeJobId = ConvertTo-SafePathPart ([string]$active.jobId)
    if (-not [string]::Equals($safeJobId, [string]$active.jobId, [StringComparison]::Ordinal)) {
        throw 'The active job ID is not a canonical safe path component.'
    }
    $destination = Join-Path (Join-Path (Join-Path $archiveRoot $safeBook) $safeLanguage) $safeJobId
    $destination = Assert-PathWithin -Path $destination -Parent $archiveRoot -Label 'Archive destination'
    $result = Invoke-StandardTranslationJobArchive -SourcePath $source -DestinationPath $destination `
        -ActivePointerPath $activeJobPath -ExpectedJobId ([string]$active.jobId) `
        -ExpectedBook ([string]$active.book) -ExpectedLanguage ([string]$active.targetLanguage) -Force:$Force
    Write-Output "JOB_ARCHIVED|destination=$($result.Destination)|recovery=$($result.RecoveryMode)"
}

switch ($Action) {
    'New' { Initialize-TranslationJob }
    'Prepare' { Initialize-ProductionWorkspace }
    'Export' { Invoke-ProductionExport }
    'Translate' { Invoke-Translation }
    'Validate' { Invoke-Validation }
    'Import' { Invoke-ProductionImport }
    'Finalize' { Invoke-ProductionFinalize }
    'Complete' { Complete-ProductionJob }
    'Activate' { Enable-ProductionJob }
    'Deactivate' { Disable-ProductionJob }
    'Status' { Show-Status }
    'Archive' { Move-TranslationJobToArchive }
}

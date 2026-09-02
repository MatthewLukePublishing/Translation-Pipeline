[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$Book,
    [Parameter(Mandatory)] [string]$Language,
    [Parameter(Mandatory)] [string]$EditionName,
    [string]$GlossaryProfile,
    [string]$InteriorsPath,
    [string]$ProductsRoot,
    [ValidateSet('CodexSubscription')] [string]$Provider = 'CodexSubscription',
    [string]$Model = 'latest',
    [ValidateSet('low', 'medium', 'high', 'xhigh', 'max')] [string]$ReasoningEffort = 'xhigh'
)

$ErrorActionPreference = 'Stop'
$stageTwoRoot = Split-Path -Parent $PSScriptRoot
$programRoot = Split-Path -Parent $stageTwoRoot
$glossaryMapPath = Join-Path $programRoot '01 Translate Glossaries\book_glossary_map.json'
$activeJobPath = Join-Path $stageTwoRoot 'Active Job.json'
$jobsRoot = Join-Path $stageTwoRoot 'Jobs'
$inDesignRunner = Join-Path $PSScriptRoot 'InDesign\Invoke-InDesignTranslationDocument.ps1'
$manifestCreator = Join-Path $PSScriptRoot 'Create-OriginJobManifest.mjs'
$protectedDiscoverer = Join-Path $PSScriptRoot 'Discover-ProtectedSourceContent.mjs'
$latestModelResolver = Join-Path $PSScriptRoot 'Resolve-LatestSubscriptionModel.mjs'
$pathSafetyPath = Join-Path $PSScriptRoot 'TranslationPathSafety.ps1'
$fileUtilitiesPath = Join-Path $programRoot 'Code\TranslationFileUtilities.ps1'
$workspaceTransactionModule = Join-Path $PSScriptRoot 'WorkspacePreparationTransaction.ps1'
$workspaceTransactionPath = Join-Path $stageTwoRoot 'Prepare-TranslationWorkspace.transaction.json'
$codexDependencyRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.cache\codex-runtimes\codex-primary-runtime\dependencies\node'
$codexNode = Join-Path $codexDependencyRoot 'bin\node.exe'
$artifactModules = Join-Path $codexDependencyRoot 'node_modules'
$artifactToolPackage = Join-Path $artifactModules '@oai\artifact-tool\package.json'
$requiredSubscriptionReasoningEffort = 'xhigh'
if (-not (Test-Path -LiteralPath $pathSafetyPath -PathType Leaf)) { throw "Missing path-safety utility: $pathSafetyPath" }
. $pathSafetyPath
$productsRoot = Resolve-TranslationProductsRoot -ExplicitPath $ProductsRoot -ProgramRoot $programRoot
if (-not (Test-Path -LiteralPath $fileUtilitiesPath -PathType Leaf)) { throw "Missing file utility: $fileUtilitiesPath" }
. $fileUtilitiesPath
if (-not (Test-Path -LiteralPath $workspaceTransactionModule -PathType Leaf)) { throw "Missing workspace transaction utility: $workspaceTransactionModule" }
. $workspaceTransactionModule

if ($Provider -ne 'CodexSubscription') {
    throw 'Production workspaces require CodexSubscription; paid API translation is disabled for this workflow.'
}
if ($Model -ne 'latest' -or $ReasoningEffort -ne $requiredSubscriptionReasoningEffort) {
    throw "CodexSubscription requires model policy 'latest' with reasoning effort '$requiredSubscriptionReasoningEffort'."
}
foreach ($requiredResolverComponent in @($codexNode, $latestModelResolver)) {
    if (-not (Test-Path -LiteralPath $requiredResolverComponent -PathType Leaf)) {
        throw "Missing latest-model resolver component: $requiredResolverComponent"
    }
}
$resolutionOutput = & $codexNode $latestModelResolver
if ($LASTEXITCODE -ne 0) { throw 'Could not resolve the current official frontier model; workspace preparation will not use a stale fallback.' }
try { $modelResolution = ($resolutionOutput -join [Environment]::NewLine) | ConvertFrom-Json }
catch { throw "Latest-model resolver returned invalid JSON: $($_.Exception.Message)" }
if ([string]$modelResolution.policy -ne 'official_latest_frontier' -or -not [string]$modelResolution.model) {
    throw 'Latest-model resolver returned an invalid policy or blank model.'
}
$Model = [string]$modelResolution.model

function Get-NamedProperty {
    param([Parameter(Mandatory)] $Object, [Parameter(Mandatory)] [string]$Name, [Parameter(Mandatory)] [string]$Label)
    $matchingProperties = @($Object.PSObject.Properties | Where-Object { $_.Name.Equals($Name, [StringComparison]::OrdinalIgnoreCase) })
    if ($matchingProperties.Count -ne 1) { throw "$Label not found: $Name" }
    return [pscustomobject]@{ Name = $matchingProperties[0].Name; Value = $matchingProperties[0].Value }
}

function Find-ProductionJobForWorkspace {
    param([Parameter(Mandatory)] [string]$WorkspacePath)
    $resolvedWorkspace = [IO.Path]::GetFullPath($WorkspacePath)
    $legacyJob = Join-Path $resolvedWorkspace 'Translation Job'
    if (Test-Path -LiteralPath (Join-Path $legacyJob 'job_config.json') -PathType Leaf) { return $legacyJob }
    if (-not (Test-Path -LiteralPath $jobsRoot -PathType Container)) {
        throw "No translation job was found for baseline workspace: $resolvedWorkspace"
    }
    $matches = @()
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
    if ($matches.Count -ne 1) {
        throw "Expected one translation job for baseline workspace '$resolvedWorkspace'; found $($matches.Count)."
    }
    return $matches[0]
}

function Expand-ZipSafely {
    param([Parameter(Mandatory)] [string]$ArchivePath, [Parameter(Mandatory)] [string]$DestinationRoot)
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd('\') + '\'
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    $fileCount = 0
    try {
        foreach ($entry in $archive.Entries) {
            $relative = ([string]$entry.FullName).Replace('/', '\')
            if (-not $relative) { continue }
            $destination = [IO.Path]::GetFullPath((Join-Path $DestinationRoot $relative))
            if (-not $destination.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                throw "Archive entry escapes the translation workspace: $($entry.FullName)"
            }
            if (-not $entry.Name) {
                [IO.Directory]::CreateDirectory($destination) | Out-Null
                continue
            }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
            if (Test-Path -LiteralPath $destination) { throw "Archive contains a duplicate output path: $destination" }
            $inputStream = $entry.Open()
            $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try { $inputStream.CopyTo($output) } finally { $output.Dispose(); $inputStream.Dispose() }
            $fileCount++
        }
    } finally {
        $archive.Dispose()
    }
    return $fileCount
}

$prepareLockPath = Join-Path $stageTwoRoot 'Prepare-TranslationWorkspace.lock'
try {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $prepareLockPath)) | Out-Null
    $prepareLock = [IO.File]::Open($prepareLockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
} catch {
    throw "Another translation workspace preparation is already running: $prepareLockPath"
}

try {
$prepareTransactionStarted = $false
$workspaceManifest = $null
$workspaceManifestPath = $null
$recoveredPreparation = Recover-WorkspacePreparationTransaction `
    -JournalPath $workspaceTransactionPath `
    -AllowedWorkspaceParent $productsRoot `
    -AllowedJobsRoot $jobsRoot `
    -ExpectedActiveJobPath $activeJobPath
if ($recoveredPreparation.Recovered) {
    Write-Warning "Recovered interrupted workspace preparation $($recoveredPreparation.TransactionId): $($recoveredPreparation.Phase)"
}
if (Test-Path -LiteralPath $activeJobPath -PathType Leaf) {
    $active = Read-JsonFile -Path $activeJobPath -Label 'active-job configuration'
    throw "An active translation job already exists: $($active.jobPath). Complete or archive it before preparing another workspace."
}
if ($EditionName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $EditionName -in @('.', '..')) {
    throw "EditionName is not a valid folder name: $EditionName"
}
if (-not $EditionName.Trim()) { throw 'EditionName cannot be blank.' }

$map = Read-JsonFile -Path $glossaryMapPath -Label 'book/glossary map'
$bookProperty = Get-NamedProperty -Object $map.books -Name $Book -Label 'Book mapping'
$bookConfig = $bookProperty.Value
$Book = $bookProperty.Name

$effectiveProfile = $GlossaryProfile
if (-not $effectiveProfile) {
    $defaultProfile = @($bookConfig.defaultProfiles.PSObject.Properties | Where-Object { $_.Name.Equals($Language, [StringComparison]::OrdinalIgnoreCase) })
    $effectiveProfile = if ($defaultProfile.Count) { [string]$defaultProfile[0].Value } else { $Language }
}
$supportedProfile = @($bookConfig.supportedProfiles | Where-Object { ([string]$_).Equals($effectiveProfile, [StringComparison]::OrdinalIgnoreCase) })
if ($supportedProfile.Count -ne 1) {
    throw "Glossary profile '$effectiveProfile' is not supported for $Book. Supported profiles: $($bookConfig.supportedProfiles -join ', ')"
}
$profileProperty = Get-NamedProperty -Object $map.profiles -Name ([string]$supportedProfile[0]) -Label 'Glossary profile'
$glossaryProfileConfig = $profileProperty.Value
if (-not ([string]$glossaryProfileConfig.language).Equals($Language, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Glossary profile '$($profileProperty.Name)' is for $($glossaryProfileConfig.language), not $Language."
}
$effectiveProfile = $profileProperty.Name
$editionWorkflow = $null
if ($bookConfig.editionWorkflows) {
    $workflowProperty = @($bookConfig.editionWorkflows.PSObject.Properties | Where-Object {
        $_.Name.Equals($EditionName.Trim(), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($workflowProperty.Count -gt 1) { throw "Multiple edition workflows match '$EditionName'." }
    if ($workflowProperty.Count -eq 1) { $editionWorkflow = $workflowProperty[0].Value }
}

$layoutProfile = [string]$bookConfig.layoutProfile
if ($bookConfig.layoutProfiles) {
    $layoutProfileProperty = @($bookConfig.layoutProfiles.PSObject.Properties | Where-Object {
        $_.Name.Equals($EditionName.Trim(), [StringComparison]::OrdinalIgnoreCase)
    })
    if ($layoutProfileProperty.Count -gt 1) { throw "Multiple layout profiles match '$EditionName'." }
    if ($layoutProfileProperty.Count -eq 1) { $layoutProfile = [string]$layoutProfileProperty[0].Value }
}

$mappedInteriors = [string]$bookConfig.productInteriorsRoot
if (-not $InteriorsPath) { $InteriorsPath = $mappedInteriors }
if (-not $InteriorsPath) { throw "No productInteriorsRoot is configured for $Book; supply -InteriorsPath." }
$resolvedInteriors = Assert-PathWithin -Path $InteriorsPath -Parent $productsRoot -Label 'Book Interiors folder'
if (-not (Test-Path -LiteralPath $resolvedInteriors -PathType Container)) { throw "Missing book Interiors folder: $resolvedInteriors" }
if ($mappedInteriors -and -not [string]::Equals([IO.Path]::GetFullPath($mappedInteriors), $resolvedInteriors, [StringComparison]::OrdinalIgnoreCase)) {
    throw "The supplied Interiors folder does not match the book map. Mapped: $mappedInteriors; supplied: $resolvedInteriors"
}
$workspaceRoot = Assert-PathWithin -Path (Join-Path $resolvedInteriors $EditionName.Trim()) -Parent $resolvedInteriors -Label 'Translation workspace'
if (Test-Path -LiteralPath $workspaceRoot) { throw "Translation workspace already exists: $workspaceRoot" }

$originDocument = Assert-PathWithin -Path (Join-Path $programRoot ([string]$bookConfig.originDocument)) -Parent $programRoot -Label 'Origin INDD'
$originWorkbook = Assert-PathWithin -Path (Join-Path $programRoot ([string]$bookConfig.originWorkbook)) -Parent $programRoot -Label 'Origin workbook'
$originArchive = Assert-PathWithin -Path (Join-Path $programRoot ([string]$bookConfig.originArchive)) -Parent $programRoot -Label 'Origin ICML archive'
$resolvedLayoutProfile = ''
if ($layoutProfile) {
    $layoutProfileCandidate = if ([IO.Path]::IsPathRooted($layoutProfile)) { $layoutProfile } else { Join-Path $programRoot $layoutProfile }
    $resolvedLayoutProfile = Assert-PathWithin -Path $layoutProfileCandidate -Parent $programRoot -Label 'Layout profile'
}
$originDiagrams = $null
if ($bookConfig.originDiagrams) {
    $originDiagrams = Assert-PathWithin -Path ([string]$bookConfig.originDiagrams) -Parent $productsRoot -Label 'Origin Diagrams folder'
}
$acronymSource = Assert-PathWithin -Path (Join-Path $programRoot ([string]$bookConfig.runtime.acronyms)) -Parent $programRoot -Label 'Acronym glossary'
$wordsSource = Assert-PathWithin -Path (Join-Path $programRoot ([string]$bookConfig.runtime.words)) -Parent $programRoot -Label 'Word glossary'
$translationInstructionsSource = ''
$translationInstructionsModule = $null
if ($bookConfig.translationInstructions) {
    $translationInstructionsSource = Assert-PathWithin -Path (Join-Path $programRoot ([string]$bookConfig.translationInstructions)) -Parent $programRoot -Label 'Book translation instructions'
    $translationInstructionsModule = Read-JsonFile -Path $translationInstructionsSource -Label 'book translation instructions'
    if ([int]$translationInstructionsModule.schemaVersion -ne 2) { throw 'Book translation instructions must use schemaVersion 2.' }
    if (-not ([string]$translationInstructionsModule.book).Equals($Book, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Book translation instructions are for '$($translationInstructionsModule.book)', not '$Book'."
    }
    if (-not $translationInstructionsModule.baseRules -or @($translationInstructionsModule.baseRules.promptInstructions).Count -lt 1) {
        throw 'Book translation instructions must contain baseRules.promptInstructions.'
    }
    $languageRule = if ($translationInstructionsModule.languageExceptions) {
        @($translationInstructionsModule.languageExceptions.PSObject.Properties | Where-Object {
            $_.Name.Equals($Language, [StringComparison]::OrdinalIgnoreCase)
        })
    } else { @() }
    if ($languageRule.Count -gt 1) { throw "Book translation instructions define '$Language' more than once." }
}
foreach ($source in @($originDocument, $originWorkbook, $originArchive, $resolvedLayoutProfile, $acronymSource, $wordsSource, $translationInstructionsSource, $inDesignRunner, $manifestCreator, $latestModelResolver, $codexNode, $artifactToolPackage) | Where-Object { $_ }) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing required translation source: $source" }
}
if ($originDiagrams -and -not (Test-Path -LiteralPath $originDiagrams -PathType Container)) {
    throw "Missing required origin Diagrams folder: $originDiagrams"
}
if (-not (Test-Path -LiteralPath $artifactModules -PathType Container)) {
    throw "Missing required artifact-tool module directory: $artifactModules"
}

$textFolder = Join-Path $workspaceRoot 'Text'
$diagramsFolder = Join-Path $workspaceRoot 'Diagrams'
$documentName = "$Book $($EditionName.Trim()).indd"
$documentPath = Join-Path $workspaceRoot $documentName
$jobId = ('{0}_{1}_{2}_{3}' -f $Book, ($EditionName -replace '[^A-Za-z0-9]+', '_').Trim('_'), $Language, (Get-Date -Format 'yyyyMMdd_HHmmss'))
$safeBook = ($Book -replace '[^A-Za-z0-9._-]+', '_').Trim('_')
$safeLanguage = ($Language -replace '[^A-Za-z0-9._-]+', '_').Trim('_')
if (-not $safeBook -or -not $safeLanguage) { throw 'Book and language must produce safe job-folder names.' }
$jobPath = Assert-PathWithin -Path (Join-Path (Join-Path (Join-Path $jobsRoot $safeBook) $safeLanguage) $jobId) -Parent $jobsRoot -Label 'Translation job'
$workspaceManifestPath = Join-Path $jobPath 'Translation Workspace.json'
if (Test-Path -LiteralPath $jobPath) { throw "Translation job already exists: $jobPath" }

$prepareTransaction = Start-WorkspacePreparationTransaction `
    -JournalPath $workspaceTransactionPath `
    -WorkspaceRoot $workspaceRoot `
    -JobPath $jobPath `
    -ActiveJobPath $activeJobPath
$prepareTransactionStarted = $true
[void](Initialize-WorkspacePreparationTargets -JournalPath $workspaceTransactionPath)
[void](Set-WorkspacePreparationTransactionPhase -JournalPath $workspaceTransactionPath -Phase 'preparing')
foreach ($relative in @('input', 'glossary', 'output', 'reports', 'state')) {
    [IO.Directory]::CreateDirectory((Join-Path $jobPath $relative)) | Out-Null
}
Copy-Item -LiteralPath $originDocument -Destination $documentPath
if ($originDiagrams) {
    Copy-Item -LiteralPath $originDiagrams -Destination $diagramsFolder -Recurse
} else {
    [IO.Directory]::CreateDirectory($diagramsFolder) | Out-Null
}
$extractedFileCount = Expand-ZipSafely -ArchivePath $originArchive -DestinationRoot $workspaceRoot
if (-not (Test-Path -LiteralPath $textFolder -PathType Container)) { throw "The ICML archive did not create the expected Text folder: $textFolder" }
$icmlFiles = @(Get-ChildItem -LiteralPath $textFolder -Recurse -File | Where-Object { $_.Extension -eq '.icml' })
if (-not $icmlFiles.Count) { throw "No ICML files were extracted to $textFolder" }
Copy-Item -LiteralPath $acronymSource -Destination (Join-Path $jobPath 'glossary\acronyms.json')
Copy-Item -LiteralPath $wordsSource -Destination (Join-Path $jobPath 'glossary\words.json')
Copy-Item -LiteralPath $originWorkbook -Destination (Join-Path $jobPath 'input\content_export.xlsx')
$translationInstructionsSnapshot = ''
if ($translationInstructionsSource) {
    $translationInstructionsSnapshot = Join-Path $jobPath 'input\book_translation_instructions.json'
    Copy-Item -LiteralPath $translationInstructionsSource -Destination $translationInstructionsSnapshot
}

$bookProtectedRuleProperty = $bookConfig.PSObject.Properties['protectedSourceRules']
$protectedRules = if ($null -ne $bookProtectedRuleProperty) {
    @($bookProtectedRuleProperty.Value)
} else {
    @($map.defaultProtectedSourceRules)
}
$protectedManifestPath = ''
$protectedManifest = $null
if ($protectedRules.Count -gt 0) {
    if (-not (Test-Path -LiteralPath $protectedDiscoverer -PathType Leaf)) { throw "Missing protected-source discoverer: $protectedDiscoverer" }
    $protectedManifestPath = Join-Path $jobPath 'input\protected_source_content.json'
    $discoveryArguments = @($protectedDiscoverer, '--text', $textFolder, '--output', $protectedManifestPath)
    foreach ($rule in $protectedRules) {
        if ([string]$rule.sourcePolicy -ne 'verbatim' -or [string]$rule.selectorType -ne 'paragraph_style' -or -not [string]$rule.paragraphStyleName) {
            throw 'Protected source rules must use sourcePolicy=verbatim with a paragraph_style selector.'
        }
        $discoveryArguments += @('--paragraph-style', [string]$rule.paragraphStyleName)
    }
    & $codexNode @discoveryArguments
    if ($LASTEXITCODE -ne 0) { throw "Protected-source discovery failed with exit code $LASTEXITCODE." }
    $protectedManifest = Read-JsonFile -Path $protectedManifestPath -Label 'protected source content manifest'
}

$baselineConfig = $null
if ($editionWorkflow) {
    $baselineEdition = [string]$editionWorkflow.baselineEdition
    $baselineProfileName = [string]$editionWorkflow.baselineGlossaryProfile
    if (-not $baselineEdition -or -not $baselineProfileName -or [string]$editionWorkflow.mode -ne 'profile_delta') {
        throw "Edition workflow '$($EditionName.Trim())' has an incomplete or unsupported baseline contract."
    }
    $baselineWorkspace = Assert-PathWithin -Path (Join-Path $resolvedInteriors $baselineEdition) -Parent $resolvedInteriors -Label 'Baseline edition workspace'
    $baselineJob = Find-ProductionJobForWorkspace -WorkspacePath $baselineWorkspace
    $baselineWorkbook = Join-Path $baselineJob 'output\content_import.xlsx'
    $baselineManifestPath = Join-Path $baselineJob 'job_manifest.json'
    if (-not (Test-Path -LiteralPath $baselineWorkbook -PathType Leaf)) { throw "Missing translated baseline workbook: $baselineWorkbook" }
    $baselineManifest = Read-JsonFile -Path $baselineManifestPath -Label 'baseline job manifest'
    if ([string]$baselineManifest.qa.status -ne 'passed') { throw "Baseline edition '$baselineEdition' has not passed Step 2 QA." }
    $baselineProfileProperty = Get-NamedProperty -Object $map.profiles -Name $baselineProfileName -Label 'Baseline glossary profile'
    $baselineProfile = $baselineProfileProperty.Value
    if (-not ([string]$baselineProfile.language).Equals($Language, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Baseline glossary profile '$baselineProfileName' is not for $Language."
    }
    $baselineCopy = Join-Path $jobPath ('input\baseline_{0}.xlsx' -f (($baselineEdition -replace '[^A-Za-z0-9]+', '_').Trim('_').ToLowerInvariant()))
    Copy-Item -LiteralPath $baselineWorkbook -Destination $baselineCopy
    $baselineConfig = [ordered]@{
        workbookPath = $baselineCopy
        mode = 'profile_delta'
        previousGlossaryTermKey = [string]$baselineProfile.termKey
        previousGlossaryDefinitionKey = [string]$baselineProfile.definitionKey
    }
}

$now = [DateTime]::UtcNow.ToString('o')
$jobConfig = [ordered]@{
    schemaVersion = 2
    jobId = $jobId
    jobPath = $jobPath
    book = $Book
    editionName = $EditionName.Trim()
    targetLanguage = $Language
    glossaryFamily = [string]$bookConfig.family
    glossaryContractVersion = [int]$map.glossaryContractVersion
    glossaryProfile = $effectiveProfile
    glossaryTermKey = [string]$glossaryProfileConfig.termKey
    glossaryDefinitionKey = [string]$glossaryProfileConfig.definitionKey
    translationProvider = $Provider
    model = $Model
    modelPolicy = 'official_latest_frontier'
    modelResolution = $modelResolution
    reasoningEffort = $ReasoningEffort
    subscriptionBatchMaxChars = 24000
    subscriptionBatchMaxGroups = 100
    subscriptionBatchMaxSegments = 300
    createdAt = $now
    glossarySources = [ordered]@{ acronyms = $acronymSource; words = $wordsSource }
    originSources = [ordered]@{ document = $originDocument; contentWorkbook = $originWorkbook; icmlArchive = $originArchive; diagrams = $originDiagrams }
    productionWorkspace = [ordered]@{
        root = $workspaceRoot
        interiorsRoot = $resolvedInteriors
        documentPath = $documentPath
        textFolder = $textFolder
        diagramsFolder = if ($originDiagrams) { $diagramsFolder } else { '' }
        icmlArchivePath = ''
        workspaceManifest = $workspaceManifestPath
    }
    paths = [ordered]@{
        inputWorkbook = Join-Path $jobPath 'input\content_export.xlsx'
        outputWorkbook = Join-Path $jobPath 'output\content_import.xlsx'
        reports = Join-Path $jobPath 'reports'
        state = Join-Path $jobPath 'state'
    }
}
$jobConfig['protectedSourceRules'] = $protectedRules
$jobConfig['protectedSourceContentManifest'] = $protectedManifestPath
$jobConfig['layoutProfile'] = $resolvedLayoutProfile
if ($translationInstructionsSnapshot) {
    $jobConfig['bookTranslationInstructions'] = [ordered]@{
        moduleId = [string]$translationInstructionsModule.moduleId
        moduleSchemaVersion = [int]$translationInstructionsModule.schemaVersion
        book = [string]$translationInstructionsModule.book
        language = $Language
        baseRulesApplied = $true
        languageException = if ($languageRule.Count -eq 1) { [string]$languageRule[0].Name } else { '' }
        path = $translationInstructionsSnapshot
        sha256 = (Get-FileHash -LiteralPath $translationInstructionsSnapshot -Algorithm SHA256).Hash
    }
}
if ($baselineConfig) {
    $jobConfig['subscriptionStateName'] = 'codex_subscription_profile_delta'
    $jobConfig['translationGuidance'] = [string]$editionWorkflow.translationGuidance
    $jobConfig['baselineTranslation'] = $baselineConfig
}
$workspaceManifest = [ordered]@{
    schemaVersion = 1
    status = 'preparing'
    createdAt = $now
    book = $Book
    editionName = $EditionName.Trim()
    targetLanguage = $Language
    glossaryProfile = $effectiveProfile
    translationProvider = $Provider
    model = $Model
    modelPolicy = 'official_latest_frontier'
    modelResolution = $modelResolution
    reasoningEffort = $ReasoningEffort
    workspaceRoot = $workspaceRoot
    documentPath = $documentPath
    textFolder = $textFolder
    diagramsFolder = if ($originDiagrams) { $diagramsFolder } else { '' }
    jobPath = $jobPath
    source = [ordered]@{
        originDocument = $originDocument
        originDocumentSha256 = (Get-FileHash -LiteralPath $originDocument -Algorithm SHA256).Hash
        originArchive = $originArchive
        originArchiveSha256 = (Get-FileHash -LiteralPath $originArchive -Algorithm SHA256).Hash
        originWorkbook = $originWorkbook
        originWorkbookSha256 = (Get-FileHash -LiteralPath $originWorkbook -Algorithm SHA256).Hash
        originDiagrams = if ($originDiagrams) { $originDiagrams } else { '' }
        acronymGlossary = $acronymSource
        acronymGlossarySha256 = (Get-FileHash -LiteralPath $acronymSource -Algorithm SHA256).Hash
        wordGlossary = $wordsSource
        wordGlossarySha256 = (Get-FileHash -LiteralPath $wordsSource -Algorithm SHA256).Hash
        bookTranslationInstructions = $translationInstructionsSource
        bookTranslationInstructionsSha256 = if ($translationInstructionsSource) { (Get-FileHash -LiteralPath $translationInstructionsSource -Algorithm SHA256).Hash } else { '' }
    }
    copiedArchivePath = ''
    extractedFileCount = $extractedFileCount
    icmlFileCount = $icmlFiles.Count
    protectedSourceRules = $protectedRules
    protectedSourceContentIds = if ($protectedManifest) { [int]$protectedManifest.contentIdCount } else { 0 }
    protectedSourceContentManifest = $protectedManifestPath
    layoutProfile = $resolvedLayoutProfile
}
if ($baselineConfig) {
    $workspaceManifest['baselineTranslation'] = [ordered]@{
        edition = [string]$editionWorkflow.baselineEdition
        glossaryProfile = [string]$editionWorkflow.baselineGlossaryProfile
        workbookPath = [string]$baselineConfig.workbookPath
        workbookSha256 = (Get-FileHash -LiteralPath ([string]$baselineConfig.workbookPath) -Algorithm SHA256).Hash
        mode = [string]$baselineConfig.mode
    }
}
Write-Utf8Json -Path (Join-Path $jobPath 'job_config.json') -Value $jobConfig
Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
Write-Utf8Json -Path $activeJobPath -Value ([ordered]@{
    schemaVersion = 2
    jobId = $jobId
    jobPath = $jobPath
    book = $Book
    editionName = $EditionName.Trim()
    targetLanguage = $Language
    glossaryFamily = [string]$bookConfig.family
    glossaryProfile = $effectiveProfile
    translationProvider = $Provider
    productionWorkspace = $workspaceRoot
    activatedAt = $now
})

try {
    $priorArtifactModules = $env:CODEX_ARTIFACT_NODE_MODULES
    try {
        $env:CODEX_ARTIFACT_NODE_MODULES = $artifactModules
        & $codexNode $manifestCreator '--job' $jobPath
        if ($LASTEXITCODE -ne 0) { throw "Origin manifest creation failed with exit code $LASTEXITCODE." }
    } finally {
        $env:CODEX_ARTIFACT_NODE_MODULES = $priorArtifactModules
    }
    $manifest = Read-JsonFile -Path (Join-Path $jobPath 'job_manifest.json') -Label 'export manifest'
    if ([string]$manifest.status -ne 'exported') { throw "Prepared job did not reach exported status: $($manifest.status)" }
    $workspaceManifest.status = 'exported_waiting_for_relink'
    $workspaceManifest.preparedAt = [DateTime]::UtcNow.ToString('o')
    $workspaceManifest.exportWorkbookSha256 = (Get-FileHash -LiteralPath (Join-Path $jobPath 'input\content_export.xlsx') -Algorithm SHA256).Hash
    Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest

    try {
        & $inDesignRunner -Action Relink -DocumentPath $documentPath -TextFolderPath $textFolder -JobPath $jobPath
        $workspaceManifest.status = 'exported'
        $workspaceManifest.relinkedAt = [DateTime]::UtcNow.ToString('o')
        $workspaceManifest.preparedDocumentSha256 = (Get-FileHash -LiteralPath $documentPath -Algorithm SHA256).Hash
        Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
        Write-Output "PRODUCTION_WORKSPACE_EXPORTED|workspace=$workspaceRoot|document=$documentPath|job=$jobPath|profile=$effectiveProfile|icml=$($icmlFiles.Count)|relinked=true"
    } catch {
        if ($_.Exception.Message -notmatch 'InDesign has open documents') { throw }
        $workspaceManifest.relinkBlockedAt = [DateTime]::UtcNow.ToString('o')
        $workspaceManifest.relinkBlockReason = $_.Exception.Message
        Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
        Write-Warning 'The Origin package is ready and may be translated, but the copied INDD still needs its local ICML relink after the open InDesign documents are saved and closed.'
        Write-Output "PRODUCTION_WORKSPACE_EXPORTED|workspace=$workspaceRoot|document=$documentPath|job=$jobPath|profile=$effectiveProfile|icml=$($icmlFiles.Count)|relinked=false"
    }
    $completedPreparation = Complete-WorkspacePreparationTransaction -JournalPath $workspaceTransactionPath
    $prepareTransactionStarted = $false
    Write-Output "WORKSPACE_PREPARATION_TRANSACTION_OK|id=$($completedPreparation.TransactionId)"
} catch {
    $primaryError = $_
    if ($null -ne $workspaceManifest -and $workspaceManifestPath -and (Test-Path -LiteralPath (Split-Path -Parent $workspaceManifestPath) -PathType Container)) {
        try {
            $workspaceManifest.status = 'preparation_failed'
            $workspaceManifest.failedAt = [DateTime]::UtcNow.ToString('o')
            $workspaceManifest.error = $primaryError.Exception.Message
            Write-Utf8Json -Path $workspaceManifestPath -Value $workspaceManifest
        } catch {
            Write-Warning "Could not record the transient preparation failure: $($_.Exception.Message)"
        }
    }
    if ($prepareTransactionStarted) {
        try {
            $rollback = Recover-WorkspacePreparationTransaction `
                -JournalPath $workspaceTransactionPath `
                -AllowedWorkspaceParent $productsRoot `
                -AllowedJobsRoot $jobsRoot `
                -ExpectedActiveJobPath $activeJobPath
            Write-Warning "Rolled back workspace preparation $($rollback.TransactionId): $($rollback.Phase)"
        } catch {
            throw "Workspace preparation failed and crash-recovery rollback also failed. Primary: $($primaryError.Exception.Message) | Recovery: $($_.Exception.Message)"
        }
    }
    throw $primaryError
}
} finally {
    if ($prepareLock) { $prepareLock.Dispose() }
}

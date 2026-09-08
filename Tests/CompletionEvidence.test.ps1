[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Get-Content -LiteralPath (Join-Path $root 'Run-Translation-Job.ps1') -Raw
$ast = [Management.Automation.Language.Parser]::ParseInput($source, [ref]$null, [ref]$null)
$definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-ProductionCompletionEvidence' }, $true)
. ([scriptblock]::Create($definition.Extent.Text))
$script:hashes = @{ document = ('A' * 64); audit = ('B' * 64); workbook = ('C' * 64) }
function Test-Path { param($LiteralPath, $PathType) return $script:hashes.ContainsKey($LiteralPath) }
function Get-FileHash { param($LiteralPath, $Algorithm) return [pscustomobject]@{ Hash = $script:hashes[$LiteralPath] } }
$manifest = [pscustomobject]@{
    qa = [pscustomobject]@{ status = 'passed'; hashes = [pscustomobject]@{ outputWorkbookSha256 = $script:hashes.workbook } }
    import = [pscustomobject]@{ workbookSha256 = $script:hashes.workbook }
    layoutFinalization = [pscustomobject]@{ documentSha256 = $script:hashes.document; auditSha256 = $script:hashes.audit }
}
$arguments = @{ Manifest = $manifest; DocumentPath = 'document'; LayoutAuditPath = 'audit'; WorkbookPath = 'workbook' }
Assert-ProductionCompletionEvidence @arguments
foreach ($field in @('document', 'audit', 'workbook')) {
    $before = $script:hashes[$field]
    $script:hashes[$field] = 'D' * 64
    $rejected = $false
    try { Assert-ProductionCompletionEvidence @arguments } catch { $rejected = $_.Exception.Message -like '*changed after validation*' }
    if (-not $rejected) { throw "Changed $field must block completion." }
    $script:hashes[$field] = $before
}
$manifest.layoutFinalization.auditSha256 = ''
$rejected = $false
try { Assert-ProductionCompletionEvidence @arguments } catch { $rejected = $_.Exception.Message -like '*Missing completion evidence*' }
if (-not $rejected) { throw 'An unbound legacy audit must require a fresh finalization.' }
$modelDefinition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-CompletionSubscriptionModel' }, $true)
. ([scriptblock]::Create($modelDefinition.Extent.Text))
$script:liveModel = 'frontier-fixture'
$script:resolutionCalls = 0
function Resolve-LatestSubscriptionModel {
    $script:resolutionCalls++
    if ($script:liveModel -eq 'unavailable') { throw 'Live discovery unavailable' }
    return [pscustomobject]@{ model = $script:liveModel; reasoningEffort = 'xhigh' }
}
$null = Resolve-CompletionSubscriptionModel -RecordedModel 'frontier-fixture' -RecordedEffort 'xhigh'
foreach ($next in @('new-frontier', 'unavailable')) {
    $script:liveModel = $next
    $rejected = $false
    try { $null = Resolve-CompletionSubscriptionModel -RecordedModel 'frontier-fixture' -RecordedEffort 'xhigh' } catch { $rejected = $true }
    if (-not $rejected) { throw 'A changed or unavailable frontier must block completion.' }
}
if ($script:resolutionCalls -ne 3) { throw 'Each completion attempt must resolve live.' }
$completionDefinition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Complete-ProductionJob' }, $true)
if ($completionDefinition.Extent.Text -notmatch '\$workspaceManifestPath = \[string\]\$job.Config.productionWorkspace.workspaceManifest') {
    throw 'Completion must use the configured central or legacy workspace manifest.'
}
Write-Output 'COMPLETION_EVIDENCE_TEST_OK|cases=9|adobeCalls=0'

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
Write-Output 'COMPLETION_EVIDENCE_TEST_OK|cases=5|adobeCalls=0'

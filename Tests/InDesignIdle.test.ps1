[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$source=Get-Content -LiteralPath (Join-Path $root '02 Translate Text\Code\InDesign\InDesignUiIdle.ps1') -Raw
$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$null,[ref]$null)
$definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Wait-InDesignUiIdle'},$true)
if(-not $definition){throw 'Missing UI idle function.'}
. ([scriptblock]::Create($definition.Extent.Text))
$script:polls=0;$script:busy=$false
function Get-Process {
    param($Name,$ErrorAction)
    $script:polls++
    [pscustomobject]@{ Responding=$true; CPU=10000+$script:polls*10; Threads=@(
        [pscustomobject]@{ Id=10; StartTime=[datetime]'2020-01-01'; ThreadState='Wait'; TotalProcessorTime=[timespan]::FromSeconds($(if($script:busy){$script:polls}else{1})) }
    ) }
}
function Start-Sleep { param($Seconds) }
Wait-InDesignUiIdle
if($script:polls -ne 4){throw 'Idle UI must succeed independently of background worker CPU.'}
$script:polls=0;$script:busy=$true;$rejected=$false
try{Wait-InDesignUiIdle | Out-Null}catch{$rejected=$_.Exception.Message -like '*did not become idle*'}
if(-not $rejected){throw 'Busy UI thread must fail closed without calling Adobe.'}
Write-Output 'INDESIGN_UI_IDLE_TEST_OK|cases=2|adobeCalls=0'

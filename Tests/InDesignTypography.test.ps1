[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $root '02 Translate Text\Code\InDesign\InDesignTypographyCommon.ps1')
$script:idleCalls = 0
function Wait-InDesignUiIdle { $script:idleCalls++ }
$application = [pscustomobject]@{ lastScript = ''; calls = 0; result = 'STYLE|path=Body%2FText|language=French' }
$application | Add-Member -MemberType ScriptMethod -Name DoScript -Value {
    param($source, $language)
    if ($language -ne 1246973031) { throw 'Wrong scripting language.' }
    $this.lastScript = $source
    $this.calls++
    return $this.result
}
$rows = @(Invoke-InDesignTypographyStep -Application $application -DocumentPath 'C:\Synthetic\book.indd' -Action styles)
if ($rows.Count -ne 1 -or $rows[0].path -ne 'Body/Text') { throw 'Encoded typography report did not round-trip.' }
if ($application.lastScript -match '__[A-Z]+_JS__' -or $application.lastScript -notmatch 'requested = \[\]') { throw 'Empty settings were not rendered as a JSON array.' }
$null = Invoke-InDesignTypographyStep -Application $application -DocumentPath 'C:\Synthetic\book.indd' -Action apply -Start 2 -Count 5 -TargetLanguage French -Settings @([pscustomobject]@{ path = 'Body/Text'; pointSize = 10 })
if ($application.lastScript -notmatch 'start = 2, count = 5' -or $application.lastScript -notmatch '"pointSize":10') { throw 'Bounded style settings were not rendered correctly.' }
$application.result = 'ERROR|Synthetic failure'
$rejected = $false
try { Invoke-InDesignTypographyStep -Application $application -DocumentPath 'C:\Synthetic\book.indd' -Action close | Out-Null }
catch { $rejected = $_.Exception.Message -eq 'ERROR|Synthetic failure' }
if (-not $rejected -or $application.calls -ne 3 -or $script:idleCalls -ne 3) { throw 'Every call must wait for UI idleness and an error must not launch cleanup calls.' }
Write-Output 'INDESIGN_TYPOGRAPHY_TEST_OK|cases=3|adobeCalls=0'

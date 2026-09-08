. (Join-Path $PSScriptRoot 'InDesignAutomationCommon.ps1')

function Invoke-InDesignTypographyStep {
    param(
        [Parameter(Mandatory)] $Application,
        [Parameter(Mandatory)] [string]$DocumentPath,
        [Parameter(Mandatory)] [string]$Action,
        [int]$Start = 0,
        [ValidateRange(1, 100)] [int]$Count = 25,
        [object[]]$Settings = @(),
        [string]$TargetLanguage = ''
    )
    Wait-InDesignUiIdle
    $scriptText = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'Run_Translation_Typography.jsx') -Raw
    $replacements = [ordered]@{
        '__ACTION_JS__' = ConvertTo-JavaScriptStringLiteral $Action
        '__DOCUMENT_JS__' = ConvertTo-JavaScriptStringLiteral $DocumentPath
        '__START_JS__' = [string]$Start
        '__COUNT_JS__' = [string]$Count
        '__SETTINGS_JS__' = ConvertTo-Json -InputObject @($Settings) -Depth 10 -Compress
        '__LANGUAGE_JS__' = '""'
    }
    if ($TargetLanguage) { $replacements['__LANGUAGE_JS__'] = ConvertTo-JavaScriptStringLiteral $TargetLanguage }
    foreach ($key in $replacements.Keys) { $scriptText = $scriptText.Replace($key, [string]$replacements[$key]) }
    if ($scriptText -match '__[A-Z][A-Z0-9_]+__') { throw "Unresolved typography JSX token: $($matches[0])" }
    $result = [string]$Application.DoScript($scriptText, 1246973031)
    if ($result -like 'ERROR|*') { throw $result }
    return @(ConvertFrom-KeyValueText -Text $result)
}

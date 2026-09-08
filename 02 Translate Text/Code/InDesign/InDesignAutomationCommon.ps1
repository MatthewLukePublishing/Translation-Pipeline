$translationFileUtilitiesPath = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) 'Code\TranslationFileUtilities.ps1'
if (-not (Test-Path -LiteralPath $translationFileUtilitiesPath -PathType Leaf)) { throw "Missing translation file utility: $translationFileUtilitiesPath" }
. $translationFileUtilitiesPath
. (Join-Path $PSScriptRoot 'InDesignUiIdle.ps1')

function ConvertFrom-EncodedValue {
    param([AllowEmptyString()] [string]$Value)
    return [Uri]::UnescapeDataString(($Value -replace '\+', ' '))
}

function ConvertFrom-KeyValueText {
    param([Parameter(Mandatory)] [string]$Text)
    $items = [Collections.Generic.List[object]]::new()
    foreach ($line in ($Text -split "`r?`n")) {
        if (-not $line) { continue }
        $parts = $line -split '\|'
        $record = [ordered]@{ kind = $parts[0] }
        for ($index = 1; $index -lt $parts.Count; $index++) {
            $pair = $parts[$index] -split '=', 2
            if ($pair.Count -eq 2) { $record[$pair[0]] = ConvertFrom-EncodedValue $pair[1] }
        }
        $items.Add([pscustomobject]$record)
    }
    return $items
}

function ConvertTo-JavaScriptStringLiteral {
    param([Parameter(Mandatory)] [string]$Value)
    $escaped = $Value.Replace('\', '/').Replace('"', '\"')
    $escaped = $escaped.Replace("`r", '\r').Replace("`n", '\n')
    $escaped = $escaped.Replace([string][char]0x2028, '\u2028').Replace([string][char]0x2029, '\u2029')
    return '"' + $escaped + '"'
}

function Get-InDesignApplication {
    foreach ($programId in @('InDesign.Application.2026', 'InDesign.Application.CC.2026', 'InDesign.Application')) {
        try {
            $candidate = New-Object -ComObject $programId
            if ($null -ne $candidate) { return $candidate }
        } catch {
            # Try the next registered InDesign program ID.
            [void]$_.Exception
        }
    }
    throw 'Unable to connect to Adobe InDesign 2026.'
}

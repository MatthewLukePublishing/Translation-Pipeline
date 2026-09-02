function Write-Utf8TextAtomic {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [AllowEmptyString()] [string]$Text
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if ($parent) { [IO.Directory]::CreateDirectory($parent) | Out-Null }
    $extension = [IO.Path]::GetExtension($fullPath)
    $stem = if ($extension) { $fullPath.Substring(0, $fullPath.Length - $extension.Length) } else { $fullPath }
    $temporary = '{0}.tmp-{1}-{2}{3}' -f $stem, $PID, ([Guid]::NewGuid().ToString('N')), $extension
    try {
        [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($fullPath)) {
            $overwriteMove = [IO.File].GetMethod('Move', [Type[]]@([string], [string], [bool]))
            if ($null -ne $overwriteMove) {
                [IO.File]::Move($temporary, $fullPath, $true)
            } else {
                $fallbackBackup = $temporary + '.replace-backup'
                [IO.File]::Replace($temporary, $fullPath, $fallbackBackup)
                try { [IO.File]::Delete($fallbackBackup) }
                catch { Write-Warning "Atomic JSON replacement left a recoverable backup: $fallbackBackup" }
            }
        } else {
            [IO.File]::Move($temporary, $fullPath)
        }
    } catch {
        $primaryError = $_
        try { [IO.File]::Delete($temporary) } catch { [void]$_.Exception }
        throw $primaryError
    }
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] $Value,
        [ValidateRange(1, 100)] [int]$Depth = 30
    )
    $json = $Value | ConvertTo-Json -Depth $Depth
    Write-Utf8TextAtomic -Path $Path -Text ($json + [Environment]::NewLine)
}

function Read-JsonFile {
    param([Parameter(Mandatory)] [string]$Path, [Parameter(Mandatory)] [string]$Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "Missing ${Label}: $Path" }
    try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
    catch { throw "Could not parse ${Label} ${Path}: $($_.Exception.Message)" }
}

function Assert-PathWithin {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [string]$Parent,
        [Parameter(Mandatory)] [string]$Label
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullParent = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
    if (-not $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Label is outside the permitted root: $fullPath"
    }
    return $fullPath
}

function Resolve-TranslationProductsRoot {
    param(
        [string]$ExplicitPath,
        [Parameter(Mandatory)] [string]$ProgramRoot
    )

    $candidate = $ExplicitPath
    if (-not $candidate) { $candidate = [Environment]::GetEnvironmentVariable('TRANSLATION_PRODUCTS_ROOT') }
    if (-not $candidate) {
        $programsRoot = Split-Path -Parent ([IO.Path]::GetFullPath($ProgramRoot))
        $codeRoot = Split-Path -Parent $programsRoot
        $publishingRoot = Split-Path -Parent $codeRoot
        $candidate = Join-Path $publishingRoot 'Products'
    }
    $resolved = [IO.Path]::GetFullPath($candidate)
    if (-not (Test-Path -LiteralPath $resolved -PathType Container)) {
        throw "Products root does not exist. Supply -ProductsRoot or set TRANSLATION_PRODUCTS_ROOT: $resolved"
    }
    return $resolved
}

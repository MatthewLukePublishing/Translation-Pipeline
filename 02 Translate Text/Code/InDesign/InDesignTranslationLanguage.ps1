function Resolve-InDesignTranslationLanguage {
    param([Parameter(Mandatory)] [string]$TargetLanguage)
    # Translation policy uses the generic language; Adobe requires its exact
    # dictionary name. Never fall back to an older or regional German variant.
    if ($TargetLanguage.Equals('German', [StringComparison]::OrdinalIgnoreCase)) {
        return 'German: 2006 Reform'
    }
    return $TargetLanguage
}

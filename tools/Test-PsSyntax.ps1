# Read-only PowerShell syntax check: parses each file with the PowerShell parser, never runs it.
# Usage: pwsh -NoProfile -File Test-PsSyntax.ps1 <file.ps1> [<file.ps1> ...]
# Exit codes: 0 all parsed, 1 a file has syntax errors, 2 no paths given or a file is missing.

if ($args.Count -eq 0) {
    Write-Output 'usage: Test-PsSyntax.ps1 <file.ps1> [<file.ps1> ...]'
    exit 2
}
$missing = @($args | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missing.Count) {
    $missing | ForEach-Object { Write-Output "MISSING $_" }
    exit 2
}

$failed = $false
foreach ($file in $args) {
    $tokens = $null
    $errors = $null
    # ParseFile resolves relative paths against the process directory, not the PowerShell location
    $full = (Resolve-Path -LiteralPath $file).ProviderPath
    [void][System.Management.Automation.Language.Parser]::ParseFile($full, [ref]$tokens, [ref]$errors)
    if ($errors.Count) {
        $failed = $true
        Write-Output "PARSE-FAIL $file"
        $errors | ForEach-Object { Write-Output "$($_.Extent.StartLineNumber): $($_.Message)" }
    } else {
        Write-Output "PARSE-OK $file tokens=$($tokens.Count)"
    }
}
if ($failed) { exit 1 }
exit 0

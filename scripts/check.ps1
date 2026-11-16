# Runs the project checks in Docker: format, typecheck, lint, test, build.
#   ./scripts/check.ps1            all of them
#   ./scripts/check.ps1 test lint  only the named ones
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Steps)
if (-not $Steps) { $Steps = @('format', 'typecheck', 'lint', 'test', 'build') }

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$failed = @()
foreach ($step in $Steps) {
  Write-Host "`n===== npm run $step" -ForegroundColor Cyan
  docker compose run --rm tools run $step 2>&1 |
    Where-Object { $_ -notmatch '^\s*(Volume|Network|Container|Image) ' } |
    ForEach-Object { "$_" } | Out-Host
  if ($LASTEXITCODE -ne 0) { $failed += $step }
}
if ($failed.Count) { Write-Host "`nFAILED: $($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host "`nAll passed." -ForegroundColor Green

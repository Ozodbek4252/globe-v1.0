# Runs the project checks in Docker: format, typecheck, lint, test, build.
#   ./scripts/check.ps1            all of them
#   ./scripts/check.ps1 test lint  only the named ones
# Prints one line per step; the full output only for a step that fails.
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Steps)
if (-not $Steps) { $Steps = @('format', 'typecheck', 'lint', 'test', 'build') }

$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
$failed = @()
foreach ($step in $Steps) {
  $out = docker compose run --rm tools run $step 2>&1 |
    Where-Object { $_ -notmatch '^\s*(Volume|Network|Container|Image) ' } |
    ForEach-Object { "$_" }
  if ($LASTEXITCODE -eq 0) {
    $summary = ($out | Where-Object { $_ -match 'Tests |built in|All matched|passed' } | Select-Object -Last 1)
    Write-Host ("PASS  {0,-10} {1}" -f $step, $summary) -ForegroundColor Green
  } else {
    Write-Host "FAIL  $step" -ForegroundColor Red
    $out | Out-Host
    $failed += $step
  }
}
if ($failed.Count) { exit 1 }

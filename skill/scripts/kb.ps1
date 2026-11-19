#!/usr/bin/env pwsh
# Run kb.py with the first Python that actually works on this machine.
# The Microsoft Store "python.exe" stub exists on PATH but fails at runtime,
# so candidates are probed instead of trusted.
#
# Arguments are taken from $args on purpose: a param() block would try to bind
# kb.py's own options (-n, --kb, --status) as PowerShell parameters.

$ErrorActionPreference = 'Stop'
$KbArgs = $args
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'kb.py'

$candidates = @()
if ($env:KB_PYTHON) { $candidates += $env:KB_PYTHON }
$candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe')
$candidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python312\python.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python311\python.exe'),
    'C:\Python312\python.exe'
)
$onPath = Get-Command python -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }

foreach ($cand in $candidates) {
    if (-not $cand -or -not (Test-Path $cand)) { continue }
    $probe = & $cand -c "import sys, sqlite3; print('ok')" 2>$null
    if ($probe -eq 'ok') {
        & $cand $script @KbArgs
        exit $LASTEXITCODE
    }
}

if (Get-Command py -ErrorAction SilentlyContinue) {
    & py -3 $script @KbArgs
    exit $LASTEXITCODE
}

Write-Error "kb.ps1: no working Python found. Set KB_PYTHON to a python.exe path."
exit 127

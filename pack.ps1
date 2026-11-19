# Build the portable DSH bundle into dist/.
#
# The actual work is done by tools/pack.mjs so the same command works on Windows,
# macOS and Linux; this wrapper only resolves a real Node (the Electron executable
# behind DSH_NODE_EXECUTABLE does not pass console output through).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtimeNode = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node -and (Test-Path $runtimeNode)) { $node = $runtimeNode }
if (-not $node) { throw 'Node.js is required to build the package (put node on PATH or install the DSH runtime).' }

& $node (Join-Path $root 'tools\pack.mjs')
exit $LASTEXITCODE

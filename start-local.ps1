param(
    [ValidateSet('start', 'stop', 'status', 'restart')][string]$Action = 'start',
    [string]$AppPath,
    [string]$DataRoot,
    [switch]$StopContainer
)
$ErrorActionPreference = 'Stop'
$nodePath = Join-Path $PSScriptRoot 'Grok Bot.exe'
$useElectron = Test-Path -LiteralPath $nodePath -PathType Leaf
if (-not $useElectron) {
    $nodePath = (Get-Command node -ErrorAction Stop).Source
}
$arguments = @((Join-Path $PSScriptRoot 'scripts/windows-local-launch.mjs'), $Action)
if ($AppPath) { $arguments += @('--app-path', $AppPath) }
if ($DataRoot) { $arguments += @('--data-root', $DataRoot) }
if ($StopContainer) { $arguments += '--stop-container' }
$savedNodeMode = $env:ELECTRON_RUN_AS_NODE
$result = 1
try {
    if ($useElectron) { $env:ELECTRON_RUN_AS_NODE = '1' }
    & $nodePath @arguments
    $result = $LASTEXITCODE
} finally {
    $env:ELECTRON_RUN_AS_NODE = $savedNodeMode
}
exit $result
